import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentHome, loadConfig, loadPartialConfig } from "./config.js";
import { asRunnerFault, sanitizeSensitiveText, type RunnerErrorCode } from "./errors.js";

/** Console + daily file log (~/.engager/logs/YYYY-MM-DD.log). */
export function log(message: string): void {
  const now = new Date();
  const line = `[${now.toISOString()}] ${sanitizeSensitiveText(message, redactionSecrets())}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const dir = join(agentHome(), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, `${now.toISOString().slice(0, 10)}.log`);
    appendFileSync(path, line + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    /* file logging is best-effort */
  }
}

export type RunnerEventName =
  | "lifecycle.result"
  | "upgrade.result"
  | "disconnect.transition"
  | "disconnect.result"
  | "cycle.fault"
  | "cli.fault";

export type RunnerEvent = {
  event: RunnerEventName;
  level: "info" | "warn" | "error";
  code?: RunnerErrorCode;
  reference?: string;
  runnerId?: string;
  workOrderId?: string;
  lane?: string;
  phase?: string;
  detail?: string;
};

/** Machine-readable observability is deliberately a narrow, secret-free seam.
 * Unknown caller strings are redacted, flattened, and bounded before JSONL. */
export function logEvent(event: RunnerEvent): void {
  const now = new Date();
  const secrets = redactionSecrets();
  const clean = (value: string, max = 400): string =>
    sanitizeSensitiveText(value, secrets).slice(0, max);
  const record = {
    schemaVersion: 1,
    at: now.toISOString(),
    event: event.event,
    level: event.level,
    ...(event.code ? { code: event.code } : {}),
    ...(event.reference ? { reference: clean(event.reference, 100) } : {}),
    ...(event.runnerId ? { runnerId: clean(event.runnerId, 200) } : {}),
    ...(event.workOrderId ? { workOrderId: clean(event.workOrderId, 200) } : {}),
    ...(event.lane ? { lane: clean(event.lane, 100) } : {}),
    ...(event.phase ? { phase: clean(event.phase, 100) } : {}),
    ...(event.detail ? { detail: clean(event.detail) } : {}),
  };
  try {
    const dir = join(agentHome(), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, `events-${now.toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    /* structured logging is best-effort and never carries protocol authority */
  }
}

export function redactionSecrets(): readonly (string | undefined)[] {
  try {
    const complete = loadConfig();
    const partial = loadPartialConfig();
    return [
      complete?.apiKey,
      partial?.apiKey,
      partial?.pendingDeviceAck?.deviceCode,
      partial?.pendingDeviceAck?.ackToken,
    ];
  } catch {
    return [];
  }
}

export function logFaultEvent(
  event: Extract<RunnerEventName, "cycle.fault" | "cli.fault">,
  error: unknown,
  context: Omit<RunnerEvent, "event" | "level" | "code" | "reference" | "detail"> = {},
): void {
  const fault = asRunnerFault(error);
  logEvent({
    event,
    level: "error",
    code: fault.code,
    reference: fault.reference,
    detail: fault.message,
    ...context,
  });
}
