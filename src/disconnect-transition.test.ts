import { chmodSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDisconnectTransition,
  credentialFingerprint,
  disconnectTransitionPath,
  disconnectReceiptPath,
  readSanitizedDisconnectReceipt,
  readDisconnectTransition,
  writeDisconnectTransition,
} from "./disconnect-transition.js";

let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-disconnect-transition-"));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

describe("disconnect transition journal", () => {
  it("persists a strict private pre-start fence without the bearer", () => {
    writeDisconnectTransition({
      schemaVersion: 1,
      protocolVersion: 1,
      phase: "prepared",
      createdAt: 1,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      mcpUrl: "https://engager.test/mcp",
      runnerId: "runner-disconnect",
      credentialFingerprint: credentialFingerprint("runner-secret-value"),
      priorService: { supported: true, installed: true, entryExists: true, loaded: true, disabled: false },
    });
    expect(lstatSync(disconnectTransitionPath()).mode & 0o777).toBe(0o600);
    const stored = readDisconnectTransition();
    expect(stored?.phase).toBe("prepared");
    expect(JSON.stringify(stored)).not.toContain("runner-secret-value");
  });

  it("fails closed on unsafe permissions and malformed phase authority", () => {
    writeDisconnectTransition({
      schemaVersion: 1,
      protocolVersion: 1,
      phase: "prepared",
      createdAt: 1,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      mcpUrl: "https://engager.test/mcp",
      runnerId: "runner-disconnect",
      credentialFingerprint: credentialFingerprint("runner-secret-value"),
      priorService: { supported: false, installed: false, entryExists: false, loaded: false, disabled: null },
    });
    chmodSync(disconnectTransitionPath(), 0o644);
    expect(() => readDisconnectTransition()).toThrow("private 0600");
    chmodSync(disconnectTransitionPath(), 0o600);
    clearDisconnectTransition();
    writeFileSync(disconnectTransitionPath(), JSON.stringify({ schemaVersion: 1, phase: "approved" }), { mode: 0o600 });
    expect(() => readDisconnectTransition()).toThrow();
  });

  it("refuses a loaded prior service that cannot be restored exactly", () => {
    expect(() => writeDisconnectTransition({
      schemaVersion: 1,
      protocolVersion: 1,
      phase: "prepared",
      createdAt: 1,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      mcpUrl: "https://engager.test/mcp",
      runnerId: "runner-disconnect",
      credentialFingerprint: credentialFingerprint("runner-secret-value"),
      priorService: {
        supported: true,
        installed: true,
        entryExists: true,
        loaded: true,
        disabled: null,
      },
    })).toThrow("loaded prior service is inconsistent");
  });

  it("refuses an unsafe sanitized completion receipt", () => {
    writeFileSync(disconnectReceiptPath(), "{}\n", { mode: 0o644 });
    expect(() => readSanitizedDisconnectReceipt()).toThrow("private 0600");
  });

  it("removes a dangling transition symlink instead of treating it as absent", () => {
    symlinkSync(join(process.env.ENGAGER_AGENT_HOME!, "missing-transition"), disconnectTransitionPath());
    clearDisconnectTransition();
    expect(() => lstatSync(disconnectTransitionPath())).toThrow();
  });
});
