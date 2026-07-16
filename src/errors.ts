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
  "DISCONNECT_PENDING",
  "DISCONNECT_DENIED",
  "DISCONNECT_EXPIRED",
  "DISCONNECT_PROTOCOL_ERROR",
  "DISCONNECT_CLEANUP_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export function isRunnerErrorCode(value: unknown): value is RunnerErrorCode {
  return typeof value === "string" && RUNNER_ERROR_CODES.includes(value as RunnerErrorCode);
}

export type RunnerErrorCatalogEntry = {
  summary: string;
  defaultRecovery: string;
  retryable: boolean;
};

/** One exhaustive source for `engager-agent errors`; `satisfies Record` makes
 * adding a stable code without documenting it a compile failure. */
export const RUNNER_ERROR_CATALOG = {
  AUTH_REVOKED: { summary: "The runner credential is invalid or revoked.", defaultRecovery: "Reauthorize or complete an in-progress disconnect.", retryable: false },
  ENGINE_NOT_FOUND: { summary: "The selected provider CLI was not found.", defaultRecovery: "Install the configured provider CLI and rerun setup.", retryable: false },
  ENGINE_UNSUPPORTED_VERSION: { summary: "The provider CLI version is outside the certified range.", defaultRecovery: "Install a supported provider CLI version.", retryable: false },
  ENGINE_AUTH_REQUIRED: { summary: "The provider CLI is not authenticated.", defaultRecovery: "Authenticate the provider CLI and rerun doctor.", retryable: false },
  ENGINE_QUOTA: { summary: "The provider reported an allowance or quota boundary.", defaultRecovery: "Wait for provider allowance to reset.", retryable: true },
  ENGINE_OVERLOADED: { summary: "The provider is temporarily overloaded.", defaultRecovery: "Retry after the provider recovers.", retryable: true },
  ENGINE_NETWORK: { summary: "The provider could not be reached safely.", defaultRecovery: "Check provider connectivity and retry.", retryable: true },
  ENGINE_TIMEOUT: { summary: "The provider process exceeded its deadline.", defaultRecovery: "Inspect provider health and retry only when safe.", retryable: true },
  ENGINE_OUTPUT_INVALID: { summary: "Provider output failed the runner contract.", defaultRecovery: "Inspect sanitized logs and update the runner or prompt contract.", retryable: false },
  ENGINE_SANDBOX_DENIED: { summary: "A local security or durable-state boundary blocked execution.", defaultRecovery: "Repair the reported local permission or sandbox issue.", retryable: false },
  ENGINE_CONTEXT_LIMIT: { summary: "The provider context limit was exceeded.", defaultRecovery: "Reduce the requested batch or upgrade the configured model.", retryable: false },
  ENGINE_FAILED: { summary: "The provider process failed without a narrower classification.", defaultRecovery: "Inspect doctor and sanitized logs before retrying.", retryable: true },
  CONTRACT_UPGRADE_REQUIRED: { summary: "The server requires a newer runner contract.", defaultRecovery: "Run npx engager-agent@latest upgrade.", retryable: false },
  SERVER_UNREACHABLE: { summary: "The Engager control plane could not be reached.", defaultRecovery: "Check network/server health and retry.", retryable: true },
  CLOCK_SKEW: { summary: "Local and server clocks are too far apart for lease safety.", defaultRecovery: "Correct system time before running again.", retryable: false },
  LEASE_LOST: { summary: "The server lease was lost before completion.", defaultRecovery: "Let the server safely reissue work.", retryable: true },
  VALIDATION_REJECTED: { summary: "A submission failed deterministic validation.", defaultRecovery: "Correct the authored payload before retrying.", retryable: false },
  SERVICE_ENTRY_MISSING: { summary: "The installed service payload is missing or unverifiable.", defaultRecovery: "Run engager-agent service repair.", retryable: false },
  RUNNER_ALREADY_ACTIVE: { summary: "Another execution, maintenance, or recovery owner is active.", defaultRecovery: "Wait for or recover the reported owner before retrying.", retryable: true },
  RUNNER_NOT_CONFIGURED: { summary: "No valid private runner configuration is available.", defaultRecovery: "Run engager-agent setup, or resume the reported recovery transition.", retryable: false },
  RUNNER_PAUSED: { summary: "Local operator intent has paused claims.", defaultRecovery: "Run engager-agent resume when ready.", retryable: false },
  DISCONNECT_PENDING: { summary: "Owner approval or disconnect recovery is still pending.", defaultRecovery: "Open the verification URL or rerun engager-agent disconnect.", retryable: true },
  DISCONNECT_DENIED: { summary: "The project owner denied runner disconnect.", defaultRecovery: "The captured service state was restored; retry only if teardown is still intended.", retryable: false },
  DISCONNECT_EXPIRED: { summary: "The owner-approval challenge expired.", defaultRecovery: "Rerun engager-agent disconnect for a new challenge.", retryable: false },
  DISCONNECT_PROTOCOL_ERROR: { summary: "A disconnect response failed strict binding validation.", defaultRecovery: "Preserve the transition and retry after server/runner compatibility is fixed.", retryable: false },
  DISCONNECT_CLEANUP_REQUIRED: { summary: "Revocation succeeded but local teardown is incomplete.", defaultRecovery: "Rerun engager-agent disconnect; it resumes without the revoked bearer.", retryable: true },
  INTERNAL_ERROR: { summary: "The runner stopped at an unclassified internal boundary.", defaultRecovery: "Run engager-agent doctor and inspect sanitized logs.", retryable: false },
} as const satisfies Record<RunnerErrorCode, RunnerErrorCatalogEntry>;

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

export function formatRunnerFault(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  const fault = asRunnerFault(error);
  return [
    `${fault.code}${fault.remoteCode ? `/${sanitizeSensitiveText(fault.remoteCode, secrets)}` : ""}: ${sanitizeSensitiveText(fault.message, secrets)}`,
    `Impact: ${sanitizeSensitiveText(fault.impact, secrets)}`,
    `Fix: ${sanitizeSensitiveText(fault.recovery, secrets)}`,
    `Reference: ${sanitizeSensitiveText(fault.reference, secrets)}`,
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

/** Redact every Engager authority namespace even when private config cannot be
 * parsed, then apply exact-value redaction for locally recoverable secrets. */
export function sanitizeSensitiveText(
  value: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  return redact(sanitizeTerminalText(value), secrets)
    .replace(
      /\b(?:eng_[A-Za-z0-9]+|engd|engda|engrd|engra)_[A-Za-z0-9_-]{12,}\b/g,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(
      /("?(?:api[_-]?key|token|secret|device[_-]?code|ack[_-]?token)"?\s*[:=]\s*)"?[^\s",}]+"?/gi,
      "$1[REDACTED]",
    );
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
