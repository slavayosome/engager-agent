import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_V1_TOOL_NAMES,
  RUNNER_V2_TOOL_NAMES,
} from "@engager/runner-contract";
import {
  EngagerMcp,
  type RunnerMcpSession,
  type RunnerMcpSessionFactory,
} from "./mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function session(
  tools: readonly string[],
  handler: (name: string, args: Record<string, unknown>) => unknown,
): RunnerMcpSession {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: tools.map((name) => ({ name })) })),
    callTool: vi.fn(async ({ name, arguments: args }) => handler(name, args)),
  };
}

const heartbeat = {
  runnerId: "runner-test",
  state: "preflight" as const,
  version: "0.9.0",
  supportedVersion: { major: 2, minor: 1 },
  engine: "claude" as const,
};

describe("MCP least-privilege negotiation", () => {
  it("contains no source path that registers runner credentials into interactive agents", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = ["register.ts", "cli.ts", "wizard.ts"]
      .map((name) => readFileSync(join(root, "src", name), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/mcp\s+add|mcp-remote|Authorization:\s*Bearer\s*\$\{apiKey\}/);
  });
  it("heartbeats on bootstrap, closes it, and reconnects to the exact v2 surface", async () => {
    const bootstrap = session(RUNNER_V1_TOOL_NAMES, (name) => {
      expect(name).toBe("report_runner_status");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contractVersion: 2,
              serverSupportedVersion: { major: 2, minor: 1 },
              directive: "run",
              reason: "ok",
              workOrder: null,
            }),
          },
        ],
      };
    });
    const leased = session(RUNNER_V2_TOOL_NAMES, () => ({ content: [] }));
    const sessions = [bootstrap, leased];
    const factory: RunnerMcpSessionFactory = () => sessions.shift()!;
    const mcp = new EngagerMcp("https://engager.test/mcp", "runner-secret", "0.9.0", factory);
    const result = await mcp.negotiate(heartbeat);
    expect(result.protocol).toBe("2.1");
    expect(mcp.surface).toBe("v2");
    expect(bootstrap.close).toHaveBeenCalledOnce();
    expect(leased.connect).toHaveBeenCalledOnce();
  });

  it("keeps a strict untagged v1 directive on the compatibility surface", async () => {
    const legacy = session(RUNNER_V1_TOOL_NAMES, () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            directive: "idle",
            reason: "legacy campaign paused",
            workOrder: null,
            intervalMinutes: 60,
            intervalMinutesBase: 60,
            runner: {},
          }),
        },
      ],
    }));
    const mcp = new EngagerMcp("https://engager.test/mcp", "runner-secret", "0.9.0", () => legacy);
    expect((await mcp.negotiate(heartbeat)).protocol).toBe("v1");
    expect(legacy.connect).toHaveBeenCalledOnce();
  });

  it("parses MCP isError JSON into stable lease failure without leaking the key", async () => {
    const leased = session(RUNNER_V2_TOOL_NAMES, (name) => {
      expect(name).toBe("claim_runner_work");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contractVersion: 2,
              error: "lease expired",
              code: "lease_expired",
              status: 409,
              recovery: "wait for requeue",
            }),
          },
        ],
      };
    });
    const mcp = new EngagerMcp("https://engager.test/mcp", "super-secret-runner-key", "0.9.0", () => leased);
    await mcp.connect();
    await expect(
      mcp.claim({
        contractVersion: 2,
        runnerId: "runner-test",
        supportedVersion: { major: 2, minor: 1 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        typeof error === "object" &&
        error != null &&
        (error as { code?: string }).code === "LEASE_LOST" &&
        !String((error as Error).message).includes("super-secret-runner-key"),
    );
  });

  it("redacts API and lease credentials echoed by a structured remote error", async () => {
    const apiKey = "super-secret-runner-key";
    const leaseToken = "lease-token-0123456789abcdef";
    const leased = session(RUNNER_V2_TOOL_NAMES, (_name, args) => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            contractVersion: 2,
            error: `invalid ${args.leaseToken} for Bearer ${apiKey}`,
            code: "invalid_lease",
            status: 409,
            recovery: `replace ${apiKey} and ${args.leaseToken}`,
            reference: String(args.leaseToken),
          }),
        },
      ],
    }));
    const mcp = new EngagerMcp("https://engager.test/mcp", apiKey, "0.9.0", () => leased);
    await mcp.connect();
    let caught: unknown;
    try {
      await mcp.renewLease({
        contractVersion: 2,
        workOrderId: "11111111-1111-4111-8111-111111111111",
        leaseToken,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LEASE_LOST" });
    const fault = caught as Error & { recovery: string; reference: string };
    for (const value of [fault.message, fault.recovery, fault.reference]) {
      expect(value).not.toContain(apiKey);
      expect(value).not.toContain(leaseToken);
    }
  });

  it("redacts request credentials echoed by an MCP transport failure", async () => {
    const apiKey = "transport-secret-runner-key";
    const leaseToken = "lease-token-transport-0123456789";
    const leased = session(RUNNER_V2_TOOL_NAMES, () => {
      throw new Error(`request\n[FORGED]\u009b31m Bearer ${apiKey} carried ${leaseToken}\u202e`);
    });
    const mcp = new EngagerMcp("https://engager.test/mcp", apiKey, "0.9.0", () => leased);
    await mcp.connect();
    await expect(
      mcp.renewLease({
        contractVersion: 2,
        workOrderId: "11111111-1111-4111-8111-111111111111",
        leaseToken,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes(apiKey) &&
        !error.message.includes(leaseToken) &&
        !/[\n\r\u009b\u202e]/.test(error.message),
    );
  });

  it("treats subscription cancellation as lease loss instead of a hard-halt failure", async () => {
    const leased = session(RUNNER_V2_TOOL_NAMES, () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            contractVersion: 2,
            error: "subscription is inactive",
            code: "subscription_inactive",
            status: 402,
            recovery: "return to control polling",
          }),
        },
      ],
    }));
    const mcp = new EngagerMcp("https://engager.test/mcp", "runner-secret", "0.9.0", () => leased);
    await mcp.connect();
    await expect(
      mcp.renewLease({
        contractVersion: 2,
        workOrderId: "11111111-1111-4111-8111-111111111111",
        leaseToken: "lease-token-0123456789abcdef",
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST", remoteCode: "subscription_inactive" });
  });

  it("rejects a substituted credential surface before any operation", async () => {
    const broad = session([...RUNNER_V2_TOOL_NAMES, "list_campaigns"], () => ({ content: [] }));
    const mcp = new EngagerMcp("https://engager.test/mcp", "runner-secret", "0.9.0", () => broad);
    await expect(mcp.connect()).rejects.toThrow(/surface mismatch/);
    expect(broad.callTool).not.toHaveBeenCalled();
  });
});
