import { randomUUID } from "node:crypto";

/** Stable customer-facing failures. Keep these codes compatible across CLI releases. */
export const RUNNER_ERROR_CODES = [
  "AUTH_REVOKED",
  "ENGINE_NOT_FOUND",
  "ENGINE_UNSUPPORTED_VERSION",
  "ENGINE_AUTH_REQUIRED",
  "ENGINE_QUOTA",
  "ENGINE_OVERLOADED",
  "ENGINE_NETWORK",
  "ENGINE_TIMEOUT",
  "ENGINE_OUTPUT_INVALID",
  "ENGINE_SANDBOX_DENIED",
  "ENGINE_CONTEXT_LIMIT",
  "ENGINE_FAILED",
  "CONTRACT_UPGRADE_REQUIRED",
  "SERVER_UNREACHABLE",
  "CLOCK_SKEW",
  "LEASE_LOST",
  "VALIDATION_REJECTED",
  "SERVICE_ENTRY_MISSING",
  "RUNNER_ALREADY_ACTIVE",
  "RUNNER_NOT_CONFIGURED",
  "RUNNER_PAUSED",
  "INTERNAL_ERROR",
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export type RunnerFaultOptions = {
  impact: string;
  recovery: string;
  retryable?: boolean;
  reference?: string;
  cause?: unknown;
  remoteCode?: string;
  discardJournal?: boolean;
  engineAttempted?: boolean;
};

export class RunnerFault extends Error {
  readonly code: RunnerErrorCode;
  readonly impact: string;
  readonly recovery: string;
  readonly retryable: boolean;
  readonly reference: string;
  readonly remoteCode?: string;
  readonly discardJournal: boolean;
  readonly engineAttempted: boolean;

  constructor(code: RunnerErrorCode, message: string, options: RunnerFaultOptions) {
    super(message, { cause: options.cause });
    this.name = "RunnerFault";
    this.code = code;
    this.impact = options.impact;
    this.recovery = options.recovery;
    this.retryable = options.retryable ?? false;
    this.reference = options.reference ?? randomUUID();
    this.remoteCode = options.remoteCode;
    this.discardJournal = options.discardJournal ?? false;
    this.engineAttempted = options.engineAttempted ?? false;
  }
}

export function asRunnerFault(error: unknown): RunnerFault {
  if (error instanceof RunnerFault) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RunnerFault("INTERNAL_ERROR", message || "runner operation failed", {
    impact: "The current runner action stopped before it could be verified.",
    recovery: "Run `engager-agent doctor`; retry only after the reported problem is resolved.",
    cause: error,
  });
}

export function formatRunnerFault(error: unknown): string {
  const fault = asRunnerFault(error);
  return [
    `${fault.code}${fault.remoteCode ? `/${fault.remoteCode}` : ""}: ${sanitizeTerminalText(fault.message)}`,
    `Impact: ${sanitizeTerminalText(fault.impact)}`,
    `Fix: ${sanitizeTerminalText(fault.recovery)}`,
    `Reference: ${sanitizeTerminalText(fault.reference)}`,
  ].join("\n");
}

export function markEngineAttempted(error: unknown): RunnerFault {
  const fault = asRunnerFault(error);
  return new RunnerFault(fault.code, fault.message, {
    impact: fault.impact,
    recovery: fault.recovery,
    retryable: fault.retryable,
    reference: fault.reference,
    cause: fault,
    ...(fault.remoteCode ? { remoteCode: fault.remoteCode } : {}),
    discardJournal: fault.discardJournal,
    engineAttempted: true,
  });
}

export function redact(value: string, secrets: readonly (string | undefined)[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

/** One untrusted event must remain one inert terminal/log line. Removes ANSI
 * CSI/OSC, C0/DEL, bidi controls, and invisible direction-changing marks. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\u009d[^\u009c]*(?:\u009c|$)/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gi, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
