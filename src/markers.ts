import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";

/**
 * On-disk control markers under ~/.engager. They exist so intent survives the
 * process: a HALT (deliberate stop — repeated failures, or the server said the
 * campaign is gone) must NOT be resurrected by launchd/login, and a local PAUSE
 * must hold across restarts until it expires or a human resumes.
 */

export type HaltMarker = { at: number; reason: string; consecutiveFailures?: number };
export type PauseMarker = { at: number; until?: number };

export function haltPath(): string {
  return join(agentHome(), "halted.json");
}

export function pausePath(): string {
  return join(agentHome(), "paused.json");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // a corrupt marker must never wedge the CLI
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(agentHome(), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeHalt(reason: string, consecutiveFailures?: number): void {
  writeJson(haltPath(), {
    at: Date.now(),
    reason,
    ...(consecutiveFailures != null ? { consecutiveFailures } : {}),
  } satisfies HaltMarker);
}

export function readHalt(): HaltMarker | null {
  return readJson<HaltMarker>(haltPath());
}

export function clearHalt(): void {
  rmSync(haltPath(), { force: true });
}

export function writePause(until?: number): void {
  writeJson(pausePath(), { at: Date.now(), ...(until != null ? { until } : {}) } satisfies PauseMarker);
}

/** Active pause, or null. An expired `until` clears the marker as a side effect. */
export function readPause(now: number = Date.now()): PauseMarker | null {
  const m = readJson<PauseMarker>(pausePath());
  if (!m) return null;
  if (m.until != null && m.until <= now) {
    clearPause();
    return null;
  }
  return m;
}

export function clearPause(): void {
  rmSync(pausePath(), { force: true });
}

/** Parse a human duration like "30m", "2h", "1d" into ms (null = unparseable). */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms = unit.startsWith("m") ? n * 60_000 : unit.startsWith("h") ? n * 3_600_000 : n * 86_400_000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
