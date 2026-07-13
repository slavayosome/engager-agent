import { spawn } from "node:child_process";
import { hostname } from "node:os";

/**
 * Client side of the server's device-authorization flow: ask the MCP host for
 * a short code, send the user's browser to the dashboard approval page, poll
 * until a freshly minted API key comes back. No key ever gets copy-pasted.
 * Servers without the profile-aware endpoints return null from start; callers
 * fail closed and require a server upgrade instead of accepting a broad key.
 */

export type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalSec: number;
};

/** The device-auth routes live at the MCP host's root, not under /mcp. */
export function deviceAuthUrl(mcpUrl: string, path: string): string {
  return new URL(path, mcpUrl).toString();
}

export async function startDeviceFlow(
  mcpUrl: string,
  runnerId: string,
): Promise<DeviceStart | null> {
  try {
    const res = await fetch(deviceAuthUrl(mcpUrl, "/device-auth/start"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: `engager-agent on ${hostname().split(".")[0]}`,
        credentialProfile: "runner",
        runnerId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null; // old/unconfigured server cannot prove runner least privilege
    const body = (await res.json()) as Partial<DeviceStart>;
    if (!body.deviceCode || !body.userCode || !body.verificationUrl) return null;
    return {
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      verificationUrl: body.verificationUrl,
      expiresAt: body.expiresAt ?? Date.now() + 15 * 60_000,
      intervalSec: body.intervalSec ?? 5,
    };
  } catch {
    return null;
  }
}

export type DevicePollOutcome =
  | { outcome: "approved"; apiKey: string }
  | { outcome: "denied" | "expired" | "error"; note: string };

/** Poll until the request resolves (approved/denied) or its TTL runs out. */
export async function pollForKey(
  mcpUrl: string,
  start: DeviceStart,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DevicePollOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (Date.now() < start.expiresAt) {
    await sleep(Math.max(1000, start.intervalSec * 1000));
    let status = "";
    let apiKey: string | undefined;
    try {
      const res = await fetch(deviceAuthUrl(mcpUrl, "/device-auth/poll"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { status?: string; apiKey?: string };
      status = body.status ?? "";
      apiKey = body.apiKey;
    } catch {
      continue; // transient network blip — keep polling until the TTL
    }
    if (status === "approved" && apiKey) return { outcome: "approved", apiKey };
    if (status === "denied") return { outcome: "denied", note: "the request was denied" };
    if (status === "expired") return { outcome: "expired", note: "the code expired" };
    if (status === "not_found") {
      return { outcome: "error", note: "the request vanished server-side — try again" };
    }
    // pending → keep going
  }
  return { outcome: "expired", note: "the code expired before it was approved" };
}

/** Best-effort browser open; the URL is always ALSO printed for remote shells. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}
