import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";

/**
 * ~/.engager/status.json — the loop's live state, written atomically at every
 * transition. This is the LOCAL half of the status surface (an interactive
 * Claude Code session reads it or runs `engager-agent status`); the hosted half
 * is the report_runner_status heartbeat, which carries the same fields.
 */

export type RunnerState =
  | "starting"
  | "preflight"
  | "session"
  | "sleeping"
  | "idle-remote"
  | "paused-local"
  | "halted"
  | "stopped";

export type CycleInfo = { at: number; ran: boolean; ok: boolean; note: string };

export type RunnerStatus = {
  pid: number;
  version: string;
  runnerId?: string;
  campaignId: number;
  model: string;
  state: RunnerState;
  /** Why the runner is idling/halted (directive reason, pause, failures). */
  stateReason?: string;
  startedAt: number;
  updatedAt: number;
  lastCycle?: CycleInfo;
  consecutiveFailures: number;
  sessionsToday: number;
  nextWakeAt?: number;
  lastSessionCostUsd?: number;
};

export function statusPath(): string {
  return join(agentHome(), "status.json");
}

/** Atomic write (tmp + rename) — a reader never sees a torn file. */
export function writeStatus(status: RunnerStatus): void {
  try {
    mkdirSync(agentHome(), { recursive: true });
    const tmp = statusPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify({ ...status, updatedAt: Date.now() }, null, 2) + "\n");
    renameSync(tmp, statusPath());
  } catch {
    /* status is best-effort — never take the loop down over it */
  }
}

export function readStatus(): RunnerStatus | null {
  if (!existsSync(statusPath())) return null;
  try {
    return JSON.parse(readFileSync(statusPath(), "utf8")) as RunnerStatus;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
