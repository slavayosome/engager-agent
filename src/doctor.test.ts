import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerWorkOrderSchema } from "@engager/runner-contract";
import type { AgentConfig } from "./config.js";
import { diagnoseRecoveryJournal, runDoctor } from "./doctor.js";
import {
  JOURNAL_EXPIRY_SKEW_MS,
  journalPath,
  startJournal,
} from "./journal.js";
import { sessionUsagePath } from "./session-usage.js";

const NOW = Date.UTC(2026, 6, 11, 9, 0, 0);
const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "original-runner-secret",
  credentialProfile: "runner",
  runnerId: "runner-doctor-test",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};
const workOrder = RunnerWorkOrderSchema.parse({
  contractVersion: 2,
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: 1,
  purpose: "production",
  lane: "triage",
  attempt: 1,
  notBefore: NOW,
  expiresAt: NOW + 60_000,
  leaseExpiresAt: NOW + 30_000,
  contextRevision: "ctx-doctor",
  input: { candidateIds: [1], topByReach: 1, random: 0 },
  limits: { maxVerdicts: 1 },
});

let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-doctor-test-"));
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

function seedJournal(): void {
  startJournal({
    runnerId: config.runnerId,
    mcpUrl: config.mcpUrl,
    credentialFingerprint: "e8c1b013f9ee94fc62598aba2d264d8a494a42c6bf0ae93e66143149803ce9d1",
    leaseToken: "lease-token-0123456789abcdef",
    workOrder,
  });
}

describe("doctor recovery diagnostics", () => {
  it("distinguishes a recoverable live journal from a changed/revoked credential", () => {
    seedJournal();
    expect(diagnoseRecoveryJournal(config, NOW)).toMatchObject({ status: "warn" });
    expect(
      diagnoseRecoveryJournal({ ...config, apiKey: "new-runner-secret" }, NOW),
    ).toMatchObject({ status: "fail" });
  });

  it("offers safe quarantine only after the hard work expiry plus skew margin", () => {
    seedJournal();
    const check = diagnoseRecoveryJournal(
      { ...config, apiKey: "revoked-runner-secret" },
      workOrder.expiresAt + JOURNAL_EXPIRY_SKEW_MS,
    );
    expect(check).toMatchObject({ status: "warn" });
    expect(check.recovery).toContain("setup --reauthorize");
  });

  it("reports corrupt recovery and session ledgers even without configuration", async () => {
    writeFileSync(journalPath(), "{}", { mode: 0o600 });
    chmodSync(journalPath(), 0o600);
    writeFileSync(sessionUsagePath(), "{}", { mode: 0o600 });
    chmodSync(sessionUsagePath(), 0o600);
    const report = await runDoctor(null, NOW);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "recovery-journal", status: "fail" }),
        expect.objectContaining({ name: "provider-session-ledger", status: "fail" }),
        expect.objectContaining({ name: "configuration", status: "fail" }),
      ]),
    );
  });
});
