import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_CONTRACT_MAJOR,
  RunnerCompleteWorkInputSchema,
  RunnerSubmitBatchInputSchema,
  RunnerSubmitRepliesInputSchema,
  RunnerSubmitTriageInputSchema,
  type DraftReceipt,
  type ReplyReceipt,
  type RunnerClaimResponse,
  type RunnerCompletionResponse,
  type RunnerReceipt,
  type RunnerSubmitBatchInput,
  type RunnerSubmitRepliesInput,
  type RunnerSubmitTriageInput,
  type RunnerValidateBatchResponse,
  type RunnerWorkContextResponse,
  type RunnerWorkOrder,
  type RunnerWorkPurpose,
  type TriageReceipt,
} from "@engager/runner-contract";
import type { AgentConfig } from "./config.js";
import type { AgentEngine, EngineRunResult } from "./engine.js";
import { RunnerFault, asRunnerFault, markEngineAttempted } from "./errors.js";
import {
  clearJournal,
  journalBinding,
  readJournal,
  startJournal,
  withJournalCompletion,
  withJournalCognition,
  withJournalEngineAttempt,
  withJournalLease,
  withJournalSubmission,
  type ActiveWorkJournal,
  type JournalSubmission,
} from "./journal.js";
import type { EngagerMcp } from "./mcp.js";
import { buildEnginePrompt } from "./prompt.js";
import { reserveProviderSession } from "./session-usage.js";
import {
  RUNNER_SUPPORTED_VERSION,
  contextUnprocessedIds,
  proposalItemId,
  workOrderItemIds,
  type AgentProposal,
} from "./protocol.js";

export type ExecutionOutcome = {
  ran: boolean;
  ok: boolean;
  note: string;
  workOrderId?: string;
  lane?: RunnerWorkOrder["lane"];
  workPurpose?: RunnerWorkPurpose;
  completion?: RunnerCompletionResponse;
  engine?: EngineRunResult;
  errorCode?: string;
  nextPollAt?: number;
  fatal?: boolean;
  recoveredEngineAttempt?: boolean;
};

export type ExecutorDeps = {
  now?: () => number;
  journal?: {
    read: typeof readJournal;
    start: typeof startJournal;
    submission: typeof withJournalSubmission;
    completion: typeof withJournalCompletion;
    cognition: typeof withJournalCognition;
    engineAttempt: typeof withJournalEngineAttempt;
    lease: typeof withJournalLease;
    clear: typeof clearJournal;
  };
  reserveSession?: typeof reserveProviderSession;
};

const DEFAULT_JOURNAL: NonNullable<ExecutorDeps["journal"]> = {
  read: readJournal,
  start: startJournal,
  submission: withJournalSubmission,
  completion: withJournalCompletion,
  cognition: withJournalCognition,
  engineAttempt: withJournalEngineAttempt,
  lease: withJournalLease,
  clear: clearJournal,
};

/** Claim or recover at most one server-authored work order. */
export async function executeOneClaim(
  config: AgentConfig,
  mcp: EngagerMcp,
  engine: AgentEngine,
  options: {
    signal?: AbortSignal;
    allowCognition?: boolean;
    cognitionFault?: RunnerFault;
    claimPurpose?: RunnerWorkPurpose;
    canClaim?: () => boolean;
  } = {},
  deps: ExecutorDeps = {},
): Promise<ExecutionOutcome> {
  const now = deps.now ?? Date.now;
  const journalStore = deps.journal ?? DEFAULT_JOURNAL;
  const reserveSession = deps.reserveSession ?? reserveProviderSession;
  const existing = journalStore.read();
  const binding = journalBinding(config);
  if (existing) {
    if (existing.runnerId !== config.runnerId) {
      throw new RunnerFault("AUTH_REVOKED", "active work belongs to a different runner identity", {
        impact: "Recovery stopped before any replay or new claim.",
        recovery: "Restore the original runner credential or remove the stale journal after its lease expires.",
      });
    }
    if (
      existing.mcpUrl !== binding.mcpUrl ||
      existing.credentialFingerprint !== binding.credentialFingerprint
    ) {
      throw new RunnerFault("AUTH_REVOKED", "active work is bound to a different Engager credential", {
        impact: "The stored lease and submission were not sent to the newly configured control plane.",
        recovery: "Restore the original endpoint/key and reconcile the journal before reauthorizing setup.",
      });
    }
    if (options.claimPurpose && existing.workOrder.purpose !== options.claimPurpose) {
      throw new RunnerFault(
        "VALIDATION_REJECTED",
        `active recovery work is ${existing.workOrder.purpose}, not ${options.claimPurpose}`,
        {
          impact: "Setup proof refused to recover or execute production work.",
          recovery: "Finish or expire the existing production lease, then retry setup proof.",
        },
      );
    }
    try {
      return await executeJournal(
        config,
        mcp,
        engine,
        existing,
        true,
        options,
        journalStore,
        now,
        reserveSession,
      );
    } catch (error) {
      const fault = asRunnerFault(error);
      if (fault.code === "LEASE_LOST" || fault.discardJournal) journalStore.clear();
      throw fault;
    }
  }

  if (options.canClaim && !options.canClaim()) {
    return {
      ran: false,
      ok: true,
      note: "paused locally before claim; no work was claimed",
    };
  }
  const claim = await mcp.claim({
    contractVersion: RUNNER_CONTRACT_MAJOR,
    runnerId: config.runnerId,
    supportedVersion: RUNNER_SUPPORTED_VERSION,
    ...(options.claimPurpose ? { claimPurpose: options.claimPurpose } : {}),
  });
  if (claim.status === "empty") {
    return {
      ran: false,
      ok: true,
      note: claim.reason,
      ...(claim.code ? { errorCode: claim.code } : {}),
      ...(claim.nextPollAt != null ? { nextPollAt: claim.nextPollAt } : {}),
    };
  }
  const claimObservedAt = now();
  const journal = journalStore.start({
    runnerId: config.runnerId,
    ...binding,
    leaseToken: claim.leaseToken,
    workOrder: claim.workOrder,
    claimClockSkewMs: claim.claimedAt - claimObservedAt,
  });
  try {
    // A successful claim carries live authority. Persist it before any local
    // clock/purpose/pause refusal so a failure cannot silently discard the
    // only lease token while the server keeps the order claimed.
    assertClock(claim, claimObservedAt);
    if (options.claimPurpose && claim.workOrder.purpose !== options.claimPurpose) {
      throw new RunnerFault(
        "VALIDATION_REJECTED",
        `server claimed ${claim.workOrder.purpose} work for a ${options.claimPurpose} request`,
        {
          impact: "The mismatched work order was journaled but no cognition started.",
          recovery: "Upgrade the server/runner contract pair before retrying setup.",
        },
      );
    }
    if (options.canClaim && !options.canClaim()) {
      return {
        ran: false,
        ok: true,
        note: "paused locally after claim; the exact lease was retained without cognition",
        workOrderId: claim.workOrder.id,
        lane: claim.workOrder.lane,
        workPurpose: claim.workOrder.purpose,
      };
    }
    return await executeJournal(
      config,
      mcp,
      engine,
      journal,
      false,
      options,
      journalStore,
      now,
      reserveSession,
    );
  } catch (error) {
    const fault = asRunnerFault(error);
    if (fault.code === "LEASE_LOST" || fault.discardJournal) journalStore.clear();
    throw fault;
  }
}

async function executeJournal(
  config: AgentConfig,
  mcp: EngagerMcp,
  engine: AgentEngine,
  initial: ActiveWorkJournal,
  recovering: boolean,
  options: {
    signal?: AbortSignal;
    allowCognition?: boolean;
    cognitionFault?: RunnerFault;
    claimPurpose?: RunnerWorkPurpose;
  },
  journalStore: NonNullable<ExecutorDeps["journal"]>,
  now: () => number,
  reserveSession: typeof reserveProviderSession,
): Promise<ExecutionOutcome> {
  let journal = initial;
  const order = journal.workOrder;
  const finalizeCompletion = (completion: RunnerCompletionResponse): void => {
    finalizeCompletionJournal(
      journalStore.clear,
      order.purpose,
      completion,
      Boolean(config.pendingSetupProofOrganizationId),
    );
  };
  const recoveredUnaccounted = journal.cognition?.accounted === false;
  if (journal.completion) {
    try {
      const completion = await mcp.complete(journal.completion);
      verifyCompletion(order, completion);
      finalizeCompletion(completion);
      return {
        ...completionOutcome(order, completion),
        ...(recoveredUnaccounted ? { recoveredEngineAttempt: true } : {}),
      };
    } catch (error) {
      if (recoveredUnaccounted) throw markEngineAttempted(error);
      throw error;
    }
  }

  const supervisor = new LeaseSupervisor(
    mcp,
    order.id,
    journal.leaseToken,
    journal.leaseExpiresAt ?? order.leaseExpiresAt,
    order.expiresAt,
    options.signal,
    now,
    (leaseExpiresAt) => {
      journal = journalStore.lease(journal, leaseExpiresAt);
    },
  );
  supervisor.start();
  let engineStartedThisRun = false;
  try {
    // Recovery must re-establish both lease authority and server-clock sanity;
    // otherwise a clock-skewed first claim could start cognition on resume.
    if (recovering) await supervisor.verifyClock();
    if (
      options.allowCognition === false &&
      !journal.cognition &&
      !journal.submission &&
      !journal.completion
    ) {
      throw options.cognitionFault ?? new RunnerFault("RUNNER_PAUSED", "cognition is currently blocked", {
        impact: "The live recovery journal was retained without starting a provider session.",
        recovery: "Resolve the local engine/quota/pause block, then retry recovery.",
        retryable: true,
      });
    }
    if (journal.submission) {
      const receipt = await replaySubmission(mcp, journal.submission);
      verifyReceipt(order, journal.submission, receipt);
      await supervisor.ensureFresh();
      const completionInput = completionRequest(
        journal,
        `Server replayed receipt for ${receipt.summary.received} ${order.lane} item(s)`,
      );
      journal = journalStore.completion(journal, completionInput);
      const completion = await mcp.complete(completionInput);
      verifyCompletion(order, completion, receipt);
      finalizeCompletion(completion);
      return {
        ...completionOutcome(order, completion),
        ...(recoveredUnaccounted ? { recoveredEngineAttempt: true } : {}),
      };
    }
    await supervisor.ensureFresh();
    const context = await mcp.workContext({
      contractVersion: RUNNER_CONTRACT_MAJOR,
      workOrderId: order.id,
      leaseToken: journal.leaseToken,
      contextRevision: order.contextRevision,
      itemIds: workOrderItemIds(order),
    });
    verifyContext(order, context);

    let receipt: RunnerReceipt | null = null;
    let engineResult: EngineRunResult | undefined;
    let validationRejected = 0;
    if (!contextCanComplete(context)) {
      let scoped: AgentProposal;
      if (journal.cognition) {
        scoped = scopeProposal(order, context, journal.cognition.proposal);
      } else {
        if (options.allowCognition === false) {
          throw options.cognitionFault ?? new RunnerFault("RUNNER_PAUSED", "cognition is currently blocked", {
            impact: "The live recovery journal was retained without starting a provider session.",
            recovery: "Resolve the local engine/quota/pause block, then retry recovery.",
            retryable: true,
          });
        }
        let prompt: string;
        try {
          prompt = buildEnginePrompt(order, context);
        } catch (error) {
          const promptTooLarge =
            error instanceof Error && error.message.startsWith("authoritative engine prompt is ");
          const completionInput = completionRequest(journal, "Authoritative context was unavailable");
          journal = journalStore.completion(journal, completionInput);
          const completion = await mcp.complete(completionInput);
          verifyCompletion(order, completion);
          finalizeCompletion(completion);
          return {
            ...completionOutcome(order, completion),
            ok: false,
            note: error instanceof Error ? error.message : "authoritative context unavailable",
            errorCode: promptTooLarge ? "ENGINE_CONTEXT_LIMIT" : "VALIDATION_REJECTED",
          };
        }
        const directory = mkdtempSync(join(tmpdir(), "engager-cognition-"));
        chmodSync(directory, 0o700);
        try {
          const startedAt = now();
          const attempt = {
            id: randomUUID(),
            startedAt,
            sessionDay: new Date(startedAt).toISOString().slice(0, 10),
          };
          // Debit before both the journal update and provider spawn. A crash in
          // either following step may conservatively consume capacity, but can
          // never create an unmetered provider session.
          reserveSession(attempt.id, attempt.startedAt);
          journal = journalStore.engineAttempt(journal, attempt);
          engineStartedThisRun = true;
          try {
            engineResult = await engine.run({
              prompt,
              lane: order.lane,
              ...(config.model ? { model: config.model } : {}),
              workingDirectory: directory,
              timeoutMs: config.sessionTimeoutMinutes * 60_000,
              signal: supervisor.signal,
            });
          } catch (error) {
            const fault = asRunnerFault(error);
            if (!isDeterministicEngineFault(fault)) throw fault;
            supervisor.throwIfFailed();
            await supervisor.ensureFresh();
            const completionInput = completionRequest(
              journal,
              `Local ${fault.code} terminalized before any submission`,
            );
            journal = journalStore.completion(journal, completionInput);
            const completion = await mcp.complete(completionInput);
            verifyCompletion(order, completion);
            finalizeCompletion(completion);
            const terminal = completionOutcome(order, completion);
            return {
              ...terminal,
              ok: false,
              note: `${fault.code}: ${fault.message}; ${terminal.note}`,
              errorCode: fault.code,
            };
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        supervisor.throwIfFailed();
        await supervisor.ensureFresh();
        scoped = scopeProposal(order, context, engineResult.proposal);
        journal = journalStore.cognition(journal, {
          proposal: scoped,
          accounted: true,
          ...(engineResult.model ?? config.model
            ? { model: engineResult.model ?? config.model }
            : {}),
          durationMs: Math.max(0, Math.round(engineResult.durationMs)),
          ...(engineResult.usage ? { usage: engineResult.usage } : {}),
        });
      }
      let submission = submissionFor(journal, scoped, journal.cognition?.model ?? config.model);

      if (submission.tool === "runner_submit_batch") {
        const validation = await mcp.validateBatch({
          contractVersion: RUNNER_CONTRACT_MAJOR,
          workOrderId: order.id,
          leaseToken: journal.leaseToken,
          contextRevision: order.contextRevision,
          lane: submission.input.lane,
          items: submission.input.items,
        });
        verifyValidation(order, submission.input, validation);
        const validIds = new Set(validation.items.filter((item) => item.valid).map((item) => item.candidateId));
        validationRejected = submission.input.items.length - validIds.size;
        const validItems = submission.input.items.filter((item) => validIds.has(item.candidateId));
        if (validItems.length === 0) {
          const completionInput = completionRequest(journal, "All proposed drafts failed deterministic validation");
          journal = journalStore.completion(journal, completionInput);
          const completion = await mcp.complete(completionInput);
          verifyCompletion(order, completion);
          finalizeCompletion(completion);
          return {
            ...completionOutcome(order, completion),
            ok: false,
            note: `server validation rejected ${validationRejected} draft${validationRejected === 1 ? "" : "s"}`,
            errorCode: "VALIDATION_REJECTED",
            ...(engineResult ? { engine: engineResult } : {}),
            ...(!engineResult && recoveredUnaccounted ? { recoveredEngineAttempt: true } : {}),
          };
        }
        if (validationRejected > 0) {
          submission = {
            ...submission,
            input: RunnerSubmitBatchInputSchema.parse({
              ...submission.input,
              items: validItems,
              idempotencyKey: idempotencyKey(order, "submit", validItems),
            }),
          };
        }
      }

      await supervisor.ensureFresh();
      journal = journalStore.submission(journal, submission);
      receipt = await replaySubmission(mcp, submission);
      verifyReceipt(order, submission, receipt);
    }

    await supervisor.ensureFresh();
    const completionInput = completionRequest(
      journal,
      receipt
        ? `Server receipted ${receipt.summary.received} ${order.lane} item(s)`
        : "All required items were already receipted",
    );
    journal = journalStore.completion(journal, completionInput);
    const completion = await mcp.complete(completionInput);
    verifyCompletion(order, completion, receipt ?? undefined);
    finalizeCompletion(completion);
    const outcome = completionOutcome(order, completion);
    return {
      ...outcome,
      ...(engineResult ? { engine: engineResult } : {}),
      ...(!engineResult && recoveredUnaccounted ? { recoveredEngineAttempt: true } : {}),
      ...(validationRejected > 0
        ? { note: `${outcome.note}; ${validationRejected} draft(s) failed deterministic validation` }
        : {}),
    };
  } catch (error) {
    if (engineStartedThisRun || recoveredUnaccounted) throw markEngineAttempted(error);
    throw error;
  } finally {
    supervisor.stop();
  }
}

/** A purpose-bound setup must durably clear its local pending marker before
 * discarding the idempotent completion replay. Ordinary setup has no marker to
 * settle and clears immediately, so service installation cannot be blocked by
 * an already-accepted proof. */
export function finalizeCompletionJournal(
  clear: () => void,
  claimPurpose?: RunnerWorkPurpose,
  completion?: RunnerCompletionResponse,
  retainAcceptedSetupProof: boolean = false,
): void {
  const acceptedSetupProof =
    claimPurpose === "setup_proof" &&
    completion?.status === "completed" &&
    completion.result.failed === 0 &&
    completion.result.unfinished === 0;
  if (!acceptedSetupProof || !retainAcceptedSetupProof) clear();
}

function scopeProposal(
  order: RunnerWorkOrder,
  context: RunnerWorkContextResponse,
  proposal: AgentProposal,
): AgentProposal {
  const remaining = contextUnprocessedIds(context);
  const remainingSet = new Set(remaining);
  const ids = proposal.items.map((item) => proposalItemId(proposal, item));
  if (new Set(ids).size !== ids.length) {
    throw outputFault("engine returned duplicate item IDs");
  }
  const outside = ids.filter((id) => !remainingSet.has(id));
  if (outside.length > 0) throw outputFault(`engine returned out-of-scope item ${outside[0]}`);
  const capacity = Math.min(
    remaining.length,
    order.lane === "triage"
      ? order.limits.maxVerdicts
      : order.lane === "reply"
        ? order.limits.maxReplies
        : order.limits.maxDrafts,
    typeof context.receiptState.remainingCapacity === "number"
      ? context.receiptState.remainingCapacity
      : remaining.length,
  );
  if (ids.length > capacity) throw outputFault(`engine returned ${ids.length} items; capacity is ${capacity}`);
  if ((order.lane === "triage" || order.lane === "reply") && ids.length !== capacity) {
    throw outputFault(`${order.lane} requires ${capacity} exact decisions; engine returned ${ids.length}`);
  }
  return proposal;
}

function submissionFor(
  journal: ActiveWorkJournal,
  proposal: AgentProposal,
  model?: string,
): JournalSubmission {
  const common = {
    contractVersion: RUNNER_CONTRACT_MAJOR,
    workOrderId: journal.workOrder.id,
    leaseToken: journal.leaseToken,
    idempotencyKey: idempotencyKey(journal.workOrder, "submit", proposal.items),
    contextRevision: journal.workOrder.contextRevision,
  } as const;
  if (proposal.lane === "triage") {
    return {
      tool: "runner_submit_triage",
      input: RunnerSubmitTriageInputSchema.parse({ ...common, lane: proposal.lane, items: proposal.items }),
    };
  }
  if (proposal.lane === "reply") {
    return {
      tool: "runner_submit_replies",
      input: RunnerSubmitRepliesInputSchema.parse({
        ...common,
        lane: proposal.lane,
        items: proposal.items,
        ...(model ? { model } : {}),
      }),
    };
  }
  return {
    tool: "runner_submit_batch",
    input: RunnerSubmitBatchInputSchema.parse({
      ...common,
      lane: proposal.lane,
      items: proposal.items,
      ...(model ? { model } : {}),
    }),
  };
}

async function replaySubmission(
  mcp: EngagerMcp,
  submission: JournalSubmission,
): Promise<TriageReceipt | DraftReceipt | ReplyReceipt> {
  if (submission.tool === "runner_submit_triage") return mcp.submitTriage(submission.input);
  if (submission.tool === "runner_submit_replies") return mcp.submitReplies(submission.input);
  return mcp.submitBatch(submission.input);
}

function completionRequest(journal: ActiveWorkJournal, note: string) {
  return RunnerCompleteWorkInputSchema.parse({
    contractVersion: RUNNER_CONTRACT_MAJOR,
    workOrderId: journal.workOrder.id,
    leaseToken: journal.leaseToken,
    idempotencyKey: idempotencyKey(journal.workOrder, "complete", null),
    note: note.slice(0, 400),
  });
}

function idempotencyKey(order: RunnerWorkOrder, stage: string, body: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ orderId: order.id, attempt: order.attempt, stage, body }))
    .digest("hex")
    .slice(0, 24);
  return `runner-${stage}-${order.attempt}-${digest}`;
}

function verifyContext(order: RunnerWorkOrder, context: RunnerWorkContextResponse): void {
  const expected = workOrderItemIds(order);
  if (
    context.workOrderId !== order.id ||
    context.campaignId !== order.campaignId ||
    context.contextRevision !== order.contextRevision ||
    context.lane !== order.lane ||
    context.requestedItemIds.length !== expected.length ||
    context.requestedItemIds.some((id, index) => id !== expected[index]) ||
    context.frozenItemIds.length !== expected.length ||
    context.frozenItemIds.some((id, index) => id !== expected[index])
  ) {
    throw new RunnerFault("VALIDATION_REJECTED", "server context identity did not match the claim", {
      impact: "The context was not shown to the engine and no mutation was attempted.",
      recovery: "Upgrade the runner/server pair and report the work-order reference.",
    });
  }
}

function verifyReceipt(
  order: RunnerWorkOrder,
  submission: JournalSubmission,
  receipt: RunnerReceipt,
): void {
  if (
    receipt.workOrderId !== order.id ||
    receipt.lane !== order.lane ||
    receipt.idempotencyKey !== submission.input.idempotencyKey
  ) {
    throw new RunnerFault("VALIDATION_REJECTED", "server receipt identity did not match the submission", {
      impact: "The runner refused to claim completion from an ambiguous response.",
      recovery: "Do not retry with a different body; report the work-order reference.",
    });
  }
  const submittedIds = submission.input.items.map((item) =>
    "candidateId" in item ? item.candidateId : item.incomingCommentId,
  );
  const eventIds = receipt.events.map((event) => Number(event.inputId));
  if (
    eventIds.length !== submittedIds.length ||
    new Set(eventIds).size !== eventIds.length ||
    submittedIds.some((id) => !eventIds.includes(id))
  ) {
    throw new RunnerFault("VALIDATION_REJECTED", "server receipt did not name every submitted item exactly once", {
      impact: "The work order was not marked complete by the runner.",
      recovery: "Replay the persisted request only after the server issue is resolved.",
    });
  }
}

function verifyValidation(
  order: RunnerWorkOrder,
  input: RunnerSubmitBatchInput,
  response: RunnerValidateBatchResponse,
): void {
  const expected = input.items.map((item) => item.candidateId);
  const actual = response.items.map((item) => item.candidateId);
  if (
    response.workOrderId !== order.id ||
    response.lane !== input.lane ||
    response.contextRevision !== order.contextRevision ||
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new RunnerFault("VALIDATION_REJECTED", "draft validation response did not match the exact request", {
      impact: "No draft submission was journaled or sent.",
      recovery: "Upgrade the server/runner contract pair and report the work-order reference.",
    });
  }
}

function verifyCompletion(
  order: RunnerWorkOrder,
  completion: RunnerCompletionResponse,
  receipt?: RunnerReceipt,
): void {
  if (completion.workOrderId !== order.id || completion.lane !== order.lane) {
    throw completionFault("completion receipt did not match the work order");
  }
  const expected = requiredWorkCount(order);
  const result = completion.result;
  const total =
    result.accepted +
    result.rejected +
    result.alreadyExists +
    result.failed +
    result.unfinished;
  if (total !== expected) {
    throw completionFault(
      `completion accounted for ${total} item(s); the frozen work order requires ${expected}`,
    );
  }
  if (receipt) {
    const summary = receipt.summary;
    const disagrees =
      result.accepted < summary.accepted ||
      result.rejected < summary.rejected ||
      result.alreadyExists < summary.alreadyExists ||
      result.failed < summary.failed;
    if (disagrees) {
      throw completionFault("completion totals did not include the exact submission receipt");
    }
  }
}

function requiredWorkCount(order: RunnerWorkOrder): number {
  const limit =
    order.lane === "triage"
      ? order.limits.maxVerdicts
      : order.lane === "reply"
        ? order.limits.maxReplies
        : order.limits.maxDrafts;
  return Math.min(workOrderItemIds(order).length, limit);
}

function completionFault(message: string): RunnerFault {
  return new RunnerFault("VALIDATION_REJECTED", message, {
    impact: "The local journal was retained for safe reconciliation.",
    recovery: "Run `engager-agent doctor` and report the work-order reference.",
  });
}

function completionOutcome(
  order: RunnerWorkOrder,
  completion: RunnerCompletionResponse,
): ExecutionOutcome {
  const result = completion.result;
  return {
    ran: true,
    ok: completion.status !== "failed",
    note: `${completion.status}: accepted ${result.accepted}, existing ${result.alreadyExists}, rejected ${result.rejected}, failed ${result.failed}, unfinished ${result.unfinished}`,
    workOrderId: order.id,
    lane: order.lane,
    workPurpose: order.purpose,
    completion,
  };
}

function contextCanComplete(context: RunnerWorkContextResponse): boolean {
  return context.receiptState.canComplete === true || contextUnprocessedIds(context).length === 0;
}

function assertClock(claim: Extract<RunnerClaimResponse, { status: "claimed" }>, now: number): void {
  const skew = Math.abs(claim.claimedAt - now);
  if (skew > 5 * 60_000) {
    throw new RunnerFault("CLOCK_SKEW", `local clock differs from server claim time by ${Math.round(skew / 1000)}s`, {
      impact: "The runner cannot safely supervise lease expiry.",
      recovery: "Correct the system clock, then run `engager-agent doctor`.",
    });
  }
}

function outputFault(message: string): RunnerFault {
  return new RunnerFault("ENGINE_OUTPUT_INVALID", message, {
    impact: "The proposal was discarded before validation or submission.",
    recovery: "Retry once; if this repeats, select another engine/model.",
  });
}

function isDeterministicEngineFault(fault: RunnerFault): boolean {
  return (
    !fault.retryable &&
    new Set([
      "ENGINE_NOT_FOUND",
      "ENGINE_UNSUPPORTED_VERSION",
      "ENGINE_AUTH_REQUIRED",
      "ENGINE_SANDBOX_DENIED",
      "ENGINE_CONTEXT_LIMIT",
      "ENGINE_FAILED",
    ]).has(fault.code)
  );
}

class LeaseSupervisor {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private failure: RunnerFault | null = null;
  private stopped = false;
  private leaseExpiresAt: number;
  private renewal: Promise<void> | null = null;

  constructor(
    private readonly mcp: EngagerMcp,
    private readonly workOrderId: string,
    private readonly leaseToken: string,
    initialExpiry: number,
    private readonly hardExpiresAt: number,
    externalSignal: AbortSignal | undefined,
    private readonly now: () => number,
    private readonly onRenew: (leaseExpiresAt: number) => void,
  ) {
    this.leaseExpiresAt = Math.min(initialExpiry, hardExpiresAt);
    this.signal = this.controller.signal;
    if (externalSignal) {
      if (externalSignal.aborted) this.controller.abort();
      else externalSignal.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async ensureFresh(): Promise<void> {
    this.throwIfFailed();
    const remaining = this.leaseExpiresAt - this.now();
    if (remaining <= 60_000) await this.renew();
    this.throwIfFailed();
  }

  async verifyClock(): Promise<void> {
    this.throwIfFailed();
    await this.renew();
    this.throwIfFailed();
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
    if (this.signal.aborted) {
      throw new RunnerFault("LEASE_LOST", "execution was cancelled before submission", {
        impact: "No late model result was accepted.",
        recovery: "Wait for eligible work to be requeued, then run again.",
        retryable: true,
      });
    }
    if (this.now() >= Math.min(this.leaseExpiresAt, this.hardExpiresAt)) {
      throw new RunnerFault("LEASE_LOST", "runner lease expired", {
        impact: "The current result was discarded and not submitted.",
        recovery: "Wait for the server to requeue eligible work, then run again.",
        retryable: true,
      });
    }
  }

  private schedule(): void {
    if (this.stopped || this.failure) return;
    const remaining = Math.max(1_000, this.leaseExpiresAt - this.now());
    const delay = Math.max(1_000, Math.min(5 * 60_000, Math.floor(remaining * 0.45)));
    this.timer = setTimeout(() => {
      void this.renew().finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private renew(): Promise<void> {
    if (this.stopped || this.failure) return Promise.resolve();
    if (this.renewal) return this.renewal;
    const renewal = this.performRenew();
    this.renewal = renewal;
    void renewal.finally(() => {
      if (this.renewal === renewal) this.renewal = null;
    });
    return renewal;
  }

  private async performRenew(): Promise<void> {
    try {
      const response = await this.mcp.renewLease({
        contractVersion: RUNNER_CONTRACT_MAJOR,
        workOrderId: this.workOrderId,
        leaseToken: this.leaseToken,
      });
      // stop() may run while the network renewal is in flight. Once terminal
      // completion clears the recovery journal, a late renewal must become a
      // no-op rather than recreating active-work.json from its stale closure.
      if (this.stopped) return;
      if (response.workOrderId !== this.workOrderId) {
        throw new RunnerFault("LEASE_LOST", "server renewed a different work order", {
          impact: "The runner stopped before accepting ambiguous lease authority.",
          recovery: "Upgrade the runner/server contract pair and report the work reference.",
        });
      }
      if (response.status === "expired") {
        throw new RunnerFault("LEASE_LOST", response.reason, {
          impact: "The model process was stopped and no late result was submitted.",
          recovery: "Wait for eligible work to be requeued, then run again.",
          retryable: true,
        });
      }
      if (response.leaseToken !== this.leaseToken) {
        throw new RunnerFault("LEASE_LOST", "server changed the stable lease token", {
          impact: "The runner stopped rather than submit under ambiguous authority.",
          recovery: "Upgrade the runner/server contract pair and report the work reference.",
        });
      }
      const skew = Math.abs(response.renewedAt - this.now());
      if (skew > 5 * 60_000) {
        throw new RunnerFault(
          "CLOCK_SKEW",
          `local clock differs from server renewal time by ${Math.round(skew / 1000)}s`,
          {
            impact: "The lease was retained, but no context or cognition was trusted.",
            recovery: "Correct the system clock, run `engager-agent doctor`, then resume.",
          },
        );
      }
      if (response.leaseExpiresAt > this.hardExpiresAt) {
        throw new RunnerFault("LEASE_LOST", "server renewed the lease beyond the work-order hard expiry", {
          impact: "The runner rejected authority that exceeded the immutable claim boundary.",
          recovery: "Upgrade the runner/server contract pair and report the work reference.",
        });
      }
      if (response.leaseExpiresAt < this.leaseExpiresAt) {
        throw new RunnerFault("LEASE_LOST", "server moved the lease expiry backwards", {
          impact: "The runner stopped before accepting a stale renewal response.",
          recovery: "Upgrade the runner/server contract pair and report the work reference.",
        });
      }
      this.leaseExpiresAt = response.leaseExpiresAt;
      this.onRenew(response.leaseExpiresAt);
    } catch (error) {
      this.failure = asRunnerFault(error);
      this.controller.abort();
    }
  }
}
