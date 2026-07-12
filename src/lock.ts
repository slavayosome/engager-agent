import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";
import { hasDisconnectTransition } from "./disconnect-transition.js";
import { RunnerFault } from "./errors.js";
import { pidAlive } from "./status.js";
import { hasUpgradeTransition } from "./upgrade-transition.js";

export type LockOwner = {
  pid: number;
  token: string;
  runnerId: string;
  startedAt: number;
  processIdentity: string;
};

export type RunnerLock = {
  path: string;
  owner: LockOwner;
  release(): void;
};

export type LockInspection =
  | { state: "absent" }
  | { state: "valid"; owner: LockOwner }
  | { state: "invalid"; detail: string };

/** Sanitized local diagnostic. The capability token is deliberately absent. */
export type LockDiagnostic = {
  state: "absent" | "active" | "stale" | "invalid";
  detail: string;
  pid?: number;
};

export type LockIdentityDeps = {
  identity: (pid: number) => string | null;
  alive: (pid: number) => boolean;
};

const REAL_IDENTITY_DEPS: LockIdentityDeps = {
  identity: processIdentity,
  alive: pidAlive,
};

export const TRUSTED_PROCESS_IDENTITY_EXECUTABLES = ["/bin/ps", "/usr/bin/ps"] as const;
export const MAINTENANCE_TOKEN_ENV = "ENGAGER_AGENT_MAINTENANCE_TOKEN";

export function locksRoot(): string {
  return join(agentHome(), "locks");
}

export function runnerLockPath(runnerId: string): string {
  // Config and the crash-recovery journal are home-global, so work execution
  // must be globally singleton as well. Hashing the runner id here previously
  // allowed two identities to overwrite one active-work journal.
  void runnerId;
  return join(locksRoot(), "agent.lock");
}

export function maintenanceLockPath(): string {
  return join(locksRoot(), "maintenance.lock");
}

export function acquireRunnerLock(
  runnerId: string,
  deps: LockIdentityDeps = REAL_IDENTITY_DEPS,
  maintenanceToken: string | undefined = process.env[MAINTENANCE_TOKEN_ENV],
): RunnerLock {
  mkdirSync(locksRoot(), { recursive: true, mode: 0o700 });
  chmodSync(locksRoot(), 0o700);
  assertMaintenanceAccess(deps, maintenanceToken);
  const lock = acquireNamedLock(runnerLockPath(runnerId), runnerId, deps);
  try {
    // Close the race where maintenance starts after the first check but before
    // this process publishes its execution lock.
    assertMaintenanceAccess(deps, maintenanceToken);
    if (
      maintenanceToken &&
      process.env[MAINTENANCE_TOKEN_ENV] === maintenanceToken
    ) {
      delete process.env[MAINTENANCE_TOKEN_ENV];
    }
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export function acquireMaintenanceLock(
  runnerId: string,
  deps: LockIdentityDeps = REAL_IDENTITY_DEPS,
): RunnerLock {
  mkdirSync(locksRoot(), { recursive: true, mode: 0o700 });
  chmodSync(locksRoot(), 0o700);
  return acquireNamedLock(maintenanceLockPath(), runnerId, deps);
}

function acquireNamedLock(
  path: string,
  runnerId: string,
  deps: LockIdentityDeps,
): RunnerLock {
  const identity = deps.identity(process.pid);
  if (!identity) throw processIdentityFault("current runner process identity could not be established");
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    runnerId,
    startedAt: Date.now(),
    processIdentity: identity,
  };
  if (!tryCreate(path, owner)) {
    const current = inspectOwner(path);
    refuseLiveOrUnverifiableOwner(current, deps);
    recoverStale(path, runnerId, identity, deps);
    if (!tryCreate(path, owner)) {
      const winner = inspectOwner(path);
      if (winner.state === "invalid") throw invalidLockFault("lock", winner.detail);
      throw alreadyActive(winner.state === "valid" ? winner.owner : { ...owner, pid: 0 });
    }
  }
  let released = false;
  return {
    path,
    owner,
    release: () => {
      if (released) return;
      released = true;
      const current = inspectOwner(path);
      if (current.state === "valid" && current.owner.token === owner.token) {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

function assertMaintenanceAccess(
  deps: LockIdentityDeps,
  maintenanceToken?: string,
): void {
  const inspection = inspectOwner(maintenanceLockPath());
  const transitionPending = hasUpgradeTransition() || hasDisconnectTransition();
  if (inspection.state === "invalid") {
    throw invalidLockFault("maintenance lock", inspection.detail);
  }
  if (inspection.state === "absent") {
    if (transitionPending) throw transitionRecoveryFault();
    return;
  }
  const owner = inspection.owner;
  if (!deps.alive(owner.pid)) {
    if (transitionPending) throw transitionRecoveryFault();
    return;
  }
  if (!owner.processIdentity) {
    throw processIdentityFault(
      `maintenance owner pid ${owner.pid} is live but has no verifiable process identity`,
    );
  }
  const current = deps.identity(owner.pid);
  if (current == null) {
    throw processIdentityFault(
      `maintenance owner pid ${owner.pid} identity lookup failed`,
    );
  }
  if (current !== owner.processIdentity) {
    if (transitionPending) throw transitionRecoveryFault();
    return;
  }
  if (maintenanceToken === owner.token) return;
  throw new RunnerFault(
    "RUNNER_ALREADY_ACTIVE",
    "runner maintenance is activating and verifying a durable payload",
    {
      impact: "This process did not poll, claim, or execute work during the upgrade transition.",
      recovery: "Wait for `engager-agent upgrade` to finish, then retry.",
      retryable: true,
    },
  );
}

function transitionRecoveryFault(): RunnerFault {
  return new RunnerFault(
    "RUNNER_ALREADY_ACTIVE",
    "an interrupted service transition requires deterministic recovery",
    {
      impact: "This process did not poll, claim, or execute work against an ambiguous runtime payload.",
      recovery: "Run `engager-agent disconnect` for a disconnect transition, or `engager-agent upgrade`, `engager-agent service repair`, or `engager-agent start` for an upgrade transition.",
      retryable: true,
    },
  );
}

function tryCreate(path: string, owner: LockOwner): boolean {
  try {
    // mkdir itself is the exclusive no-replace operation. Renaming a candidate
    // directory can replace an already-existing empty directory on POSIX,
    // which would silently erase a crash-created lock with missing metadata.
    mkdirSync(path, { mode: 0o700 });
    try {
      writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function recoverStale(
  path: string,
  runnerId: string,
  identity: string,
  deps: LockIdentityDeps,
): void {
  const guard = `${path}.recovery`;
  const guardOwner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    runnerId,
    startedAt: Date.now(),
    processIdentity: identity,
  };
  acquireRecoveryGuard(guard, guardOwner, deps);
  try {
    const owner = inspectOwner(path);
    refuseLiveOrUnverifiableOwner(owner, deps);
    if (owner.state === "absent") return;
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    const inspection = inspectOwner(guard);
    if (
      inspection.state === "valid" &&
      inspection.owner.token === guardOwner.token
    ) {
      rmSync(guard, { recursive: true, force: true });
    }
  }
}

function acquireRecoveryGuard(
  path: string,
  owner: LockOwner,
  deps: LockIdentityDeps,
): void {
  if (tryCreate(path, owner)) return;
  const current = inspectOwner(path);
  refuseLiveOrUnverifiableOwner(current, deps);
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (tryCreate(path, owner)) return;
  const winner = inspectOwner(path);
  if (winner.state === "invalid") throw invalidLockFault("recovery guard", winner.detail);
  throw new RunnerFault("RUNNER_ALREADY_ACTIVE", "another process won runner-lock recovery", {
    impact: "This process did not start polling or claim work.",
    recovery: winner.state === "valid" && isLockOwnerLive(winner.owner, deps)
      ? "Run `engager-agent status`; retry after the existing process exits."
      : "Retry once; a concurrent stale-guard cleanup is still completing.",
    retryable: true,
  });
}

function inspectOwner(path: string): LockInspection {
  let lockStat;
  try {
    lockStat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "invalid", detail: "lock path could not be inspected" };
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    return { state: "invalid", detail: "lock path is not a real directory" };
  }
  try {
    const ownerPath = join(path, "owner.json");
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      return { state: "invalid", detail: "owner metadata is not a regular file" };
    }
    const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length < 1 ||
      typeof value.runnerId !== "string" ||
      value.runnerId.length < 1 ||
      !Number.isSafeInteger(value.startedAt) ||
      Number(value.startedAt) < 0 ||
      typeof value.processIdentity !== "string" ||
      value.processIdentity.length < 1
    ) {
      return { state: "invalid", detail: "owner metadata failed structural validation" };
    }
    return { state: "valid", owner: value as LockOwner };
  } catch (error) {
    return {
      state: "invalid",
      detail:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "owner metadata is missing"
          : "owner metadata is unreadable or malformed",
    };
  }
}

export function inspectRunnerLock(runnerId: string): LockInspection {
  return inspectOwner(runnerLockPath(runnerId));
}

export function inspectMaintenanceLock(): LockInspection {
  return inspectOwner(maintenanceLockPath());
}

export function diagnoseLock(
  inspection: LockInspection,
  deps: LockIdentityDeps = REAL_IDENTITY_DEPS,
): LockDiagnostic {
  if (inspection.state === "absent") {
    return { state: "absent", detail: "lock is absent" };
  }
  if (inspection.state === "invalid") {
    return { state: "invalid", detail: inspection.detail };
  }
  const { owner } = inspection;
  if (!deps.alive(owner.pid)) {
    return { state: "stale", pid: owner.pid, detail: "verified metadata belongs to an exited process" };
  }
  if (!owner.processIdentity) {
    return { state: "invalid", pid: owner.pid, detail: "live owner lacks verifiable process identity" };
  }
  const current = deps.identity(owner.pid);
  if (current == null) {
    return { state: "invalid", pid: owner.pid, detail: "live owner identity lookup failed" };
  }
  return current === owner.processIdentity
    ? { state: "active", pid: owner.pid, detail: "verified live owner" }
    : { state: "stale", pid: owner.pid, detail: "stored owner identity no longer matches this pid" };
}

export function isLockOwnerLive(
  owner: LockOwner,
  deps: LockIdentityDeps = REAL_IDENTITY_DEPS,
): boolean {
  if (!owner.processIdentity || !deps.alive(owner.pid)) return false;
  const current = deps.identity(owner.pid);
  return current != null && current === owner.processIdentity;
}

export function processIdentity(pid: number): string | null {
  const executable = TRUSTED_PROCESS_IDENTITY_EXECUTABLES.find(existsSync);
  if (!executable) return null;
  const result = spawnSync(executable, processIdentityArgs(pid), {
    encoding: "utf8",
    timeout: 2_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  const identity = result.status === 0 ? result.stdout.trim() : "";
  return identity ? `${executable}\n${identity}` : null;
}

export function processIdentityArgs(pid: number): string[] {
  return ["-p", String(pid), "-o", "lstart=", "-o", "command="];
}

function refuseLiveOrUnverifiableOwner(
  inspection: LockInspection,
  deps: LockIdentityDeps,
): void {
  if (inspection.state === "invalid") throw invalidLockFault("lock", inspection.detail);
  if (inspection.state === "absent") return;
  const owner = inspection.owner;
  if (!deps.alive(owner.pid)) return;
  if (!owner.processIdentity) {
    throw processIdentityFault(`lock owner pid ${owner.pid} is live but has no verifiable process identity`);
  }
  const current = deps.identity(owner.pid);
  if (current == null) {
    throw processIdentityFault(`lock owner pid ${owner.pid} is live but its current identity lookup failed`);
  }
  if (current === owner.processIdentity) throw alreadyActive(owner);
}

function invalidLockFault(kind: string, detail: string): RunnerFault {
  return new RunnerFault(
    "RUNNER_ALREADY_ACTIVE",
    `${kind} ownership metadata is unsafe: ${detail}`,
    {
      impact: "The runner preserved the lock and refused to recover, signal, or overlap its unknown owner.",
      recovery: "Run `engager-agent doctor`; repair ~/.engager/locks ownership and metadata only after proving no process owns the lock.",
    },
  );
}

function processIdentityFault(message: string): RunnerFault {
  return new RunnerFault("RUNNER_ALREADY_ACTIVE", message, {
    impact: "The runner refused to recover, signal, or overlap an ambiguously owned local lock.",
    recovery: "Run `engager-agent doctor`; verify the system ps utility and remove a stale lock only after confirming its process is gone.",
  });
}

function alreadyActive(owner: Pick<LockOwner, "pid">): RunnerFault {
  return new RunnerFault(
    "RUNNER_ALREADY_ACTIVE",
    `runner process ${owner.pid || "unknown"} already owns this local identity`,
    {
      impact: "The second process did not poll, claim, or execute work.",
      recovery: "Use `engager-agent status` or stop the existing process with `engager-agent stop`.",
    },
  );
}
