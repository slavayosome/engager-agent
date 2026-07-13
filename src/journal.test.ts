import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerWorkOrderSchema } from "@engager/runner-contract";
import {
  clearJournal,
  inspectJournal,
  JOURNAL_EXPIRY_SKEW_MS,
  journalPath,
  prepareSetupJournal,
  readJournal,
  startJournal,
  withJournalCompletion,
  withJournalLease,
  withJournalSubmission,
} from "./journal.js";
import { agentHome } from "./config.js";

let home: string;
const prior = process.env.ENGAGER_AGENT_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "engager-journal-test-"));
  process.env.ENGAGER_AGENT_HOME = home;
});

afterEach(() => {
  clearJournal();
  if (prior === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = prior;
});

const workOrder = RunnerWorkOrderSchema.parse({
  contractVersion: 2,
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: 11,
  purpose: "production",
  lane: "triage",
  attempt: 1,
  notBefore: 100,
  expiresAt: 10_000,
  leaseExpiresAt: 5_000,
  contextRevision: "ctx-1",
  input: { candidateIds: [101], topByReach: 1, random: 0 },
  limits: { maxVerdicts: 1 },
});

describe("active work journal", () => {
  it("atomically persists the lease and exact replay requests as private data", () => {
    let journal = startJournal({
      runnerId: "runner-test",
      mcpUrl: "https://engager.test/mcp",
      credentialFingerprint: "a".repeat(64),
      leaseToken: "lease-token-0123456789abcdef",
      workOrder,
    });
    journal = withJournalSubmission(journal, {
      tool: "runner_submit_triage",
      input: {
        contractVersion: 2,
        workOrderId: workOrder.id,
        leaseToken: journal.leaseToken,
        idempotencyKey: "triage-submit-key",
        contextRevision: workOrder.contextRevision,
        lane: "triage",
        items: [{ candidateId: 101, verdict: "match", score: 0.9 }],
      },
    });
    journal = withJournalLease(journal, workOrder.leaseExpiresAt + 300_000);
    expect(readJournal()?.leaseExpiresAt).toBe(workOrder.leaseExpiresAt + 300_000);
    journal = withJournalCompletion(journal, {
      contractVersion: 2,
      workOrderId: workOrder.id,
      leaseToken: journal.leaseToken,
      idempotencyKey: "completion-key",
      note: "exact receipt replay",
    });
    expect(readJournal()).toEqual(journal);
    expect(statSync(agentHome()).mode & 0o777).toBe(0o700);
    expect(statSync(journalPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(journalPath(), "utf8")).toContain("triage-submit-key");
  });

  it("fails closed on a corrupt journal", () => {
    writeFileSync(journalPath(), "{}", { mode: 0o600 });
    chmodSync(journalPath(), 0o600);
    expect(() => readJournal()).toThrow();
    expect(inspectJournal()).toMatchObject({ state: "invalid" });
  });

  it("refuses a public journal and never treats it as absent", () => {
    startJournal({
      runnerId: "runner-test",
      mcpUrl: "https://engager.test/mcp",
      credentialFingerprint: "a".repeat(64),
      leaseToken: "lease-token-0123456789abcdef",
      workOrder,
    });
    chmodSync(journalPath(), 0o644);
    expect(() => readJournal()).toThrow(/private regular file/);
    expect(prepareSetupJournal()).toEqual({ state: "blocked", reason: "invalid" });
  });

  it("blocks live authority but privately quarantines a provably expired journal", () => {
    startJournal({
      runnerId: "runner-test",
      mcpUrl: "https://engager.test/mcp",
      credentialFingerprint: "a".repeat(64),
      leaseToken: "lease-token-0123456789abcdef",
      workOrder,
    });
    expect(prepareSetupJournal(workOrder.expiresAt + JOURNAL_EXPIRY_SKEW_MS - 1)).toMatchObject({
      state: "blocked",
      reason: "active",
    });
    const disposition = prepareSetupJournal(workOrder.expiresAt + JOURNAL_EXPIRY_SKEW_MS);
    expect(disposition).toMatchObject({ state: "quarantined" });
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(agentHome()).find((name) => name.startsWith("active-work.expired."));
    expect(quarantined).toBeDefined();
    expect(statSync(join(agentHome(), quarantined!)).mode & 0o777).toBe(0o600);
  });

  it("never uses an untrusted claim clock to quarantine live authority", () => {
    startJournal({
      runnerId: "runner-test",
      mcpUrl: "https://engager.test/mcp",
      credentialFingerprint: "a".repeat(64),
      leaseToken: "lease-token-0123456789abcdef",
      workOrder,
      claimClockSkewMs: 10 * 60_000,
    });
    expect(prepareSetupJournal(Number.MAX_SAFE_INTEGER)).toEqual({
      state: "blocked",
      reason: "invalid",
    });
    expect(existsSync(journalPath())).toBe(true);
  });
});
