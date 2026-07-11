import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  RunnerCompleteWorkInputSchema,
  RunnerSubmitBatchInputSchema,
  RunnerSubmitRepliesInputSchema,
  RunnerSubmitTriageInputSchema,
  RunnerWorkOrderSchema,
  type RunnerCompleteWorkInput,
  type RunnerSubmitBatchInput,
  type RunnerSubmitRepliesInput,
  type RunnerSubmitTriageInput,
  type RunnerWorkOrder,
} from "@engager/runner-contract";
import { z } from "zod";
import { agentHome } from "./config.js";
import { renamePathDurably, writePrivateJsonDurably } from "./durable.js";
import { RunnerFault } from "./errors.js";
import { AgentProposalSchema, type AgentProposal } from "./protocol.js";

export const JOURNAL_EXPIRY_SKEW_MS = 5 * 60_000;

const SubmissionJournalSchema = z.discriminatedUnion("tool", [
  z
    .object({ tool: z.literal("runner_submit_triage"), input: RunnerSubmitTriageInputSchema })
    .strict(),
  z
    .object({ tool: z.literal("runner_submit_batch"), input: RunnerSubmitBatchInputSchema })
    .strict(),
  z
    .object({ tool: z.literal("runner_submit_replies"), input: RunnerSubmitRepliesInputSchema })
    .strict(),
]);

const ActiveWorkJournalSchema = z
  .object({
    version: z.literal(1),
    runnerId: z.string().min(1).max(200),
    mcpUrl: z.string().url().max(2_000),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    savedAt: z.number().int().nonnegative(),
    leaseToken: z.string().min(16).max(512),
    leaseExpiresAt: z.number().int().nonnegative().optional(),
    claimClockSkewMs: z.number().int().safe().optional(),
    workOrder: RunnerWorkOrderSchema,
    engineAttempt: z
      .object({
        id: z.string().uuid(),
        startedAt: z.number().int().nonnegative(),
        sessionDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .optional(),
    cognition: z
      .object({
        proposal: AgentProposalSchema,
        accounted: z.boolean(),
        model: z.string().min(1).max(200).optional(),
        durationMs: z.number().int().nonnegative(),
        usage: z
          .object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    submission: SubmissionJournalSchema.optional(),
    completion: RunnerCompleteWorkInputSchema.optional(),
  })
  .strict();

export type JournalSubmission =
  | { tool: "runner_submit_triage"; input: RunnerSubmitTriageInput }
  | { tool: "runner_submit_batch"; input: RunnerSubmitBatchInput }
  | { tool: "runner_submit_replies"; input: RunnerSubmitRepliesInput };

export type ActiveWorkJournal = {
  version: 1;
  runnerId: string;
  mcpUrl: string;
  credentialFingerprint: string;
  savedAt: number;
  leaseToken: string;
  leaseExpiresAt?: number;
  claimClockSkewMs?: number;
  workOrder: RunnerWorkOrder;
  engineAttempt?: { id: string; startedAt: number; sessionDay: string };
  cognition?: {
    proposal: AgentProposal;
    accounted: boolean;
    model?: string;
    durationMs: number;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  submission?: JournalSubmission;
  completion?: RunnerCompleteWorkInput;
};

export function journalPath(): string {
  return join(agentHome(), "active-work.json");
}

export function readJournal(): ActiveWorkJournal | null {
  const path = journalPath();
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
  if (!stat.isFile() || !owned || (stat.mode & 0o777) !== 0o600) {
    throw new Error("active work journal is not a private regular file");
  }
  return ActiveWorkJournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeJournal(value: ActiveWorkJournal): ActiveWorkJournal {
  const parsed = ActiveWorkJournalSchema.parse({ ...value, savedAt: Date.now() });
  writePrivateJsonDurably(journalPath(), parsed);
  return parsed;
}

export function startJournal(input: {
  runnerId: string;
  mcpUrl: string;
  credentialFingerprint: string;
  leaseToken: string;
  workOrder: RunnerWorkOrder;
  claimClockSkewMs?: number;
}): ActiveWorkJournal {
  const journal: ActiveWorkJournal = {
    version: 1,
    runnerId: input.runnerId,
    mcpUrl: input.mcpUrl,
    credentialFingerprint: input.credentialFingerprint,
    savedAt: Date.now(),
    leaseToken: input.leaseToken,
    leaseExpiresAt: input.workOrder.leaseExpiresAt,
    ...(input.claimClockSkewMs != null ? { claimClockSkewMs: input.claimClockSkewMs } : {}),
    workOrder: input.workOrder,
  };
  return writeJournal(journal);
}

export function journalBinding(config: { mcpUrl: string; apiKey: string }): {
  mcpUrl: string;
  credentialFingerprint: string;
} {
  return {
    mcpUrl: new URL(config.mcpUrl).toString(),
    credentialFingerprint: createHash("sha256").update(config.apiKey).digest("hex"),
  };
}

export function withJournalSubmission(
  journal: ActiveWorkJournal,
  submission: JournalSubmission,
): ActiveWorkJournal {
  const next = { ...journal, submission, completion: undefined };
  return writeJournal(next);
}

export function withJournalLease(
  journal: ActiveWorkJournal,
  leaseExpiresAt: number,
): ActiveWorkJournal {
  return writeJournal({ ...journal, leaseExpiresAt });
}

export function withJournalCognition(
  journal: ActiveWorkJournal,
  cognition: NonNullable<ActiveWorkJournal["cognition"]>,
): ActiveWorkJournal {
  return writeJournal({ ...journal, cognition });
}

export function withJournalEngineAttempt(
  journal: ActiveWorkJournal,
  engineAttempt: NonNullable<ActiveWorkJournal["engineAttempt"]>,
): ActiveWorkJournal {
  return writeJournal({ ...journal, engineAttempt });
}

export function accountJournalCognition(): void {
  const journal = readJournal();
  if (journal?.cognition && !journal.cognition.accounted) {
    writeJournal({
      ...journal,
      cognition: { ...journal.cognition, accounted: true },
    });
  }
}

export function withJournalCompletion(
  journal: ActiveWorkJournal,
  completion: RunnerCompleteWorkInput,
): ActiveWorkJournal {
  const next = { ...journal, completion };
  return writeJournal(next);
}

export function clearJournal(): void {
  rmSync(journalPath(), { force: true });
}

export type JournalInspection =
  | { state: "absent" }
  | { state: "invalid"; detail: string }
  | {
      state: "active" | "expired";
      journal: ActiveWorkJournal;
      terminalAt: number;
    };

/** Read-only recovery classification. Only the work-order hard expiry plus a
 * clock-skew margin can prove that an unreachable/revoked lease is terminal. */
export function inspectJournal(now: number = Date.now()): JournalInspection {
  try {
    const journal = readJournal();
    if (!journal) return { state: "absent" };
    if (Math.abs(journal.claimClockSkewMs ?? 0) > 5 * 60_000) {
      return {
        state: "invalid",
        detail:
          "active-work.json was claimed while the local clock was untrusted; reconcile it with the original credential after correcting the clock",
      };
    }
    const terminalAt = Math.min(
      Number.MAX_SAFE_INTEGER,
      journal.workOrder.expiresAt + JOURNAL_EXPIRY_SKEW_MS,
    );
    return {
      state: now >= terminalAt ? "expired" : "active",
      journal,
      terminalAt,
    };
  } catch {
    return {
      state: "invalid",
      detail: "active-work.json is corrupt, unsafe, or not a private regular file",
    };
  }
}

export type SetupJournalDisposition =
  | { state: "ready" }
  | { state: "quarantined"; path: string; terminalAt: number }
  | { state: "blocked"; reason: "active" | "invalid"; terminalAt?: number };

/** Setup may rotate credentials only after authority is provably terminal.
 * Expired state is preserved via a private quarantine rename for forensics. */
export function prepareSetupJournal(now: number = Date.now()): SetupJournalDisposition {
  const inspection = inspectJournal(now);
  if (inspection.state === "absent") return { state: "ready" };
  if (inspection.state === "invalid") return { state: "blocked", reason: "invalid" };
  if (inspection.state === "active") {
    return { state: "blocked", reason: "active", terminalAt: inspection.terminalAt };
  }
  const destination = join(
    agentHome(),
    `active-work.expired.${now}.${randomUUID()}.json`,
  );
  try {
    renamePathDurably(journalPath(), destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    throw new RunnerFault("VALIDATION_REJECTED", "expired recovery journal could not be quarantined", {
      impact: "Setup stopped before replacing the endpoint, credential, or engine.",
      recovery: "Run `engager-agent doctor` and repair ~/.engager ownership/permissions before retrying setup.",
      cause: error,
    });
  }
  return { state: "quarantined", path: destination, terminalAt: inspection.terminalAt };
}
