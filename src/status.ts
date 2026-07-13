import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerLane } from "@engager/runner-contract";
import { agentHome } from "./config.js";
import { writePrivateJsonDurably } from "./durable.js";
import type { EngineName } from "./engine.js";
import { sanitizeTerminalText } from "./errors.js";

export type RunnerState =
  | "starting"
  | "preflight"
  | "session"
  | "sleeping"
  | "idle-remote"
  | "quota-blocked"
  | "upgrade-required"
  | "paused-local"
  | "halted"
  | "stopped";

export type CycleInfo = {
  at: number;
  ran: boolean;
  ok: boolean;
  note: string;
  errorCode?: string;
  workOrderId?: string;
  lane?: RunnerLane;
  receipt?: {
    status: "completed" | "partial" | "failed";
    accepted: number;
    alreadyExists: number;
    rejected: number;
    failed: number;
    unfinished: number;
  };
};

export type RunnerStatus = {
  schemaVersion: 2;
  pid: number;
  version: string;
  runnerId: string;
  engine: EngineName;
  model?: string;
  protocol?: "v1" | "2.1";
  protocolVerifiedAt?: number;
  /** Durable proof that this exact process verified the configured engine. */
  engineReadyAt?: number;
  /** Durable proof that this exact process negotiated before claiming work. */
  startupVerifiedAt?: number;
  state: RunnerState;
  stateReason?: string;
  startedAt: number;
  updatedAt: number;
  lastCycle?: CycleInfo;
  consecutiveFailures: number;
  sessionsToday: number;
  sessionDay: string;
  nextPollAt?: number;
  quotaState?: Record<string, unknown>;
  lastSessionTokens?: { input?: number; output?: number };
};

export function statusPath(): string {
  return join(agentHome(), "status.json");
}

/** Public local health only. Lease tokens and active submissions live in the 0600 journal. */
export function writeStatus(status: RunnerStatus): boolean {
  try {
    mkdirSync(agentHome(), { recursive: true, mode: 0o700 });
    chmodSync(agentHome(), 0o700);
    writePrivateJsonDurably(statusPath(), sanitizeStatus({ ...status, updatedAt: Date.now() }));
    return true;
  } catch {
    /* health output is best effort; protocol authority stays server-side */
    return false;
  }
}

export function readStatus(): RunnerStatus | null {
  if (!existsSync(statusPath())) return null;
  try {
    const value = JSON.parse(readFileSync(statusPath(), "utf8")) as Partial<RunnerStatus>;
    return value.schemaVersion === 2 && typeof value.pid === "number"
      ? sanitizeStatus(value as RunnerStatus)
      : null;
  } catch {
    return null;
  }
}

function sanitizeStatus(status: RunnerStatus): RunnerStatus {
  return {
    ...status,
    ...(status.stateReason
      ? { stateReason: sanitizeTerminalText(status.stateReason).slice(0, 400) }
      : {}),
    ...(status.lastCycle
      ? {
          lastCycle: {
            ...status.lastCycle,
            note: sanitizeTerminalText(status.lastCycle.note).slice(0, 400),
          },
        }
      : {}),
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function localSessionCount(now = new Date()): number {
  const status = readStatus();
  const day = now.toISOString().slice(0, 10);
  return status?.sessionDay === day ? status.sessionsToday : 0;
}
