import { hostname } from "node:os";
import type { AgentConfig } from "./config.js";
import { log } from "./log.js";
import {
  EngagerMcp,
  type CampaignRow,
  type HeartbeatPayload,
  type OpsSummary,
  type RunnerDirective,
} from "./mcp.js";
import type { CycleInfo, RunnerState } from "./status.js";

/**
 * The control channel: every poll sends one report_runner_status heartbeat and
 * returns the server's directive (run/idle/stop). Older servers without the
 * tool fall back to client-computed intent from list_campaigns + get_ops_summary
 * — same semantics, two reads instead of one write.
 */

/** Once the server says the tool doesn't exist, stop retrying it this process. */
let reportSupported: boolean | null = null;

export type HeartbeatState = {
  state: RunnerState;
  lastCycle?: CycleInfo;
  consecutiveFailures: number;
  sessionsToday: number;
  nextWakeAt?: number;
};

export function buildHeartbeat(
  cfg: AgentConfig,
  version: string,
  s: HeartbeatState,
): HeartbeatPayload {
  // The server schema wants integer epoch-ms; jittered wake times are floats
  // (±5min × Math.random()) — round EVERY numeric field at this boundary so no
  // upstream arithmetic can ever bounce a heartbeat off input validation.
  return {
    runnerId: cfg.runnerId ?? "unknown",
    state: s.state,
    hostname: hostname(),
    version,
    campaignId: cfg.campaignId,
    intervalMinutes: Math.round(cfg.intervalMinutes),
    ...(s.lastCycle
      ? {
          lastCycleAt: Math.round(s.lastCycle.at),
          lastOutcome: { ran: s.lastCycle.ran, ok: s.lastCycle.ok, note: s.lastCycle.note },
        }
      : {}),
    consecutiveFailures: Math.round(s.consecutiveFailures),
    sessionsToday: Math.round(s.sessionsToday),
    ...(s.nextWakeAt != null ? { nextWakeAt: Math.round(s.nextWakeAt) } : {}),
  };
}

const isUnknownTool = (e: unknown): boolean =>
  /not found|unknown tool|no such tool|-32601/i.test((e as Error).message ?? "");

/** Client-side mirror of the server's computeDirective, for pre-directive servers. */
export function fallbackDirective(
  campaign: CampaignRow | undefined,
  ops: OpsSummary | null,
  now: number,
): RunnerDirective {
  if (!campaign) return { directive: "stop", reason: "campaign not found (deleted?)" };
  if (campaign.status === "archived") return { directive: "stop", reason: "campaign is archived" };
  if (campaign.draftingMode !== "agent") {
    return { directive: "stop", reason: "campaign is server-led — runner not needed" };
  }
  if (ops?.killSwitch) return { directive: "idle", reason: "kill switch is ON" };
  if (ops?.pausedUntil != null && ops.pausedUntil > now) {
    return { directive: "idle", reason: `org paused${ops.pausedReason ? `: ${ops.pausedReason}` : ""}` };
  }
  if (campaign.status !== "active") {
    return { directive: "idle", reason: `campaign is ${campaign.status}` };
  }
  return { directive: "run", reason: "ok" };
}

/**
 * One control poll over a fresh connection. Throws on connection failure — the
 * loop treats that as "no directive" and keeps its last known intent (a network
 * blip must not stop or restart anything).
 */
export async function controlPoll(
  cfg: AgentConfig,
  version: string,
  s: HeartbeatState,
): Promise<RunnerDirective> {
  const mcp = new EngagerMcp(cfg.mcpUrl, cfg.apiKey);
  await mcp.connect();
  try {
    return await pollWith(mcp, cfg, version, s);
  } finally {
    await mcp.close();
  }
}

/** Same as controlPoll but over an already-open connection (used by runCycle). */
export async function pollWith(
  mcp: EngagerMcp,
  cfg: AgentConfig,
  version: string,
  s: HeartbeatState,
): Promise<RunnerDirective> {
  if (reportSupported !== false) {
    try {
      const d = await mcp.reportStatus(buildHeartbeat(cfg, version, s));
      reportSupported = true;
      return d;
    } catch (e) {
      if (!isUnknownTool(e)) throw e;
      reportSupported = false;
      log("server has no report_runner_status tool (older server) — using client-side checks");
    }
  }
  const campaigns = await mcp.listCampaigns();
  const campaign = campaigns.find((c) => c.id === cfg.campaignId);
  let ops: OpsSummary | null = null;
  try {
    ops = await mcp.opsSummary();
  } catch {
    /* feed:read should include it, but a missing tool must not break the poll */
  }
  return fallbackDirective(campaign, ops, Date.now());
}

/** Test seam: reset the per-process tool-support memo. */
export function resetHeartbeatSupport(): void {
  reportSupported = null;
}
