import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentHome } from "./config.js";
import { writePrivateJsonDurably } from "./durable.js";
import { RunnerFault } from "./errors.js";

const SessionUsageSchema = z
  .object({
    schemaVersion: z.literal(1),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    attemptIds: z.array(z.string().uuid()).max(100),
  })
  .strict();

type SessionUsage = z.infer<typeof SessionUsageSchema>;

export function sessionUsagePath(): string {
  return join(agentHome(), "session-usage.json");
}

/** Reserve one provider session before process spawn. The UUID makes retries
 * idempotent, while a new retry receives a new UUID and therefore a new debit. */
export function reserveProviderSession(
  attemptId: string = randomUUID(),
  startedAt: number = Date.now(),
): number {
  const id = z.string().uuid().parse(attemptId);
  const day = utcDay(startedAt);
  const current = readUsage();
  const attemptIds = current?.day === day ? [...current.attemptIds] : [];
  if (!attemptIds.includes(id)) attemptIds.push(id);
  if (attemptIds.length > 100) throw usageFault("provider session ledger exceeded its hard bound");
  writeUsage({ schemaVersion: 1, day, attemptIds });
  return attemptIds.length;
}

export function providerSessionsToday(now: number = Date.now()): number {
  const current = readUsage();
  return current?.day === utcDay(now) ? current.attemptIds.length : 0;
}

function utcDay(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw usageFault("provider session timestamp is invalid");
  return new Date(value).toISOString().slice(0, 10);
}

function readUsage(): SessionUsage | null {
  const path = sessionUsagePath();
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || !owned || (stat.mode & 0o777) !== 0o600) {
      throw new Error("provider session ledger permissions are not private");
    }
    return SessionUsageSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw usageFault("provider session ledger is corrupt or unsafe", error);
  }
}

function writeUsage(value: SessionUsage): void {
  const parsed = SessionUsageSchema.parse(value);
  writePrivateJsonDurably(sessionUsagePath(), parsed);
}

function usageFault(message: string, cause?: unknown): RunnerFault {
  return new RunnerFault("ENGINE_SANDBOX_DENIED", message, {
    impact: "No provider process was started because its crash-safe local debit could not be proven.",
    recovery: "Repair ~/.engager/session-usage.json permissions or move the corrupt file aside, then rerun setup.",
    cause,
  });
}
