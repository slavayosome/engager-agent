import type { AgentConfig } from "./config.js";
import { log } from "./log.js";
import { EngagerMcp } from "./mcp.js";
import { computeNeed, runSession, type SessionResult, type WorkOrder } from "./session.js";
import { skillsRoot, syncSkill } from "./skills.js";
import { snapshot, verifySession, type Verdict } from "./verify.js";

/**
 * The hourly loop. Everything deterministic happens HERE with zero LLM cost:
 * queue math, pool top-up, reply listing, skill-hash verification. A headless
 * agent session is spawned only when there is real headroom, and its result is
 * verified against server state (never the transcript). N consecutive failed
 * cycles stop the loop loudly — a silently failing runner is the one outcome
 * this design refuses to allow.
 */

const MAX_CONSECUTIVE_FAILURES = 3;

export type CycleOutcome = { ran: boolean; ok: boolean; note: string };

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

    // 1. Cheap preflight (no LLM).
    const campaigns = await mcp.listCampaigns();
    const campaign = campaigns.find((c) => c.id === cfg.campaignId);
    if (!campaign) return { ran: false, ok: false, note: `campaign ${cfg.campaignId} not found` };
    if (campaign.status !== "active") {
      return { ran: false, ok: true, note: `campaign ${cfg.campaignId} is ${campaign.status} — idle` };
    }
    if (campaign.draftingMode !== "agent") {
      return {
        ran: false,
        ok: false,
        note: `campaign ${cfg.campaignId} is server-led — this runner only drives agent-led campaigns`,
      };
    }

    const pre = await mcp.campaignQueue(cfg.campaignId);
    const replies = await mcp.listIncoming(cfg.campaignId);
    const need = opts.batchOverride ?? computeNeed(pre, campaign);

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

    // 5. One narrowed retry (batch size 1) when the failure mode warrants it.
    if (!verdict.ok && verdict.retryNarrowed && order.batchSize > 1) {
      log("retrying once, narrowed to batch size 1");
      const retry = await deps.session(cfg, { ...order, batchSize: 1, replyIds: [] });
      const post2 = await mcp.campaignQueue(cfg.campaignId);
      verdict = verifySession(snapshot(post), snapshot(post2), retry.summary, retry.exitCode);
      logSession(retry, verdict);
    }

    return { ran: true, ok: verdict.ok, note: verdict.note };
  } finally {
    await mcp.close();
  }
}

function logSession(result: SessionResult, verdict: Verdict): void {
  const cost = result.costUsd != null ? ` · $${result.costUsd.toFixed(2)}` : "";
  log(
    `session done in ${Math.round(result.durationMs / 1000)}s${cost} · ${
      verdict.ok ? "OK" : "FAILED"
    } — ${verdict.note}`,
  );
  if (!verdict.ok && result.summary == null) {
    log(`transcript tail: ${result.rawResult.slice(-600)}`);
  }
}

export async function runLoop(cfg: AgentConfig): Promise<never> {
  let consecutiveFailures = 0;
  let sessionsToday = 0;
  let day = new Date().toISOString().slice(0, 10);

  log(
    `engager-agent loop: campaign ${cfg.campaignId}, every ~${cfg.intervalMinutes}min, ` +
      `daily session cap ${cfg.dailySessionCap}, model ${cfg.model}`,
  );

  for (;;) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      sessionsToday = 0;
    }

    try {
      if (sessionsToday >= cfg.dailySessionCap) {
        log(`daily session cap reached (${cfg.dailySessionCap}) — idling until midnight`);
      } else {
        const outcome = await runCycle(cfg);
        if (outcome.ran) sessionsToday += 1;
        if (!outcome.ok) {
          consecutiveFailures += 1;
          log(`cycle FAILED (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${outcome.note}`);
        } else {
          consecutiveFailures = 0;
          log(`cycle ok: ${outcome.note}`);
        }
      }
    } catch (e) {
      consecutiveFailures += 1;
      log(
        `cycle ERROR (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(e as Error).message}`,
      );
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(
        `${MAX_CONSECUTIVE_FAILURES} consecutive failed cycles — stopping so this cannot fail silently. ` +
          `Check ~/.engager/logs, then restart with: engager-agent`,
      );
      process.exit(1);
    }

    const jitter = (Math.random() - 0.5) * 10 * 60_000; // ±5 min
    const delay = Math.max(60_000, cfg.intervalMinutes * 60_000 + jitter);
    log(`next wake in ~${Math.round(delay / 60_000)} min`);
    await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
