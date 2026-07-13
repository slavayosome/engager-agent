import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configPath,
  engineConfigDirFromEnvironment,
  finalizeAcknowledgedDeviceConfig,
  loadConfig,
  loadPartialConfig,
  savePartialConfig,
} from "./config.js";
import {
  acknowledgeDeviceGrant,
  deviceAuthUrl,
  isSafeApprovalUrl,
  openBrowser,
  pollForKey,
  startDeviceFlow,
  type DeviceStart,
} from "./deviceauth.js";

describe("deviceAuthUrl", () => {
  it("targets the MCP host's root, regardless of the /mcp path", () => {
    expect(deviceAuthUrl("https://mcp.example.com/mcp", "/device-auth/start")).toBe(
      "https://mcp.example.com/device-auth/start",
    );
    expect(deviceAuthUrl("http://localhost:8788/mcp", "/device-auth/poll")).toBe(
      "http://localhost:8788/device-auth/poll",
    );
  });

  it("rejects cleartext remote endpoints but permits loopback development", () => {
    expect(() => deviceAuthUrl("http://engager.example/mcp", "/device-auth/start")).toThrow(
      /requires HTTPS/,
    );
    expect(deviceAuthUrl("http://127.0.0.1:3000/mcp", "/device-auth/start")).toContain(
      "http://127.0.0.1:3000/device-auth/start",
    );
    expect(deviceAuthUrl("http://[::1]:3000/mcp", "/device-auth/start")).toContain(
      "http://[::1]:3000/device-auth/start",
    );
  });

  it("rejects endpoint URL credentials, query secrets, and fragments", () => {
    for (const endpoint of [
      "https://user:secret@engager.test/mcp",
      "https://engager.test/mcp?token=secret",
      "https://engager.test/mcp#secret",
    ]) {
      expect(() => deviceAuthUrl(endpoint, "/device-auth/start")).toThrow(/requires HTTPS/);
    }
  });

  it("accepts only the matching approval-code query on a safe browser URL", () => {
    expect(isSafeApprovalUrl("https://app.example/device?code=AAAA-BBBB", "AAAA-BBBB")).toBe(true);
    expect(isSafeApprovalUrl("http://127.0.0.1:3000/device?code=AAAA-BBBB", "AAAA-BBBB")).toBe(true);
    expect(isSafeApprovalUrl("https://app.example/device?code=WRONG", "AAAA-BBBB")).toBe(false);
    expect(isSafeApprovalUrl("https://app.example/device?code=AAAA-BBBB&next=evil", "AAAA-BBBB")).toBe(false);
    expect(isSafeApprovalUrl("https://user:secret@app.example/device?code=AAAA-BBBB", "AAAA-BBBB")).toBe(false);
  });

  it("falls back to the printed URL when a headless browser opener emits ENOENT", () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    openBrowser("https://engager.test/device-auth/verify", spawnProcess);
    expect(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))).not.toThrow();
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

describe("device flow against a scripted server", () => {
  let server: Server;
  let base = "";
  let responses: Array<{ status: number; body: unknown }> = [];
  const seen: Array<{ url: string; body: unknown }> = [];

  beforeEach(async () => {
    responses = [];
    seen.length = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        const next = responses.shift() ?? { status: 500, body: {} };
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });

  afterEach(() => server.close());

  const START: DeviceStart = {
    deviceCode: "engd_xxxxxxxx",
    userCode: "AAAA-BBBB",
    verificationUrl: "https://app/device?code=AAAA-BBBB",
    expiresAt: Date.now() + 60_000,
    intervalSec: 1,
    deliveryProtocol: 2,
  };
  const fastSleep = () => Promise.resolve();

  it("returns the grant and classifies unsupported servers without a broad-key fallback", async () => {
    responses = [{ status: 200, body: START }];
    const ok = await startDeviceFlow(base, "test-runner-1");
    expect(ok.userCode).toBe("AAAA-BBBB");
    expect(seen[0]).toEqual({
      url: "/device-auth/start",
      body: expect.objectContaining({
        credentialProfile: "runner",
        runnerId: "test-runner-1",
        deliveryProtocol: 2,
      }),
    });

    responses = [{ status: 501, body: { error: "not configured" } }];
    await expect(startDeviceFlow(base, "test-runner-1")).rejects.toMatchObject({
      code: "DEVICE_AUTH_UNSUPPORTED",
    });
    responses = [{ status: 404, body: { error: "not found" } }];
    await expect(startDeviceFlow(base, "test-runner-1")).rejects.toMatchObject({
      code: "DEVICE_AUTH_UNSUPPORTED",
    });
  });

  it("requires the server to echo the exact setup-proof purpose and project", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    responses = [
      {
        status: 200,
        body: {
          ...START,
          purpose: "runner_setup_proof",
          organizationId,
        },
      },
    ];
    await expect(
      startDeviceFlow(base, "setup-proof-runner", {
        setupProofOrganizationId: organizationId,
      }),
    ).resolves.toMatchObject({ purpose: "runner_setup_proof", organizationId });
    expect(seen[0]).toEqual({
      url: "/device-auth/start",
      body: expect.objectContaining({
        credentialProfile: "runner",
        runnerId: "setup-proof-runner",
        deliveryProtocol: 2,
        purpose: "runner_setup_proof",
        organizationId,
      }),
    });

    responses = [
      {
        status: 200,
        body: {
          ...START,
          purpose: "runner_setup_proof",
          organizationId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ];
    await expect(
      startDeviceFlow(base, "setup-proof-runner", {
        setupProofOrganizationId: organizationId,
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID_RESPONSE" });

    responses = [
      {
        status: 200,
        body: { ...START, purpose: "runner_setup_proof", organizationId },
      },
    ];
    await expect(startDeviceFlow(base, "general-runner")).rejects.toMatchObject({
      code: "DEVICE_AUTH_INVALID_RESPONSE",
    });
    await expect(
      startDeviceFlow(base, "setup-proof-runner", {
        setupProofOrganizationId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTH_REJECTED" });
    await expect(
      startDeviceFlow(base, "setup-proof-runner", {
        setupProofOrganizationId: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_AUTH_REJECTED" });
  });

  it("pollForKey claims a key after pending", async () => {
    const deliveryExpiresAt = Date.now() + 5 * 60_000;
    responses = [
      { status: 200, body: { status: "pending" } },
      {
        status: 200,
        body: {
          status: "approved",
          apiKey: "eng_minted_0123456789",
          ackToken: "engda_ack_0123456789",
          deliveryExpiresAt,
        },
      },
    ];
    const result = await pollForKey(base, START, { sleep: fastSleep });
    expect(result).toEqual({
      outcome: "approved",
      apiKey: "eng_minted_0123456789",
      deviceCode: START.deviceCode,
      ackToken: "engda_ack_0123456789",
      deliveryExpiresAt,
    });

    responses = [{ status: 200, body: { status: "acknowledged" } }];
    await expect(acknowledgeDeviceGrant(base, result as Extract<typeof result, { outcome: "approved" }>))
      .resolves.toBe("acknowledged");
    expect(seen.at(-1)).toEqual({
      url: "/device-auth/ack",
      body: { deviceCode: START.deviceCode, ackToken: "engda_ack_0123456789" },
    });
  });

  it("classifies a server outage instead of claiming device auth is unsupported", async () => {
    responses = [{ status: 500, body: {} }];
    expect(await pollForKey(base, START, { sleep: fastSleep })).toEqual({
      outcome: "error",
      note: "DEVICE_AUTH_SERVER_ERROR: approval service remained unavailable",
    });
  });

  it("retries a transient poll outage with the same device challenge", async () => {
    const deliveryExpiresAt = Date.now() + 5 * 60_000;
    responses = [
      { status: 500, body: {} },
      {
        status: 200,
        body: {
          status: "approved",
          apiKey: "eng_recovered_0123456789",
          ackToken: "engda_recovered_0123456789",
          deliveryExpiresAt,
        },
      },
    ];
    await expect(pollForKey(base, START, { sleep: fastSleep })).resolves.toEqual({
      outcome: "approved",
      apiKey: "eng_recovered_0123456789",
      deviceCode: START.deviceCode,
      ackToken: "engda_recovered_0123456789",
      deliveryExpiresAt,
    });
  });

  it("rejects a remote cleartext browser approval URL", async () => {
    responses = [{
      status: 200,
      body: { ...START, verificationUrl: "http://engager.example/device?code=AAAA-BBBB" },
    }];
    await expect(startDeviceFlow(base, "test-runner-1")).rejects.toMatchObject({
      code: "DEVICE_AUTH_INVALID_RESPONSE",
    });
  });

  it("pollForKey surfaces denied and expires at the TTL", async () => {
    responses = [{ status: 200, body: { status: "denied" } }];
    expect((await pollForKey(base, START, { sleep: fastSleep })).outcome).toBe("denied");

    const expired = await pollForKey(
      base,
      { ...START, expiresAt: Date.now() - 1 },
      { sleep: fastSleep },
    );
    expect(expired.outcome).toBe("expired");
  });
});

describe("partial config", () => {
  beforeEach(() => {
    process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-agent-test-"));
  });

  it("accepts an organization-level runner without a local campaign or cadence", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_k",
      credentialProfile: "runner",
      runnerId: "test-runner-1",
      cli: "claude",
      enginePath: "/opt/homebrew/bin/claude",
      model: "sonnet",
    });
    expect(loadConfig()).toMatchObject({
      configVersion: 2,
      runnerId: "test-runner-1",
      engine: "claude",
      enginePath: "/opt/homebrew/bin/claude",
    });
    expect(loadConfig()?.legacy).toBeUndefined();
    const partial = loadPartialConfig();
    expect(partial?.mcpUrl).toBe("https://m/mcp");
    expect(partial?.apiKey).toBe("eng_k");
  });

  it("persists only the selected provider config directory and rejects non-absolute state", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_k",
      credentialProfile: "runner",
      runnerId: "config-dir-runner",
      engine: "codex",
      enginePath: "/opt/homebrew/bin/codex",
      engineConfigDir: "/Users/test/private-codex-home",
    });
    expect(loadConfig()).toMatchObject({
      engine: "codex",
      engineConfigDir: "/Users/test/private-codex-home",
    });
    expect(
      engineConfigDirFromEnvironment("codex", {
        CODEX_HOME: "/Users/test/selected-codex",
        CLAUDE_CONFIG_DIR: "/Users/test/unrelated-claude",
        OPENAI_API_KEY: "must-not-be-persisted",
      }),
    ).toBe("/Users/test/selected-codex");

    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_k",
      credentialProfile: "runner",
      runnerId: "unsafe-config-dir-runner",
      engine: "codex",
      enginePath: "/opt/homebrew/bin/codex",
      engineConfigDir: "relative/codex-home",
    });
    expect(loadConfig()).toBeNull();
  });

  it("keeps old runner identity for setup but refuses work until an executable is pinned", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_k",
      credentialProfile: "runner",
      runnerId: "migrated-runner-1",
      cli: "claude",
    });
    expect(loadConfig()).toBeNull();
    expect(loadPartialConfig()).toMatchObject({
      runnerId: "migrated-runner-1",
      apiKey: "eng_k",
    });
  });

  it("fails work closed while a protocol-2 delivery ACK remains durable", () => {
    const pending = {
      configVersion: 2,
      mcpUrl: "https://m/mcp",
      apiKey: "eng_temporary_0123456789",
      credentialProfile: "runner",
      runnerId: "pending-runner",
      engine: "claude",
      enginePath: "/opt/homebrew/bin/claude",
      pendingSetupProofOrganizationId:
        "11111111-1111-4111-8111-111111111111",
      pendingDeviceAck: {
        deviceCode: "engd_pending_0123456789",
        ackToken: "engda_pending_0123456789",
        deliveryExpiresAt: Date.now() + 60_000,
      },
    } as const;
    savePartialConfig(pending);
    expect(loadConfig()).toBeNull();
    expect(loadPartialConfig()?.pendingDeviceAck).toMatchObject({
      deviceCode: "engd_pending_0123456789",
    });
    expect(finalizeAcknowledgedDeviceConfig(pending)).toMatchObject({
      pendingSetupProofOrganizationId:
        "11111111-1111-4111-8111-111111111111",
    });
    expect(loadConfig()).toMatchObject({
      apiKey: "eng_temporary_0123456789",
      pendingSetupProofOrganizationId:
        "11111111-1111-4111-8111-111111111111",
    });
    expect(loadPartialConfig()?.pendingDeviceAck).toBeUndefined();
  });

  it("refuses to use a group-readable key while preserving non-secret setup identity", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_private",
      credentialProfile: "runner",
      runnerId: "permissions-runner",
      engine: "claude",
      enginePath: "/opt/homebrew/bin/claude",
    });
    chmodSync(configPath(), 0o644);
    expect(loadConfig()).toBeNull();
    expect(loadPartialConfig()).toMatchObject({ runnerId: "permissions-runner" });
    expect(loadPartialConfig()?.apiKey).toBeUndefined();
  });

  it("refuses a complete legacy config until it receives a runner-profile credential", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_legacy",
      cli: "claude",
      model: "sonnet",
      campaignId: 7,
      intervalMinutes: 60,
      maxTurns: 80,
      dailySessionCap: 24,
    });
    expect(loadConfig()).toBeNull();
  });
});
