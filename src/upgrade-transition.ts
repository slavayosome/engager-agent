import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentHome } from "./config.js";
import { removePathDurably, writePrivateJsonDurably } from "./durable.js";

export const UPGRADE_TRANSITION_PHASES = [
  "prepared",
  "service_stopped",
  "payload_activated",
  "plist_installed",
  "service_bootstrapped",
] as const;

const StoredFileSchema = z
  .object({
    present: z.boolean(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    contentsBase64: z.string().max(500_000).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const complete = value.sha256 != null && value.contentsBase64 != null;
    if (value.present !== complete) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stored file snapshot is incomplete" });
      return;
    }
    if (value.present) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(value.contentsBase64!, "base64");
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stored file snapshot is not base64" });
        return;
      }
      if (bytes.toString("base64") !== value.contentsBase64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stored file snapshot is not canonical base64" });
        return;
      }
      if (sha256(bytes) !== value.sha256) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stored file snapshot hash mismatch" });
      }
    }
  });

const LinkSnapshotSchema = z
  .object({
    target: z.string().min(1).max(500).nullable(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.target == null) !== (value.payloadSha256 == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "runtime link snapshot is incomplete" });
    }
    if (value.target != null && !isManagedRuntimeTarget(value.target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "runtime link target is outside managed versions" });
    }
  });

const UpgradeTransitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(UPGRADE_TRANSITION_PHASES),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    prior: z
      .object({
        installed: z.boolean(),
        loaded: z.boolean(),
        disabled: z.boolean(),
        current: LinkSnapshotSchema,
        previous: LinkSnapshotSchema,
        plist: StoredFileSchema,
      })
      .strict(),
    target: z
      .object({
        installed: z.boolean(),
        disabled: z.boolean(),
        version: z.string().min(1).max(100),
        payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
        linkTarget: z.string().min(1).max(500).refine(isManagedRuntimeTarget),
        previous: LinkSnapshotSchema,
        plist: StoredFileSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.updatedAt < value.createdAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "transition timestamps are reversed" });
    }
    if (value.prior.loaded && (!value.prior.installed || value.prior.disabled)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "loaded prior service intent is inconsistent" });
    }
    if (value.prior.installed !== value.prior.plist.present) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "prior service/plist presence is inconsistent" });
    }
    if (value.target.installed !== value.target.plist.present) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "target service/plist presence is inconsistent" });
    }
    if (
      value.prior.installed &&
      !value.prior.disabled &&
      value.prior.current.target == null
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enabled prior service has no restorable payload" });
    }
  });

export type StoredFileSnapshot = z.infer<typeof StoredFileSchema>;
export type RuntimeLinkSnapshot = z.infer<typeof LinkSnapshotSchema>;
export type UpgradeTransition = z.infer<typeof UpgradeTransitionSchema>;
export type UpgradeTransitionPhase = UpgradeTransition["phase"];

export function upgradeTransitionPath(): string {
  return join(agentHome(), "upgrade-transition.json");
}

export function hasUpgradeTransition(): boolean {
  try {
    lstatSync(upgradeTransitionPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function fileSnapshot(contents: Buffer | null): StoredFileSnapshot {
  return contents == null
    ? { present: false, sha256: null, contentsBase64: null }
    : {
        present: true,
        sha256: sha256(contents),
        contentsBase64: contents.toString("base64"),
      };
}

export function fileSnapshotContents(snapshot: StoredFileSnapshot): Buffer | null {
  const parsed = StoredFileSchema.parse(snapshot);
  return parsed.present ? Buffer.from(parsed.contentsBase64!, "base64") : null;
}

export function writeUpgradeTransition(
  transition: Omit<UpgradeTransition, "updatedAt"> & { updatedAt?: number },
): UpgradeTransition {
  const parsed = prepareUpgradeTransition(transition);
  writePrivateJsonDurably(upgradeTransitionPath(), parsed);
  return parsed;
}

export function prepareUpgradeTransition(
  transition: Omit<UpgradeTransition, "updatedAt"> & { updatedAt?: number },
): UpgradeTransition {
  return UpgradeTransitionSchema.parse({
    ...transition,
    updatedAt: transition.updatedAt ?? Date.now(),
  });
}

export function advanceUpgradeTransition(
  transition: UpgradeTransition,
  phase: UpgradeTransitionPhase,
): UpgradeTransition {
  const currentIndex = UPGRADE_TRANSITION_PHASES.indexOf(transition.phase);
  const nextIndex = UPGRADE_TRANSITION_PHASES.indexOf(phase);
  if (nextIndex < currentIndex) {
    throw new Error(`refusing non-monotonic upgrade transition ${transition.phase} -> ${phase}`);
  }
  return writeUpgradeTransition({ ...transition, phase, updatedAt: Date.now() });
}

export function readUpgradeTransition(): UpgradeTransition | null {
  const path = upgradeTransitionPath();
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
      throw new Error("upgrade transition journal is not a private 0600 regular file");
    }
    if (stat.size > 1_000_000) throw new Error("upgrade transition journal exceeds 1 MB");
    return UpgradeTransitionSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function clearUpgradeTransition(): void {
  if (existsSync(upgradeTransitionPath())) removePathDurably(upgradeTransitionPath());
}

export function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function isManagedRuntimeTarget(value: string): boolean {
  return /^versions\/[A-Za-z0-9._-]+$/.test(value);
}
