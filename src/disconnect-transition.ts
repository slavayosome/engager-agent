import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentHome, isSafeMcpUrl } from "./config.js";
import { removePathDurably, writePrivateJsonDurably } from "./durable.js";

export const RUNNER_DISCONNECT_PROTOCOL_VERSION = 1 as const;
export const DISCONNECT_TRANSITION_PHASES = [
  "prepared",
  "quiesced",
  "pending",
  "approved",
  "acknowledged",
] as const;

const Uuid = z.string().uuid();
const Fingerprint = z.string().regex(/^v2:[a-f0-9]{64}$/);

const PriorServiceSchema = z
  .object({
    supported: z.boolean(),
    installed: z.boolean(),
    entryExists: z.boolean(),
    loaded: z.boolean(),
    disabled: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.loaded &&
      (!value.supported || !value.installed || !value.entryExists || value.disabled == null)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "loaded prior service is inconsistent" });
    }
  });

export const DisconnectStartSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_DISCONNECT_PROTOCOL_VERSION),
    status: z.literal("pending"),
    requestId: Uuid,
    clientRequestId: Uuid,
    organizationId: Uuid,
    runnerId: z.string().min(3).max(200),
    credentialKeyId: Uuid,
    credentialFingerprint: Fingerprint,
    deviceCode: z.string().regex(/^engrd_[A-Za-z0-9_-]{43}$/),
    userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/),
    verificationUri: z.string().url().max(2_000),
    expiresAt: z.number().int().nonnegative(),
    intervalSec: z.literal(5),
  })
  .strict();

export const DisconnectReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    receiptId: Uuid,
    requestId: Uuid,
    clientRequestId: Uuid,
    organizationId: Uuid,
    runnerId: z.string().min(3).max(200),
    credentialKeyId: Uuid,
    credentialFingerprint: Fingerprint,
    credentialWasActive: z.boolean(),
    credentialRevokedAt: z.number().int().nonnegative(),
    cancelledWorkOrderIds: z.array(z.string().min(1).max(200)).max(10_000),
    legacyCancelledWorkOrderIds: z.array(z.string().min(1).max(200)).max(10_000),
    approvedByUserId: Uuid,
    approvedAt: z.number().int().nonnegative(),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const ApprovalSchema = z
  .object({
    receipt: DisconnectReceiptSchema,
    ackToken: z.string().regex(/^engra_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const SanitizedDisconnectReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("acknowledged"),
    completedAt: z.number().int().nonnegative(),
    receiptId: Uuid,
    requestId: Uuid,
    organizationId: Uuid,
    runnerId: z.string().min(3).max(200),
    credentialKeyId: Uuid,
    credentialRevokedAt: z.number().int().nonnegative(),
    approvedAt: z.number().int().nonnegative(),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    cancelledWorkOrders: z.number().int().nonnegative(),
    cancelledLegacyWorkOrders: z.number().int().nonnegative(),
  })
  .strict();

const DisconnectTransitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(RUNNER_DISCONNECT_PROTOCOL_VERSION),
    phase: z.enum(DISCONNECT_TRANSITION_PHASES),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    clientRequestId: Uuid,
    mcpUrl: z.string().refine(isSafeMcpUrl, "unsafe MCP URL"),
    runnerId: z.string().min(3).max(200),
    credentialFingerprint: Fingerprint,
    priorService: PriorServiceSchema,
    start: DisconnectStartSchema.optional(),
    approval: ApprovalSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.updatedAt < value.createdAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "transition timestamps are reversed" });
    }
    const phase = DISCONNECT_TRANSITION_PHASES.indexOf(value.phase);
    if ((phase >= 2) !== (value.start != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "disconnect start binding is incomplete" });
    }
    if ((phase >= 3) !== (value.approval != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "disconnect approval binding is incomplete" });
    }
    if (value.start) {
      if (
        value.start.clientRequestId !== value.clientRequestId ||
        value.start.runnerId !== value.runnerId ||
        value.start.credentialFingerprint !== value.credentialFingerprint
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "disconnect start binding mismatch" });
      }
    }
    if (value.start && value.approval) {
      const receipt = value.approval.receipt;
      if (
        receipt.requestId !== value.start.requestId ||
        receipt.clientRequestId !== value.start.clientRequestId ||
        receipt.organizationId !== value.start.organizationId ||
        receipt.runnerId !== value.start.runnerId ||
        receipt.credentialKeyId !== value.start.credentialKeyId ||
        receipt.credentialFingerprint !== value.start.credentialFingerprint
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "disconnect receipt binding mismatch" });
      }
    }
  });

export type DisconnectStart = z.infer<typeof DisconnectStartSchema>;
export type DisconnectReceipt = z.infer<typeof DisconnectReceiptSchema>;
export type DisconnectTransition = z.infer<typeof DisconnectTransitionSchema>;
export type DisconnectTransitionPhase = DisconnectTransition["phase"];
export type SanitizedDisconnectReceipt = z.infer<typeof SanitizedDisconnectReceiptSchema>;

export type DisconnectSafeProgress = {
  phase: DisconnectTransition["phase"];
  clientRequestId: string;
  runnerId: string;
  requestId?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  receiptId?: string;
};

export function safeDisconnectProgress(transition: DisconnectTransition): DisconnectSafeProgress {
  return {
    phase: transition.phase,
    clientRequestId: transition.clientRequestId,
    runnerId: transition.runnerId,
    ...(transition.start
      ? {
          requestId: transition.start.requestId,
          userCode: transition.start.userCode,
          verificationUri: transition.start.verificationUri,
          expiresAt: transition.start.expiresAt,
        }
      : {}),
    ...(transition.approval ? { receiptId: transition.approval.receipt.receiptId } : {}),
  };
}

export function disconnectReceiptHash(
  receipt: Omit<DisconnectReceipt, "receiptHash">,
): string {
  return createHash("sha256").update(JSON.stringify(canonical(receipt))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

export function disconnectTransitionPath(): string {
  return join(agentHome(), "disconnect-transition.json");
}

export function disconnectReceiptPath(): string {
  return join(agentHome(), "disconnect-receipt.json");
}

export function credentialFingerprint(apiKey: string): string {
  return `v2:${createHash("sha256").update(apiKey).digest("hex")}`;
}

export function hasDisconnectTransition(): boolean {
  try {
    lstatTransition();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function lstatTransition(): void {
  const fd = openSync(disconnectTransitionPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
  closeSync(fd);
}

export function readDisconnectTransition(): DisconnectTransition | null {
  const path = disconnectTransitionPath();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || !owned || (stat.mode & 0o777) !== 0o600) {
      throw new Error("disconnect transition journal is not a private 0600 regular file");
    }
    if (stat.size > 1_000_000) throw new Error("disconnect transition journal exceeds 1 MB");
    return DisconnectTransitionSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function readSanitizedDisconnectReceipt(): SanitizedDisconnectReceipt | null {
  const path = disconnectReceiptPath();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || !owned || (stat.mode & 0o777) !== 0o600) {
      throw new Error("disconnect receipt is not a private 0600 regular file");
    }
    if (stat.size > 64 * 1024) throw new Error("disconnect receipt exceeds 64 KiB");
    return SanitizedDisconnectReceiptSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function writeDisconnectTransition(
  value: Omit<DisconnectTransition, "updatedAt"> & { updatedAt?: number },
): DisconnectTransition {
  const parsed = DisconnectTransitionSchema.parse({ ...value, updatedAt: value.updatedAt ?? Date.now() });
  writePrivateJsonDurably(disconnectTransitionPath(), parsed);
  return parsed;
}

export function advanceDisconnectTransition(
  transition: DisconnectTransition,
  phase: DisconnectTransitionPhase,
  patch: Partial<Pick<DisconnectTransition, "start" | "approval">> = {},
): DisconnectTransition {
  if (DISCONNECT_TRANSITION_PHASES.indexOf(phase) < DISCONNECT_TRANSITION_PHASES.indexOf(transition.phase)) {
    throw new Error(`refusing non-monotonic disconnect transition ${transition.phase} -> ${phase}`);
  }
  return writeDisconnectTransition({ ...transition, ...patch, phase, updatedAt: Date.now() });
}

export function clearDisconnectTransition(): void {
  const path = disconnectTransitionPath();
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  removePathDurably(path);
}

export function writeSanitizedDisconnectReceipt(transition: DisconnectTransition): void {
  const receipt = transition.approval?.receipt;
  if (!receipt) throw new Error("disconnect receipt is unavailable");
  const sanitized = SanitizedDisconnectReceiptSchema.parse({
    schemaVersion: 1,
    status: "acknowledged",
    completedAt: Date.now(),
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    organizationId: receipt.organizationId,
    runnerId: receipt.runnerId,
    credentialKeyId: receipt.credentialKeyId,
    credentialRevokedAt: receipt.credentialRevokedAt,
    approvedAt: receipt.approvedAt,
    receiptHash: receipt.receiptHash,
    cancelledWorkOrders: receipt.cancelledWorkOrderIds.length,
    cancelledLegacyWorkOrders: receipt.legacyCancelledWorkOrderIds.length,
  });
  writePrivateJsonDurably(disconnectReceiptPath(), sanitized);
}

export function disconnectTransitionBlockReason(): string | null {
  try {
    const transition = readDisconnectTransition();
    return transition
      ? `runner disconnect is awaiting recovery at phase ${transition.phase}`
      : null;
  } catch {
    return "runner disconnect journal is unsafe or unreadable";
  }
}
