import type { AgentConfig } from "./config.js";
import type { RunnerWorkPurpose } from "@engager/runner-contract";
import { isEngineReady, type AgentEngine, type EngineDetection } from "./engine.js";
import { engineFor } from "./engines/index.js";
import { executeOneClaim, type ExecutionOutcome } from "./executor.js";
import { RunnerFault, asRunnerFault, formatRunnerFault, sanitizeTerminalText } from "./errors.js";
import { connectAndNegotiate, controlPoll, type HeartbeatState } from "./heartbeat.js";
import { log } from "./log.js";
import { readJournal } from "./journal.js";
import { clearHalt, readHalt, readPause, writeHalt } from "./markers.js";
import { readStatus, writeStatus, type CycleInfo, type RunnerState } from "./status.js";
import { providerSessionsToday } from "./session-usage.js";
import { readUpgradeTransition } from "./upgrade-transition.js";

export const MAX_CONSECUTIVE_FAILURES = 3;
const CONTROL_POLL_MS = 5 * 60_000;

export function controlTickDelayMs(rand: () => number = Math.random): number {
  return Math.round(CONTROL_POLL_MS * (0.8 + rand() * 0.5));
}

export type ControlCycleDeps = {
  engine: (
    name: AgentConfig["engine"],
    executablePath?: string,
    configDir?: string,
  ) => AgentEngine;
  connect: typeof connectAndNegotiate;
  execute: typeof executeOneClaim;
  hasJournal: () => boolean;
};

const REAL_DEPS: ControlCycleDeps = {
  engine: engineFor,
  connect: connectAndNegotiate,
  execute: executeOneClaim,
  hasJournal: () => readJournal() != null,
};

export async function runControlCycle(
  config: AgentConfig,
  version: string,
  state: HeartbeatState,
  options: {
    allowWork?: boolean;
    /** Restricts a freshly bootstrapped upgrade target to control negotiation
     * and readiness publication until the upgrader commits its transition. */
    readinessOnly?: boolean;
    /** Rechecked immediately before and after a remote claim so a transition
     * created during negotiation cannot start cognition. */
    executionFence?: () => boolean;
    signal?: AbortSignal;
    claimPurpose?: RunnerWorkPurpose;
    /** Runs synchronously after protocol/surface negotiation and before any
     * claim or recovery mutation. Service mode uses it as its durable startup
     * milestone. */
    onNegotiated?: (
      protocol: "v1" | "2.1",
      quotaState: Record<string, unknown>,
      engineReady: boolean,
    ) => void;
  } = {},
  deps: ControlCycleDeps = REAL_DEPS,
): Promise<{ outcome: ExecutionOutcome; protocol: "v1" | "2.1"; quotaState: Record<string, unknown> }> {
  let engine: AgentEngine | null = null;
  let detectionFailure: RunnerFault | null = null;
  let detection: EngineDetection;
  try {
    engine = deps.engine(
      config.engine,
      config.enginePath,
      config.engineConfigDir,
    );
    detection = await engine.detect();
  } catch (error) {
    detectionFailure = asRunnerFault(error);
    detection = {
      name: config.engine,
      installed: true,
      supported: false,
      authenticated: null,
      detail: `engine probe failed: ${detectionFailure.message}`,
    };
  }
  const localCapped = state.sessionsToday >= config.dailySessionCap;
  const quotaBlock = activeQuotaBlock(state.quotaState);
  const quotaState = localCapped
    ? quota("exhausted", "local_daily_session_cap")
    : quotaBlock ??
      (detectionFailure
        ? quota("error", "engine_probe_failed")
        : quotaFromDetection(detection));
  const heartbeat = { ...state, quotaState };
  const { mcp, negotiated } = await deps.connect(config, version, heartbeat, options.signal);
  try {
    const directive = negotiated.directive;
    const directiveCode = "code" in directive ? directive.code : undefined;
    const directiveNextPollAt = "nextPollAt" in directive ? directive.nextPollAt : undefined;
    if (directive.directive === "stop") {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: false,
          note: `server stop: ${directive.reason}`,
          errorCode: directiveCode ?? "SERVER_STOP",
          fatal: true,
        },
      };
    }
    const upgradeBlocked =
      directive.directive === "idle" &&
      (directiveCode === "runner_upgrade_required" || directiveCode === "runner_v2_disabled");
    if (!upgradeBlocked) {
      options.onNegotiated?.(
        negotiated.protocol,
        quotaState,
        engine != null && isEngineReady(detection),
      );
    }
    if (options.readinessOnly) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: upgradeBlocked
          ? {
              ran: false,
              ok: false,
              note: directive.reason,
              errorCode: "CONTRACT_UPGRADE_REQUIRED",
            }
          : {
              ran: false,
              ok: true,
              note: "upgrade handoff readiness verified; no work was claimed",
            },
      };
    }
    if (options.executionFence && !options.executionFence()) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: true,
          note: "upgrade transition fenced execution; no work was claimed",
        },
      };
    }
    const recoveryPending = deps.hasJournal();
    if (recoveryPending) {
      const canUseEngine =
        engine != null &&
        isEngineReady(detection) &&
        !localCapped &&
        !quotaBlock &&
        options.allowWork !== false;
      const cognitionFault = !engine || detectionFailure
        ? new RunnerFault("ENGINE_FAILED", detection.detail ?? "engine probe failed", {
            impact: "The recovery journal was retained without starting cognition.",
            recovery: "Run `engager-agent doctor`, repair the engine, then retry.",
          })
        : !isEngineReady(detection)
          ? new RunnerFault(
              !detection.installed
                ? "ENGINE_NOT_FOUND"
                : detection.authenticated === false
                  ? "ENGINE_AUTH_REQUIRED"
                  : "ENGINE_UNSUPPORTED_VERSION",
              detection.detail ?? `${config.engine} is not ready`,
              {
                impact: "The recovery journal was retained without starting cognition.",
                recovery: "Run `engager-agent doctor`, repair the engine, then retry.",
              },
            )
          : localCapped || quotaBlock
            ? new RunnerFault("ENGINE_QUOTA", "provider cognition is currently quota-blocked", {
                impact: "Receipt recovery may continue, but no new cognition was started.",
                recovery: "Wait for the local day boundary or raise the explicit local cap.",
                retryable: true,
              })
            : new RunnerFault("RUNNER_PAUSED", "runner is paused locally", {
                impact: "Receipt recovery may continue, but no new cognition was started.",
                recovery: "Run `engager-agent resume` to permit cognition.",
                retryable: true,
              });
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: await deps.execute(config, mcp, engine ?? unavailableEngine(config.engine, cognitionFault), {
          signal: options.signal,
          allowCognition: canUseEngine,
          cognitionFault,
          canClaim: () =>
            options.allowWork !== false &&
            readPause() == null &&
            (options.executionFence?.() ?? true),
          ...(options.claimPurpose ? { claimPurpose: options.claimPurpose } : {}),
        }),
      };
    }
    if (directive.directive === "idle") {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: !upgradeBlocked,
          note: directive.reason,
          ...(upgradeBlocked
            ? { errorCode: "CONTRACT_UPGRADE_REQUIRED" }
            : directiveCode
              ? { errorCode: directiveCode }
              : {}),
          ...(directiveNextPollAt != null ? { nextPollAt: directiveNextPollAt } : {}),
        },
      };
    }
    if (options.allowWork === false) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: { ran: false, ok: true, note: "paused locally; no work was claimed" },
      };
    }
    if (localCapped) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: false,
          note: `local daily session cap reached (${config.dailySessionCap})`,
          errorCode: "ENGINE_QUOTA",
        },
      };
    }
    if (quotaBlock) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: false,
          note: `provider cooldown is active until ${new Date(Number(quotaBlock.resetsAt)).toISOString()}`,
          errorCode:
            quotaBlock.reasonCode === "engine_overloaded" ? "ENGINE_OVERLOADED" : "ENGINE_QUOTA",
          nextPollAt: Number(quotaBlock.resetsAt),
        },
      };
    }
    if (!engine || !isEngineReady(detection)) {
      return {
        protocol: negotiated.protocol,
        quotaState,
        outcome: {
          ran: false,
          ok: false,
          note: detection.detail ?? `${config.engine} is not ready`,
          errorCode: detectionFailure
            ? "ENGINE_FAILED"
            : !detection.installed
            ? "ENGINE_NOT_FOUND"
            : detection.authenticated === false
              ? "ENGINE_AUTH_REQUIRED"
              : "ENGINE_UNSUPPORTED_VERSION",
        },
      };
    }

    if (negotiated.protocol === "2.1") {
      return {
        protocol: "2.1",
        quotaState,
        outcome: await deps.execute(config, mcp, engine, {
          signal: options.signal,
          canClaim: () =>
            options.allowWork !== false &&
            readPause() == null &&
            (options.executionFence?.() ?? true),
          ...(options.claimPurpose ? { claimPurpose: options.claimPurpose } : {}),
        }),
      };
    }
    return {
      protocol: "v1",
      quotaState,
      outcome: {
        ran: false,
        ok: false,
        note:
          "runner 0.9 executes leased protocol v2.1 only; this organization is still on the retired v1 control surface",
        errorCode: "CONTRACT_UPGRADE_REQUIRED",
      },
    };
  } finally {
    await mcp.close();
  }
}

function unavailableEngine(name: AgentConfig["engine"], fault: RunnerFault): AgentEngine {
  return {
    name,
    detect: async () => ({ name, installed: false, supported: false, authenticated: false }),
    run: async () => {
      throw fault;
    },
  };
}

function quotaFromDetection(detection: EngineDetection): Record<string, unknown> {
  if (!detection.installed) return quota("unavailable", "engine_not_found");
  if (!detection.supported) return quota("unavailable", "engine_unsupported_version");
  if (detection.authenticated === false) return quota("unavailable", "engine_auth_required");
  if (detection.authenticated !== true) return quota("error", "engine_auth_probe_unknown");
  return quota("available", "engine_ready");
}

function quota(status: string, reasonCode: string, resetsAt?: number): Record<string, unknown> {
  return {
    status,
    reasonCode,
    observedAt: Date.now(),
    ...(resetsAt != null ? { resetsAt } : {}),
  };
}

export const MAINTENANCE_HANDOFF_TIMEOUT_MS = 15_000;

export type UpgradeCommitWaitDeps = {
  pending: () => boolean;
  now: () => number;
  pause: (milliseconds: number) => Promise<void>;
};

const REAL_UPGRADE_COMMIT_WAIT_DEPS: UpgradeCommitWaitDeps = {
  pending: () => readUpgradeTransition() != null,
  now: Date.now,
  pause: sleep,
};

export async function waitForUpgradeTransitionCommit(
  timeoutMs = MAINTENANCE_HANDOFF_TIMEOUT_MS,
  deps: UpgradeCommitWaitDeps = REAL_UPGRADE_COMMIT_WAIT_DEPS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    try {
      if (!deps.pending()) return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `upgrade transition journal became unsafe: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return {
        ok: false,
        reason: "upgrade transition was not committed before the maintenance handoff timeout",
      };
    }
    await deps.pause(Math.min(100, remaining));
  }
}

export type LoopOptions = {
  service?: boolean;
  version?: string;
  maintenanceHandoff?: boolean;
  handoffTimeoutMs?: number;
  handoffWaitDeps?: UpgradeCommitWaitDeps;
};

export async function runLoop(config: AgentConfig, options: LoopOptions = {}): Promise<void> {
  const service = options.service ?? false;
  const version = options.version ?? "0";
  const startedAt = Date.now();
  const today = () => new Date().toISOString().slice(0, 10);
  const prior = readStatus();
  let sessionDay = today();
  let sessionsToday = providerSessionsToday();
  let consecutiveFailures = 0;
  let lastCycle: CycleInfo | undefined = prior?.lastCycle;
  let protocol: "v1" | "2.1" | undefined;
  let protocolVerifiedAt: number | undefined;
  let engineReadyAt: number | undefined;
  let startupVerifiedAt: number | undefined;
  let quotaState: Record<string, unknown> | undefined = prior?.quotaState;
  let stopping: string | null = null;
  let activeAbort: AbortController | null = null;
  let maintenanceHandoff = options.maintenanceHandoff === true;

  const put = (state: RunnerState, reason?: string, nextPollAt?: number): boolean =>
    writeStatus({
      schemaVersion: 2,
      pid: process.pid,
      version,
      runnerId: config.runnerId,
      engine: config.engine,
      ...(config.model ? { model: config.model } : {}),
      ...(protocol ? { protocol } : {}),
      ...(protocolVerifiedAt != null ? { protocolVerifiedAt } : {}),
      ...(engineReadyAt != null ? { engineReadyAt } : {}),
      ...(startupVerifiedAt != null ? { startupVerifiedAt } : {}),
      state,
      ...(reason ? { stateReason: reason } : {}),
      startedAt,
      updatedAt: Date.now(),
      ...(lastCycle ? { lastCycle } : {}),
      consecutiveFailures,
      sessionsToday,
      sessionDay,
      ...(nextPollAt != null ? { nextPollAt } : {}),
      ...(quotaState ? { quotaState } : {}),
    });
  const safeTerminalHeartbeat = async (
    state: RunnerState,
    reason?: string,
  ): Promise<void> => {
    const terminalCycle = reason ? upgradeHandoffStoppedCycle(reason) : lastCycle;
    try {
      await controlPoll(config, version, {
        state,
        ...(terminalCycle ? { lastCycle: terminalCycle } : {}),
        consecutiveFailures,
        sessionsToday,
        quotaState,
      });
    } catch {
      /* terminal heartbeat is best effort */
    }
  };
  const halt = async (reason: string): Promise<never> => {
    writeHalt(reason, consecutiveFailures);
    put("halted", reason);
    await safeTerminalHeartbeat("halted");
    log(`HALTED: ${reason} — run \`engager-agent doctor\`, then \`engager-agent resume\``);
    process.exit(service ? 0 : 1);
  };
  const stopForUpgradeTransition = async (reason: string): Promise<void> => {
    lastCycle = upgradeHandoffStoppedCycle(reason);
    put("stopped", reason);
    await safeTerminalHeartbeat("stopped", reason);
    log(`upgrade transition fenced runner safely: ${reason}`);
  };

  const existingHalt = readHalt();
  if (existingHalt) {
    if (service) await halt(existingHalt.reason);
    clearHalt();
    log(`manual run cleared prior halt: ${existingHalt.reason}`);
  }
  const onSignal = (signal: string): void => {
    stopping ??= signal;
    activeAbort?.abort();
    wake();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  log(`engager-agent ${version}: org runner ${config.runnerId}, engine ${config.engine}, fail-closed v2.1 control`);
  put("starting");

  for (;;) {
    if (stopping) {
      put("stopped", stopping);
      await safeTerminalHeartbeat("stopped");
      log(`received ${stopping} — clean shutdown`);
      process.exit(0);
    }
    if (!maintenanceHandoff) {
      const transitionReason = upgradeTransitionBlockReason();
      if (transitionReason) {
        await stopForUpgradeTransition(transitionReason);
        return;
      }
    }
    if (today() !== sessionDay) {
      sessionDay = today();
      sessionsToday = providerSessionsToday();
    }
    sessionsToday = providerSessionsToday();
    const pause = readPause();
    activeAbort = new AbortController();
    put(pause ? "paused-local" : "preflight", pause ? "paused locally" : undefined);
    let nextPollAt = Date.now() + controlTickDelayMs();
    try {
      const result = await runControlCycle(
        config,
        version,
        {
          state: pause ? "paused-local" : "preflight",
          ...(lastCycle ? { lastCycle } : {}),
          consecutiveFailures,
          sessionsToday,
          nextWakeAt: nextPollAt,
          quotaState,
        },
        {
          allowWork: !pause && !maintenanceHandoff,
          readinessOnly: maintenanceHandoff,
          executionFence: () => readUpgradeTransition() == null,
          signal: activeAbort.signal,
          onNegotiated: (
            negotiatedProtocol,
            negotiatedQuotaState,
            engineReady,
          ) => {
            const verifiedAt = Date.now();
            protocol = negotiatedProtocol;
            protocolVerifiedAt = verifiedAt;
            if (engineReady) engineReadyAt = verifiedAt;
            if (!service || engineReady) startupVerifiedAt ??= verifiedAt;
            quotaState = negotiatedQuotaState;
            const milestone = engineReady
              ? "current server negotiation and engine readiness verified"
              : "current server negotiation verified; engine is not ready";
            if (!put("preflight", milestone) && service) {
              throw new RunnerFault(
                "INTERNAL_ERROR",
                "durable startup negotiation milestone could not be persisted",
                {
                  impact: "No work was claimed because service startup could not be verified durably.",
                  recovery: "Repair ~/.engager ownership and disk health, then retry.",
                },
              );
            }
          },
        },
      );
      protocol = result.protocol;
      protocolVerifiedAt = Date.now();
      quotaState = result.quotaState;
      const outcome = result.outcome;
      lastCycle = cycleInfoFromOutcome(outcome);
      if (outcome.fatal) await halt(outcome.note);
      if (outcome.ok) consecutiveFailures = 0;
      else if (countsTowardHalt(outcome.errorCode)) consecutiveFailures += 1;
      if (outcome.nextPollAt != null) nextPollAt = Math.min(nextPollAt, outcome.nextPollAt);
      log(`${outcome.ok ? "cycle ok" : "cycle idle/failure"}: ${outcome.note}`);
    } catch (error) {
      const fault = asRunnerFault(error);
      lastCycle = {
        at: Date.now(),
        ran: false,
        ok: false,
        note: sanitizeTerminalText(fault.message).slice(0, 400),
        errorCode: fault.code,
      };
      if (faultCountsTowardHalt(fault)) consecutiveFailures += 1;
      quotaState = quotaStateForFault(fault);
      log(formatRunnerFault(fault));
    } finally {
      activeAbort = null;
      sessionsToday = providerSessionsToday();
    }
    if (maintenanceHandoff) {
      const commit = await waitForUpgradeTransitionCommit(
        options.handoffTimeoutMs,
        options.handoffWaitDeps,
      );
      if (!commit.ok) {
        lastCycle = upgradeHandoffStoppedCycle(commit.reason);
        put("stopped", commit.reason);
        await safeTerminalHeartbeat("stopped", commit.reason);
        log(`upgrade handoff stopped safely: ${commit.reason}`);
        return;
      }
      maintenanceHandoff = false;
      log("upgrade transition committed — normal work is now enabled");
      continue;
    }
    const transitionReason = upgradeTransitionBlockReason();
    if (transitionReason) {
      await stopForUpgradeTransition(transitionReason);
      return;
    }
    if (stopping) continue;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await halt(`${MAX_CONSECUTIVE_FAILURES} consecutive contract/execution failures`);
    }
    const state: RunnerState = readPause()
      ? "paused-local"
      : lastCycle?.errorCode === "CONTRACT_UPGRADE_REQUIRED"
        ? "upgrade-required"
        : lastCycle?.errorCode === "ENGINE_QUOTA" || lastCycle?.errorCode === "ENGINE_OVERLOADED"
          ? "quota-blocked"
          : lastCycle?.ok
            ? "sleeping"
            : "idle-remote";
    put(state, lastCycle?.ok ? undefined : lastCycle?.note, nextPollAt);
    await sleep(Math.max(1_000, nextPollAt - Date.now()));
  }
}

export function countsTowardHalt(code?: string): boolean {
  return new Set([
    "INTERNAL_ERROR",
    "VALIDATION_REJECTED",
    "ENGINE_OUTPUT_INVALID",
    "ENGINE_SANDBOX_DENIED",
    "CLOCK_SKEW",
  ]).has(code ?? "");
}

const STRUCTURAL_DISCARDED_FAILURES = new Set([
  "invalid_submission",
  "wrong_lane",
  "item_out_of_scope",
  "idempotency_conflict",
]);

/** Journal replay safety and the local failure circuit are independent. A
 * structurally invalid request must be discarded, but repeatedly producing it
 * still halts before consuming the user's provider allowance indefinitely. */
export function faultCountsTowardHalt(
  fault: Pick<RunnerFault, "code" | "discardJournal" | "remoteCode">,
): boolean {
  if (!countsTowardHalt(fault.code)) return false;
  return !fault.discardJournal || STRUCTURAL_DISCARDED_FAILURES.has(fault.remoteCode ?? "");
}

export function quotaStateForFault(fault: RunnerFault): Record<string, unknown> {
  if (fault.code === "ENGINE_QUOTA") {
    return quota("exhausted", "engine_quota", Date.now() + 60 * 60_000);
  }
  if (fault.code === "ENGINE_OVERLOADED") {
    return quota("unavailable", "engine_overloaded", Date.now() + 10 * 60_000);
  }
  if (fault.code === "ENGINE_NOT_FOUND" || fault.code === "ENGINE_AUTH_REQUIRED") {
    return quota("unavailable", fault.code.toLowerCase());
  }
  if (fault.code.startsWith("ENGINE_")) return quota("error", fault.code.toLowerCase());
  return quota("error", fault.code.toLowerCase());
}

export function cycleInfoFromOutcome(outcome: ExecutionOutcome, at = Date.now()): CycleInfo {
  return {
    at,
    ran: outcome.ran,
    ok: outcome.ok,
    note: sanitizeTerminalText(outcome.note).slice(0, 400),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.workOrderId ? { workOrderId: outcome.workOrderId } : {}),
    ...(outcome.lane ? { lane: outcome.lane } : {}),
    ...(outcome.completion
      ? {
          receipt: {
            status: outcome.completion.status,
            ...outcome.completion.result,
          },
        }
      : {}),
  };
}

export function upgradeHandoffStoppedCycle(
  reason: string,
  at = Date.now(),
): CycleInfo {
  return {
    at,
    ran: false,
    ok: false,
    note: sanitizeTerminalText(reason).slice(0, 400),
    errorCode: "INTERNAL_ERROR",
  };
}

export function upgradeTransitionBlockReason(): string | null {
  try {
    const transition = readUpgradeTransition();
    return transition
      ? `upgrade transition ${transition.target.version} remains pending at ${transition.phase}`
      : null;
  } catch (error) {
    return `upgrade transition journal is unsafe: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function activeQuotaBlock(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!value || typeof value.resetsAt !== "number" || value.resetsAt <= Date.now()) return null;
  if (value.reasonCode !== "engine_quota" && value.reasonCode !== "engine_overloaded") return null;
  return value;
}

let wakeFn: (() => void) | null = null;
function wake(): void {
  wakeFn?.();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeFn = null;
      resolve();
    }, ms);
    wakeFn = () => {
      clearTimeout(timer);
      wakeFn = null;
      resolve();
    };
  });
}
