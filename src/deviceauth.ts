import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { z } from "zod";
import {
  isSafeMcpUrl,
  isValidSetupProofOrganizationId,
} from "./config.js";
import { readBoundedJson } from "./http.js";

/**
 * Client side of the server's device-authorization flow: ask the MCP host for
 * a short code, send the user's browser to the dashboard approval page, poll
 * until a freshly minted API key comes back. No key ever gets copy-pasted.
 * Failures are classified so an outage is never misdiagnosed as missing server
 * support (and never sends the user toward a broad pasted key).
 */

type DeviceStartBase = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalSec: number;
  deliveryProtocol: 2;
};

export type DeviceStart =
  | (DeviceStartBase & { purpose?: never; organizationId?: never })
  | (DeviceStartBase & {
      purpose: "runner_setup_proof";
      organizationId: string;
    });

export type DeviceApprovedGrant = {
  apiKey: string;
  deviceCode: string;
  ackToken: string;
  deliveryExpiresAt: number;
};

export type DeviceAuthErrorCode =
  | "DEVICE_AUTH_UNSUPPORTED"
  | "DEVICE_AUTH_REJECTED"
  | "DEVICE_AUTH_RATE_LIMITED"
  | "DEVICE_AUTH_SERVER_ERROR"
  | "DEVICE_AUTH_TIMEOUT"
  | "DEVICE_AUTH_NETWORK"
  | "DEVICE_AUTH_INVALID_RESPONSE";

export class DeviceAuthError extends Error {
  constructor(readonly code: DeviceAuthErrorCode, message: string) {
    super(message);
    this.name = "DeviceAuthError";
  }
}

const DeviceStartResponseSchema = z
  .object({
    deviceCode: z.string().min(8).max(512),
    userCode: z.string().regex(/^[A-Za-z0-9-]{4,32}$/),
    verificationUrl: z.string().url(),
    expiresAt: z.number().int().nonnegative().optional(),
    intervalSec: z.number().int().min(1).max(60).optional(),
    deliveryProtocol: z.literal(2),
    purpose: z.literal("runner_setup_proof").optional(),
    organizationId: z.string().uuid().optional(),
  })
  .strict();

export { isValidSetupProofOrganizationId } from "./config.js";

const DevicePollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "denied", "expired", "not_found"]) }).strict(),
  z
    .object({
      status: z.literal("approved"),
      apiKey: z.string().min(16).max(1_000),
      ackToken: z.string().min(16).max(1_000),
      deliveryExpiresAt: z.number().int().positive(),
    })
    .strict(),
]);

const DeviceAckResponseSchema = z
  .object({ status: z.enum(["acknowledged", "expired", "not_found"]) })
  .strict();

/** The device-auth routes live at the MCP host's root, not under /mcp. */
export function deviceAuthUrl(mcpUrl: string, path: string): string {
  if (!isSafeMcpUrl(mcpUrl)) {
    throw new DeviceAuthError(
      "DEVICE_AUTH_REJECTED",
      "device authorization requires HTTPS (HTTP is allowed only for localhost development)",
    );
  }
  return new URL(path, mcpUrl).toString();
}

/** Approval pages legitimately carry the short user code in their query. MCP
 * endpoints do not, so this must not reuse the stricter endpoint validator. */
export function isSafeApprovalUrl(value: string, userCode: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== "code" || entries[0]?.[1] !== userCode) {
      return false;
    }
    const transport = new URL(url);
    transport.search = "";
    return isSafeMcpUrl(transport.toString());
  } catch {
    return false;
  }
}

export async function startDeviceFlow(
  mcpUrl: string,
  runnerId: string,
  opts: { setupProofOrganizationId?: string } = {},
): Promise<DeviceStart> {
  if (
    opts.setupProofOrganizationId !== undefined &&
    !isValidSetupProofOrganizationId(opts.setupProofOrganizationId)
  ) {
    throw new DeviceAuthError(
      "DEVICE_AUTH_REJECTED",
      "setup-proof authorization requires a valid Engager project UUID",
    );
  }
  try {
    const res = await fetch(deviceAuthUrl(mcpUrl, "/device-auth/start"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: `engager-agent on ${hostname().split(".")[0]}`,
        credentialProfile: "runner",
        runnerId,
        deliveryProtocol: 2,
        ...(opts.setupProofOrganizationId
          ? {
              purpose: "runner_setup_proof",
              organizationId: opts.setupProofOrganizationId,
            }
          : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw startHttpError(res.status);
    let responseBody: unknown;
    try {
      responseBody = await readBoundedJson(res);
    } catch (error) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        `the endpoint returned an unreadable device authorization challenge: ${safeReadError(error)}`,
      );
    }
    const parsed = DeviceStartResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        "the endpoint returned an invalid device authorization challenge",
      );
    }
    const body = parsed.data;
    if (opts.setupProofOrganizationId) {
      if (
        body.purpose !== "runner_setup_proof" ||
        body.organizationId !== opts.setupProofOrganizationId
      ) {
        throw new DeviceAuthError(
          "DEVICE_AUTH_INVALID_RESPONSE",
          "the endpoint did not preserve the requested setup-proof project binding",
        );
      }
    } else if (body.purpose !== undefined || body.organizationId !== undefined) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        "the endpoint returned unexpected renewal-authorizing device authority",
      );
    }
    const now = Date.now();
    const expiresAt = body.expiresAt ?? now + 15 * 60_000;
    if (expiresAt <= now || expiresAt > now + 30 * 60_000) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        "the endpoint returned a device challenge outside the bounded 30-minute lifetime",
      );
    }
    let verification: URL;
    try {
      verification = new URL(body.verificationUrl);
    } catch {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        "the endpoint returned an invalid browser approval URL",
      );
    }
    if (!isSafeApprovalUrl(verification.toString(), body.userCode)) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        "the browser approval URL must use HTTPS (or loopback HTTP) and carry only the matching short code",
      );
    }
    const start: DeviceStartBase = {
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      verificationUrl: verification.toString(),
      expiresAt,
      intervalSec: body.intervalSec ?? 5,
      deliveryProtocol: 2,
    };
    return opts.setupProofOrganizationId
      ? {
          ...start,
          purpose: "runner_setup_proof",
          organizationId: opts.setupProofOrganizationId,
        }
      : start;
  } catch (error) {
    if (error instanceof DeviceAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|aborted/i.test(message)) {
      throw new DeviceAuthError("DEVICE_AUTH_TIMEOUT", "device authorization timed out");
    }
    throw new DeviceAuthError(
      "DEVICE_AUTH_NETWORK",
      "device authorization could not reach the Engager endpoint (check DNS, TLS, URL, and network)",
    );
  }
}

export type DevicePollOutcome =
  | ({ outcome: "approved" } & DeviceApprovedGrant)
  | { outcome: "denied" | "expired" | "error"; note: string };

/** Poll until the request resolves (approved/denied) or its TTL runs out. */
export async function pollForKey(
  mcpUrl: string,
  start: DeviceStart,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DevicePollOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let consecutiveNetworkFailures = 0;
  while (Date.now() < start.expiresAt) {
    await sleep(Math.max(1000, start.intervalSec * 1000));
    let status = "";
    let grant: DeviceApprovedGrant | undefined;
    try {
      const res = await fetch(deviceAuthUrl(mcpUrl, "/device-auth/poll"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          consecutiveNetworkFailures += 1;
          if (consecutiveNetworkFailures >= 6) {
            return { outcome: "error", note: "DEVICE_AUTH_RATE_LIMITED: approval polling remained rate limited" };
          }
          continue;
        }
        if (res.status >= 500) {
          consecutiveNetworkFailures += 1;
          if (consecutiveNetworkFailures >= 6) {
            return { outcome: "error", note: "DEVICE_AUTH_SERVER_ERROR: approval service remained unavailable" };
          }
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          return { outcome: "error", note: "DEVICE_AUTH_REJECTED: approval request was rejected" };
        }
        return { outcome: "error", note: `DEVICE_AUTH_INVALID_RESPONSE: polling returned HTTP ${res.status}` };
      }
      let responseBody: unknown;
      try {
        responseBody = await readBoundedJson(res);
      } catch (error) {
        return {
          outcome: "error",
          note: `DEVICE_AUTH_INVALID_RESPONSE: polling returned unreadable data (${safeReadError(error)})`,
        };
      }
      const parsed = DevicePollResponseSchema.safeParse(responseBody);
      if (!parsed.success) {
        return { outcome: "error", note: "DEVICE_AUTH_INVALID_RESPONSE: polling returned malformed data" };
      }
      status = parsed.data.status;
      if (parsed.data.status === "approved") {
        if (
          parsed.data.deliveryExpiresAt <= Date.now() ||
          parsed.data.deliveryExpiresAt > Date.now() + 30 * 60_000
        ) {
          return {
            outcome: "error",
            note: "DEVICE_AUTH_INVALID_RESPONSE: credential delivery lifetime is outside the 30-minute bound",
          };
        }
        grant = {
          apiKey: parsed.data.apiKey,
          deviceCode: start.deviceCode,
          ackToken: parsed.data.ackToken,
          deliveryExpiresAt: parsed.data.deliveryExpiresAt,
        };
      }
      consecutiveNetworkFailures = 0;
    } catch (error) {
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures >= 3) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: "error",
          note: /timeout|aborted/i.test(message)
            ? "DEVICE_AUTH_TIMEOUT: approval polling timed out three times"
            : "DEVICE_AUTH_NETWORK: approval polling lost network connectivity",
        };
      }
      continue;
    }
    if (status === "approved" && grant) return { outcome: "approved", ...grant };
    if (status === "denied") return { outcome: "denied", note: "the request was denied" };
    if (status === "expired") return { outcome: "expired", note: "the code expired" };
    if (status === "not_found") {
      return { outcome: "error", note: "the request vanished server-side — try again" };
    }
    // pending → keep going
  }
  return { outcome: "expired", note: "the code expired before it was approved" };
}

export async function acknowledgeDeviceGrant(
  mcpUrl: string,
  grant: Pick<DeviceApprovedGrant, "deviceCode" | "ackToken">,
): Promise<"acknowledged" | "expired" | "not_found"> {
  try {
    const res = await fetch(deviceAuthUrl(mcpUrl, "/device-auth/ack"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: grant.deviceCode, ackToken: grant.ackToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      throw new DeviceAuthError("DEVICE_AUTH_RATE_LIMITED", "device authorization ACK is rate limited");
    }
    if (res.status >= 500) {
      throw new DeviceAuthError("DEVICE_AUTH_SERVER_ERROR", "device authorization ACK service is unavailable");
    }
    if (!res.ok) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        `device authorization ACK returned HTTP ${res.status}`,
      );
    }
    let body: unknown;
    try {
      body = await readBoundedJson(res);
    } catch (error) {
      throw new DeviceAuthError(
        "DEVICE_AUTH_INVALID_RESPONSE",
        `device authorization ACK returned unreadable data: ${safeReadError(error)}`,
      );
    }
    const parsed = DeviceAckResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DeviceAuthError("DEVICE_AUTH_INVALID_RESPONSE", "device authorization ACK was malformed");
    }
    return parsed.data.status;
  } catch (error) {
    if (error instanceof DeviceAuthError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DeviceAuthError(
      /timeout|aborted/i.test(message) ? "DEVICE_AUTH_TIMEOUT" : "DEVICE_AUTH_NETWORK",
      /timeout|aborted/i.test(message)
        ? "device authorization ACK timed out"
        : "device authorization ACK could not reach Engager",
    );
  }
}

function startHttpError(status: number): DeviceAuthError {
  if (status === 404 || status === 405 || status === 501) {
    return new DeviceAuthError(
      "DEVICE_AUTH_UNSUPPORTED",
      "this Engager server does not expose least-privilege runner device authorization",
    );
  }
  if (status === 401 || status === 403) {
    return new DeviceAuthError("DEVICE_AUTH_REJECTED", "the device authorization request was rejected");
  }
  if (status === 429) {
    return new DeviceAuthError("DEVICE_AUTH_RATE_LIMITED", "device authorization is rate limited; retry later");
  }
  if (status >= 500) {
    return new DeviceAuthError("DEVICE_AUTH_SERVER_ERROR", "the device authorization service is unavailable");
  }
  return new DeviceAuthError(
    "DEVICE_AUTH_INVALID_RESPONSE",
    `device authorization returned unexpected HTTP ${status}`,
  );
}

function safeReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid body";
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);
}

/** Best-effort browser open; the URL is always ALSO printed for remote shells. */
export function openBrowser(url: string, spawnProcess: typeof spawn = spawn): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnProcess(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", () => {
      /* the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* the printed URL is the fallback */
  }
}
