import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadPartialConfig, savePartialConfig } from "./config.js";
import { deviceAuthUrl, pollForKey, startDeviceFlow, type DeviceStart } from "./deviceauth.js";

describe("deviceAuthUrl", () => {
  it("targets the MCP host's root, regardless of the /mcp path", () => {
    expect(deviceAuthUrl("https://mcp.example.com/mcp", "/device-auth/start")).toBe(
      "https://mcp.example.com/device-auth/start",
    );
    expect(deviceAuthUrl("http://localhost:8788/mcp", "/device-auth/poll")).toBe(
      "http://localhost:8788/device-auth/poll",
    );
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
    deviceCode: "engd_x",
    userCode: "AAAA-BBBB",
    verificationUrl: "https://app/device?code=AAAA-BBBB",
    expiresAt: Date.now() + 60_000,
    intervalSec: 1,
  };
  const fastSleep = () => Promise.resolve();

  it("startDeviceFlow returns the grant, or null on 404/501 (fallback to paste)", async () => {
    responses = [{ status: 200, body: START }];
    const ok = await startDeviceFlow(base, "test-runner-1");
    expect(ok?.userCode).toBe("AAAA-BBBB");
    expect(seen[0]).toEqual({
      url: "/device-auth/start",
      body: expect.objectContaining({
        credentialProfile: "runner",
        runnerId: "test-runner-1",
      }),
    });

    responses = [{ status: 501, body: { error: "not configured" } }];
    expect(await startDeviceFlow(base, "test-runner-1")).toBeNull();
    responses = [{ status: 404, body: { error: "not found" } }];
    expect(await startDeviceFlow(base, "test-runner-1")).toBeNull();
  });

  it("pollForKey rides out pending + transient errors, then claims the key", async () => {
    responses = [
      { status: 200, body: { status: "pending" } },
      { status: 500, body: {} }, // transient — keep polling
      { status: 200, body: { status: "approved", apiKey: "eng_minted" } },
    ];
    const result = await pollForKey(base, START, { sleep: fastSleep });
    expect(result).toEqual({ outcome: "approved", apiKey: "eng_minted" });
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

  it("saves a campaign-less connection that loadConfig rejects but the wizard can seed from", () => {
    savePartialConfig({
      mcpUrl: "https://m/mcp",
      apiKey: "eng_k",
      credentialProfile: "runner",
      runnerId: "test-runner-1",
      cli: "claude",
      model: "sonnet",
    });
    expect(loadConfig()).toBeNull(); // incomplete — the loop must not start
    const partial = loadPartialConfig();
    expect(partial?.mcpUrl).toBe("https://m/mcp");
    expect(partial?.apiKey).toBe("eng_k");
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
