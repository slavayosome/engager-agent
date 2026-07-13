import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  providerSessionsToday,
  reserveProviderSession,
  sessionUsagePath,
} from "./session-usage.js";

const NOW = Date.UTC(2026, 6, 11, 9, 0, 0);
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-session-usage-test-"));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

describe("crash-safe provider session usage", () => {
  it("persists a pre-spawn debit exactly once across restart-style rereads", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(reserveProviderSession(first, NOW)).toBe(1);
    expect(reserveProviderSession(first, NOW)).toBe(1);
    expect(providerSessionsToday(NOW)).toBe(1);
    expect(reserveProviderSession(second, NOW)).toBe(2);
    expect(providerSessionsToday(NOW)).toBe(2);
    expect(statSync(sessionUsagePath()).mode & 0o777).toBe(0o600);
    expect(providerSessionsToday(NOW + 86_400_000)).toBe(0);
  });

  it("fails closed rather than resetting a corrupt or public ledger to zero", () => {
    writeFileSync(sessionUsagePath(), "{}", { mode: 0o600 });
    expect(() => providerSessionsToday(NOW)).toThrow(/corrupt or unsafe/);
    writeFileSync(
      sessionUsagePath(),
      JSON.stringify({ schemaVersion: 1, day: "2026-07-11", attemptIds: [] }),
      { mode: 0o644 },
    );
    chmodSync(sessionUsagePath(), 0o644);
    expect(() => providerSessionsToday(NOW)).toThrow(/corrupt or unsafe/);
  });
});
