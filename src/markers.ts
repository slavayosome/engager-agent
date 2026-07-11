import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";
import { writePrivateJsonDurably } from "./durable.js";

/**
 * On-disk control markers under ~/.engager. They exist so intent survives the
 * process: a HALT (deliberate stop — repeated failures, or the server said the
 * campaign is gone) must NOT be resurrected by launchd/login, and a local PAUSE
 * must hold across restarts until it expires or a human resumes.
 */

export type HaltMarker = { at: number; reason: string; consecutiveFailures?: number };
export type PauseMarker = { id?: string; at: number; until?: number };

export function haltPath(): string {
  return join(agentHome(), "halted.json");
}

export function pausePath(): string {
  return join(agentHome(), "paused.json");
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return CORRUPT;
  }
}

const CORRUPT = Symbol("corrupt-control-marker");

function writeJson(path: string, value: unknown): void {
  writePrivateJsonDurably(path, value);
}

export function writeHalt(reason: string, consecutiveFailures?: number): void {
  writeJson(haltPath(), {
    at: Date.now(),
    reason,
    ...(consecutiveFailures != null ? { consecutiveFailures } : {}),
  } satisfies HaltMarker);
}

export function readHalt(): HaltMarker | null {
  const value = readJson(haltPath());
  if (isHaltMarker(value)) return value;
  return value == null ? null : { at: 0, reason: "halt marker is corrupt; explicit resume required" };
}

export function clearHalt(): void {
  rmSync(haltPath(), { force: true });
}

export function writePause(until?: number): void {
  writeJson(pausePath(), {
    id: randomUUID(),
    at: Date.now(),
    ...(until != null ? { until } : {}),
  } satisfies PauseMarker);
}

/** Active pause, or null. An expired `until` clears the marker as a side effect. */
export function readPause(now: number = Date.now()): PauseMarker | null {
  const value = readJson(pausePath());
  if (value == null) return null;
  if (!isPauseMarker(value)) return { at: 0 };
  const m = value;
  if (m.until != null && m.until <= now) {
    // Do not unlink here: a concurrent `pause` can atomically replace the
    // expired file between this read and a delete. Leaving an inert expired
    // marker is harmless and prevents that new intent from being erased.
    return null;
  }
  return m;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isHaltMarker(value: unknown): value is HaltMarker {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.at) &&
    Number(value.at) >= 0 &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 1_000 &&
    (value.consecutiveFailures === undefined ||
      (Number.isSafeInteger(value.consecutiveFailures) && Number(value.consecutiveFailures) >= 0))
  );
}

function isPauseMarker(value: unknown): value is PauseMarker {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.at) &&
    Number(value.at) >= 0 &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200)) &&
    (value.until === undefined || (Number.isSafeInteger(value.until) && Number(value.until) >= 0))
  );
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
