import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logEvent } from "./log.js";
import { configPath } from "./config.js";

let priorHome: string | undefined;
let home: string;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  home = mkdtempSync(join(tmpdir(), "engager-event-log-test-"));
  process.env.ENGAGER_AGENT_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

describe("structured runner events", () => {
  it("writes typed private JSONL with bounded redacted untrusted fields", () => {
    const device = `engrd_${"a".repeat(43)}`;
    const ack = `engra_${"b".repeat(43)}`;
    logEvent({
      event: "disconnect.transition",
      level: "error",
      code: "DISCONNECT_PROTOCOL_ERROR",
      phase: "pending\nforged",
      detail: `Bearer secret-bearer token=other-secret ${device} ${ack} ${"x".repeat(900)}`,
    });
    const file = readdirSync(join(home, "logs")).find((name) => name.endsWith(".jsonl"))!;
    const path = join(home, "logs", file);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      event: "disconnect.transition",
      level: "error",
      code: "DISCONNECT_PROTOCOL_ERROR",
      phase: "pending forged",
    });
    expect(parsed.detail.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(parsed)).not.toContain("secret-bearer");
    expect(JSON.stringify(parsed)).not.toContain("other-secret");
    expect(JSON.stringify(parsed)).not.toContain(device);
    expect(JSON.stringify(parsed)).not.toContain(ack);
  });

  it.each([0o600, 0o644])("never masks the original fault when agent.json is malformed at mode %s", (mode) => {
    writeFileSync(configPath(), "not-json\n", { mode: 0o600 });
    chmodSync(configPath(), mode);
    expect(() => logEvent({
      event: "cli.fault",
      level: "error",
      code: "RUNNER_NOT_CONFIGURED",
      detail: "original diagnostic",
    })).not.toThrow();
    const file = readdirSync(join(home, "logs")).find((name) => name.endsWith(".jsonl"));
    expect(file).toBeTruthy();
  });

  it("redacts pending-delivery authority and every Engager token namespace", () => {
    const apiKey = "custom-pending-runner-secret";
    const deviceCode = `engd_${"d".repeat(43)}`;
    const ackToken = `engda_${"a".repeat(43)}`;
    const tokens = [
      `eng_live_${"l".repeat(32)}`,
      deviceCode,
      ackToken,
      `engrd_${"r".repeat(43)}`,
      `engra_${"q".repeat(43)}`,
    ];
    writeFileSync(configPath(), `${JSON.stringify({
      apiKey,
      pendingDeviceAck: { deviceCode, ackToken, deliveryExpiresAt: Date.now() + 60_000 },
    })}\n`, { mode: 0o600 });
    logEvent({
      event: "cli.fault",
      level: "error",
      code: "INTERNAL_ERROR",
      detail: [apiKey, ...tokens].join(" "),
    });
    const file = readdirSync(join(home, "logs")).find((name) => name.endsWith(".jsonl"))!;
    const rendered = readFileSync(join(home, "logs", file), "utf8");
    expect(rendered).not.toContain(apiKey);
    for (const token of tokens) expect(rendered).not.toContain(token);
  });
});
