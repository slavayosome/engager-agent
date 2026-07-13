import { hostname } from "node:os";
import {
  RunnerHeartbeatInputSchema,
  type RunnerHeartbeatInput,
} from "@engager/runner-contract";
import type { AgentConfig } from "./config.js";
import { EngagerMcp } from "./mcp.js";
import { RUNNER_SUPPORTED_VERSION, type NegotiatedDirective } from "./protocol.js";
import type { CycleInfo, RunnerState } from "./status.js";

export type HeartbeatState = {
  state: RunnerState;
  lastCycle?: CycleInfo;
  consecutiveFailures: number;
  sessionsToday: number;
  nextWakeAt?: number;
  quotaState?: Record<string, unknown>;
};

export function buildHeartbeat(
  config: AgentConfig,
  version: string,
  state: HeartbeatState,
): RunnerHeartbeatInput {
  const wireState =
    state.state === "upgrade-required" || state.state === "quota-blocked"
      ? "idle-remote"
      : state.state;
  return RunnerHeartbeatInputSchema.parse({
    runnerId: config.runnerId,
    state: wireState,
    hostname: hostname(),
    version,
    supportedVersion: RUNNER_SUPPORTED_VERSION,
    engine: config.engine,
    ...(state.quotaState ? { quotaState: state.quotaState } : {}),
    // These two fields exist only so a migrated 0.8.x install can serve an org
    // that has not entered the v2 cohort yet. The v2 server ignores them for
    // assignment and cadence.
    ...(config.legacy
      ? {
          campaignId: config.legacy.campaignId,
          intervalMinutes: config.legacy.intervalMinutes,
        }
      : {}),
    ...(state.lastCycle
      ? {
          lastCycleAt: Math.round(state.lastCycle.at),
          lastOutcome: {
            ran: state.lastCycle.ran,
            ok: state.lastCycle.ok,
            note: state.lastCycle.note,
          },
        }
      : {}),
    consecutiveFailures: Math.round(state.consecutiveFailures),
    sessionsToday: Math.round(state.sessionsToday),
    ...(state.nextWakeAt != null ? { nextWakeAt: Math.round(state.nextWakeAt) } : {}),
  });
}

export async function connectAndNegotiate(
  config: AgentConfig,
  version: string,
  state: HeartbeatState,
  signal?: AbortSignal,
): Promise<{ mcp: EngagerMcp; negotiated: NegotiatedDirective }> {
  const mcp = new EngagerMcp(
    config.mcpUrl,
    config.apiKey,
    version,
    undefined,
    signal,
  );
  try {
    const negotiated = await mcp.negotiate(buildHeartbeat(config, version, state));
    return { mcp, negotiated };
  } catch (error) {
    await mcp.close();
    throw error;
  }
}

export async function controlPoll(
  config: AgentConfig,
  version: string,
  state: HeartbeatState,
): Promise<NegotiatedDirective> {
  const { mcp, negotiated } = await connectAndNegotiate(config, version, state);
  try {
    return negotiated;
  } finally {
    await mcp.close();
  }
}
