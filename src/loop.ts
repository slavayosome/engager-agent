import { saveConfig, type AgentConfig } from "./config.js";
import { controlPoll, type HeartbeatState } from "./heartbeat.js";
import { log } from "./log.js";
import { clearHalt, readHalt, readPause, writeHalt } from "./markers.js";
import { EngagerMcp, type RunnerDirective } from "./mcp.js";
import {
  computeNeed,
  fmtTokens,
  runSession,
  type SessionResult,
  type SessionTokens,
  type WorkOrder,
} from "./session.js";
import { skillsRoot, syncSkill } from "./skills.js";
import { writeStatus, type CycleInfo, type RunnerState } from "./status.js";
import { snapshot, verifySession, type Verdict } from "./verify.js";

/**
 * The runner loop, on two cadences: a cheap CONTROL POLL every ~5 minutes (one
 * heartbeat → the server's run/idle/stop directive, plus local pause markers),
 * and a DRAFTING CYCLE every `intervalMinutes` when the directive allows.
 * Everything deterministic happens here with zero LLM cost: queue math, pool
 * top-up, reply listing, skill-hash verification. A headless agent session is
 * spawned only when there is real headroom, and its result is verified against
 * server state (never the transcript).
 *
 * Failure semantics ("never fail silently"):
 * - N consecutive failed cycles, a stop directive, or a fatal preflight → a
 *   DELIBERATE HALT: ~/.engager/halted.json is written and the process exits
 *   0 under --service (launchd's KeepAlive/SuccessfulExit=false leaves it
 *   down) or 1 when run manually. Only `engager-agent resume` or a manual
 *   start clears it.
 * - Crashes exit non-zero → launchd restarts them. Transient faults self-heal;
 *   deliberate halts stay down and visible.
 */

const MAX_CONSECUTIVE_FAILURES = 3;
const CONTROL_POLL_MS = 5 * 60_000;

/** The cadence a directive pushes: prefer the STABLE base from newer servers
 *  (their intervalMinutes is pre-jittered per wake window — persisting it would
 *  churn config every window). Positive numbers only; undefined = no opinion. */
export function pushedCadence(
  d: { intervalMinutes?: number | null; intervalMinutesBase?: number | null } | null,
): number | undefined {
  const v = d?.intervalMinutesBase ?? d?.intervalMinutes;
  return typeof v === "number" && v > 0 ? Math.round(v) : undefined;
}

/** Delay to the next drafting wake: proportional jitter (0.75–1.25× the
 *  cadence), never under a minute. A fixed ±5min on an hourly wake still lands
 *  near the same minute-marks — a bot signature visible through Unipile reads.
 *  Integer ms: floats in wake times lost every control poll on servers ≤0.3.1. */
export function nextWakeDelayMs(intervalMinutes: number, rand: () => number = Math.random): number {
  return Math.round(Math.max(60_000, intervalMinutes * 60_000 * (0.75 + rand() * 0.5)));
}

/** Delay to the next control tick (4–6.5 min): a heartbeat every 300.000s sharp
 *  is its own automation signature; isStale's 2×interval+10min window absorbs it. */
export function controlTickDelayMs(rand: () => number = Math.random): number {
  return Math.round(CONTROL_POLL_MS * (0.8 + rand() * 0.5));
}

export type CycleOutcome = {
  ran: boolean;
  ok: boolean;
  note: string;
  /** A permanent condition (campaign gone/server-led) — halt, don't retry. */
  fatal?: boolean;
  /** Kept for --json consumers; humans see tokens. */
  costUsd?: number;
  tokens?: SessionTokens;
};

/** Injection seam for the deterministic eval harness (evals/agent-runner) —
 *  production always uses the real MCP client + claude session. */
export type CycleDeps = {
  connect: (cfg: AgentConfig) => Promise<EngagerMcp>;
  session: typeof runSession;
  sync: typeof syncSkill;
};

const REAL_DEPS: CycleDeps = {
  connect: async (cfg) => {
    const mcp = new EngagerMcp(cfg.mcpUrl, cfg.apiKey);
    await mcp.connect();
    return mcp;
  },
  session: runSession,
  sync: syncSkill,
};

export async function runCycle(
  cfg: AgentConfig,
  opts: { batchOverride?: number } = {},
  deps: CycleDeps = REAL_DEPS,
): Promise<CycleOutcome> {
  const mcp = await deps.connect(cfg);
  try {
    // 0. Skill freshness — a stale skill is the top silent-failure source.
    const sync = await deps.sync(mcp, "engager-batch", skillsRoot(cfg.cli));
    if (sync.updated.length > 0) {
      log(`skill engager-batch ${sync.version}: refreshed ${sync.updated.join(", ")}`);
    }

    // 1. Cheap preflight (no LLM). Permanent conditions are FATAL — they mirror
    // the server's stop directive so old servers get the same halt behavior.
    const campaigns = await mcp.listCampaigns();
    const campaign = campaigns.find((c) => c.id === cfg.campaignId);
    if (!campaign) {
      return { ran: false, ok: false, fatal: true, note: `campaign ${cfg.campaignId} not found` };
    }
    if (campaign.status !== "active") {
      return { ran: false, ok: true, note: `campaign ${cfg.campaignId} is ${campaign.status} — idle` };
    }
    if (campaign.draftingMode !== "agent") {
      return {
        ran: false,
        ok: false,
        fatal: true,
        note: `campaign ${cfg.campaignId} is server-led — this runner only drives agent-led campaigns`,
      };
    }

    const pre = await mcp.campaignQueue(cfg.campaignId);
    const replies = await mcp.listIncoming(cfg.campaignId);
    const need = opts.batchOverride ?? computeNeed(pre, campaign, cfg.intervalMinutes);

    if (need === 0 && replies.length === 0) {
      return {
        ran: false,
        ok: true,
        note: `nothing to do — runway ${pre.runwayDays}d, pool ${pre.candidatePool.size}/${pre.candidatePool.target}`,
      };
    }

    // 2. Pool top-up (still no LLM) — the scheduled server sweeps are demand-
    // aware, but a same-hour top-up shortens a thin-pool session's discovery work.
    if (need > 0 && !pre.candidatePool.sufficient) {
      try {
        await mcp.discover(cfg.campaignId);
        log(`pool thin (${pre.candidatePool.size}/${pre.candidatePool.target}) — ran a top-up sweep`);
      } catch (e) {
        log(`top-up sweep failed (non-fatal): ${(e as Error).message}`);
      }
    }

    // 3. The agent session, with a fully-resolved work order.
    const order: WorkOrder = {
      campaignId: cfg.campaignId,
      batchSize: need,
      replyIds: replies.map((r) => r.id),
    };
    log(`session start: batch ${order.batchSize}, replies ${order.replyIds.length}, model ${cfg.model}`);
    const result = await deps.session(cfg, order);

    // 4. Verify against server state; a claimed-but-unlanded success FAILS.
    const post = await mcp.campaignQueue(cfg.campaignId);
    let verdict = verifySession(snapshot(pre), snapshot(post), result.summary, result.exitCode);
    logSession(result, verdict);
    let costUsd = result.costUsd;
    let tokens = result.tokens;

    // 5. One narrowed retry (batch size 1) when the failure mode warrants it.
    if (!verdict.ok && verdict.retryNarrowed && order.batchSize > 1) {
      log("retrying once, narrowed to batch size 1");
      const retry = await deps.session(cfg, { ...order, batchSize: 1, replyIds: [] });
      const post2 = await mcp.campaignQueue(cfg.campaignId);
      verdict = verifySession(snapshot(post), snapshot(post2), retry.summary, retry.exitCode);
      logSession(retry, verdict);
      costUsd = retry.costUsd ?? costUsd;
      tokens = retry.tokens ?? tokens;
    }

    return {
      ran: true,
      ok: verdict.ok,
      note: verdict.note,
      ...(costUsd != null ? { costUsd } : {}),
      ...(tokens ? { tokens } : {}),
    };
  } finally {
    await mcp.close();
  }
}

function logSession(result: SessionResult, verdict: Verdict): void {
  // Tokens, not dollars: on subscription auth the CLI's total_cost_usd is only
  // API-equivalent accounting, and reads as a bill when it isn't one.
  const usage = result.tokens ? ` · ${fmtTokens(result.tokens)}` : "";
  log(
    `session done in ${Math.round(result.durationMs / 1000)}s${usage} · ${
      verdict.ok ? "OK" : "FAILED"
    } — ${verdict.note}`,
  );
  if (!verdict.ok && result.summary == null) {
    log(`transcript tail: ${result.rawResult.slice(-600)}`);
  }
}

export type LoopOpts = {
  /** Running under launchd: deliberate halts exit 0 so KeepAlive leaves us down. */
  service?: boolean;
  version?: string;
};

export async function runLoop(cfg: AgentConfig, opts: LoopOpts = {}): Promise<never> {
  const service = opts.service ?? false;
  const version = opts.version ?? "0";
  const startedAt = Date.now();

  let consecutiveFailures = 0;
  let sessionsToday = 0;
  let day = new Date().toISOString().slice(0, 10);
  let lastCycle: CycleInfo | undefined;
  let lastCostUsd: number | undefined;
  let lastTokens: SessionTokens | undefined;
  let nextCycleAt = Date.now(); // first drafting cycle as soon as the directive allows
  let stopping: string | null = null;

  const hbState = (state: RunnerState): HeartbeatState => ({
    state,
    ...(lastCycle ? { lastCycle } : {}),
    consecutiveFailures,
    sessionsToday,
    nextWakeAt: nextCycleAt,
  });
  /** Fire-and-forget heartbeat for terminal states (halt/stop). */
  const safePoll = async (state: RunnerState): Promise<void> => {
    try {
      await controlPoll(cfg, version, hbState(state));
    } catch {
      /* best-effort */
    }
  };
  const put = (state: RunnerState, reason?: string, nextWakeAt?: number): void => {
    writeStatus({
      pid: process.pid,
      version,
      ...(cfg.runnerId ? { runnerId: cfg.runnerId } : {}),
      campaignId: cfg.campaignId,
      model: cfg.model,
      state,
      ...(reason ? { stateReason: reason } : {}),
      startedAt,
      updatedAt: Date.now(),
      ...(lastCycle ? { lastCycle } : {}),
      consecutiveFailures,
      sessionsToday,
      ...(nextWakeAt != null ? { nextWakeAt } : {}),
      ...(lastCostUsd != null ? { lastSessionCostUsd: lastCostUsd } : {}),
      ...(lastTokens ? { lastSessionTokens: lastTokens } : {}),
    });
  };
  const haltLoudly = async (reason: string): Promise<never> => {
    writeHalt(reason, consecutiveFailures);
    put("halted", reason);
    await safePoll("halted");
    log(
      `HALTED: ${reason} — will not restart on its own. Check ~/.engager/logs, then: engager-agent resume`,
    );
    process.exit(service ? 0 : 1);
  };

  // A prior deliberate halt must never be silently resumed by launchd/login.
  const halt = readHalt();
  if (halt) {
    if (service) {
      log(`still halted (${halt.reason}, since ${new Date(halt.at).toISOString()}) — run: engager-agent resume`);
      put("halted", halt.reason);
      await safePoll("halted");
      process.exit(0);
    }
    clearHalt(); // a manual start is explicit consent to resume
    log(`previous halt cleared by manual start (was: ${halt.reason})`);
  }

  const onSignal = (sig: string): void => {
    if (stopping) process.exit(130); // second signal: force
    stopping = sig;
    wake();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  log(
    `engager-agent loop: campaign ${cfg.campaignId}, drafting every ~${cfg.intervalMinutes}min, ` +
      `control poll every ${Math.round(CONTROL_POLL_MS / 60_000)}min, ` +
      `daily session cap ${cfg.dailySessionCap}, model ${cfg.model}${service ? ", service mode" : ""}`,
  );
  put("starting");

  for (;;) {
    if (stopping) {
      put("stopped", stopping);
      await safePoll("stopped");
      log(`received ${stopping} — clean shutdown`);
      process.exit(0);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      sessionsToday = 0;
    }

    // 1. Control poll: heartbeat out, directive back. A failed poll is NOT a
    // failed cycle — keep the last known intent and try again next tick.
    const paused = readPause();
    let directive: RunnerDirective | null = null;
    try {
      directive = await controlPoll(cfg, version, hbState(paused ? "paused-local" : "sleeping"));
    } catch (e) {
      log(`control poll failed (non-fatal): ${(e as Error).message}`);
    }
    if (directive?.directive === "stop") await haltLoudly(`server: ${directive.reason}`);

    // Adopt a server-authored wake cadence (campaign.agentIntervalMinutes set via
    // update_campaign / the dashboard) — persisted so restarts keep it. Never let
    // an already-scheduled far-away wake outlive a shortened cadence.
    const pushed = pushedCadence(directive);
    if (pushed !== undefined && pushed !== cfg.intervalMinutes) {
      const next = pushed;
      log(`server set wake cadence: every ${next} min (was ${cfg.intervalMinutes}) — adopting`);
      cfg = { ...cfg, intervalMinutes: next };
      try {
        saveConfig(cfg);
      } catch (e) {
        log(`could not persist cadence (non-fatal): ${(e as Error).message}`);
      }
      nextCycleAt = Math.min(nextCycleAt, Math.round(Date.now() + next * 60_000));
    }

    const idleReason = paused
      ? `paused locally${paused.until ? ` until ${new Date(paused.until).toLocaleString()}` : ""} — resume with: engager-agent resume`
      : directive?.directive === "idle"
        ? `server: ${directive.reason}`
        : sessionsToday >= cfg.dailySessionCap
          ? `daily session cap reached (${cfg.dailySessionCap}) — resets at midnight`
          : null;

    // 2. Drafting cycle, when due and allowed.
    if (!idleReason && Date.now() >= nextCycleAt) {
      put("session");
      try {
        const outcome = await runCycle(cfg);
        lastCycle = { at: Date.now(), ran: outcome.ran, ok: outcome.ok, note: outcome.note };
        if (outcome.costUsd != null) lastCostUsd = outcome.costUsd;
        if (outcome.tokens) lastTokens = outcome.tokens;
        if (outcome.fatal) await haltLoudly(outcome.note);
        if (outcome.ran) sessionsToday += 1;
        if (!outcome.ok) {
          consecutiveFailures += 1;
          log(`cycle FAILED (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${outcome.note}`);
        } else {
          consecutiveFailures = 0;
          log(`cycle ok: ${outcome.note}`);
        }
      } catch (e) {
        consecutiveFailures += 1;
        lastCycle = { at: Date.now(), ran: false, ok: false, note: (e as Error).message };
        log(
          `cycle ERROR (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(e as Error).message}`,
        );
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await haltLoudly(`${MAX_CONSECUTIVE_FAILURES} consecutive failed cycles`);
      }
      nextCycleAt = Date.now() + nextWakeDelayMs(cfg.intervalMinutes);
      log(`next drafting cycle ~${Math.round((nextCycleAt - Date.now()) / 60_000)} min`);
    } else if (idleReason) {
      log(`idle: ${idleReason}`);
    }

    const state: RunnerState = paused
      ? "paused-local"
      : directive?.directive === "idle"
        ? "idle-remote"
        : "sleeping";
    put(state, idleReason ?? undefined, Math.min(nextCycleAt, Date.now() + CONTROL_POLL_MS));
    await sleep(controlTickDelayMs());
  }
}

// Wakeable sleep so a shutdown signal doesn't wait out a 5-minute tick.
let wakeFn: (() => void) | null = null;
function wake(): void {
  wakeFn?.();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wakeFn = null;
      resolve();
    }, ms);
    wakeFn = () => {
      clearTimeout(t);
      wakeFn = null;
      resolve();
    };
  });
}
