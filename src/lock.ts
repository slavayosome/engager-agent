import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";
import { RunnerFault } from "./errors.js";
import { pidAlive } from "./status.js";

export type LockOwner = {
  pid: number;
  token: string;
  runnerId: string;
  startedAt: number;
  processIdentity?: string;
};

export type RunnerLock = {
  path: string;
  owner: LockOwner;
  release(): void;
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

export function acquireRunnerLock(
  runnerId: string,
  deps: LockIdentityDeps = REAL_IDENTITY_DEPS,
): RunnerLock {
  mkdirSync(locksRoot(), { recursive: true, mode: 0o700 });
  chmodSync(locksRoot(), 0o700);
  const path = runnerLockPath(runnerId);
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
    const current = readOwner(path);
    refuseLiveOrUnverifiableOwner(current, deps);
    recoverStale(path, runnerId, identity, deps);
    if (!tryCreate(path, owner)) {
      const winner = readOwner(path);
      throw alreadyActive(winner ?? { ...owner, pid: 0 });
    }
  }
  let released = false;
  return {
    path,
    owner,
    release: () => {
      if (released) return;
      released = true;
      const current = readOwner(path);
      if (current?.token === owner.token) rmSync(path, { recursive: true, force: true });
    },
  };
}

function tryCreate(path: string, owner: LockOwner): boolean {
  const staging = `${path}.candidate-${process.pid}-${owner.token}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, path);
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
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
    const owner = readOwner(path);
    refuseLiveOrUnverifiableOwner(owner, deps);
    if (!existsSync(path)) return;
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    if (readOwner(guard)?.token === guardOwner.token) {
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
  const current = readOwner(path);
  refuseLiveOrUnverifiableOwner(current, deps);
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
    rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (tryCreate(path, owner)) return;
  const winner = readOwner(path);
  throw new RunnerFault("RUNNER_ALREADY_ACTIVE", "another process won runner-lock recovery", {
    impact: "This process did not start polling or claim work.",
    recovery: winner && isLockOwnerLive(winner, deps)
      ? "Run `engager-agent status`; retry after the existing process exits."
      : "Retry once; a concurrent stale-guard cleanup is still completing.",
    retryable: true,
  });
}

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Partial<LockOwner>;
    return typeof value.pid === "number" && typeof value.token === "string"
      ? (value as LockOwner)
      : null;
  } catch {
    return null;
  }
}

export function readRunnerLockOwner(runnerId: string): LockOwner | null {
  return readOwner(runnerLockPath(runnerId));
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
  owner: LockOwner | null,
  deps: LockIdentityDeps,
): void {
  if (!owner || !deps.alive(owner.pid)) return;
  if (!owner.processIdentity) {
    throw processIdentityFault(`lock owner pid ${owner.pid} is live but has no verifiable process identity`);
  }
  const current = deps.identity(owner.pid);
  if (current == null) {
    throw processIdentityFault(`lock owner pid ${owner.pid} is live but its current identity lookup failed`);
  }
  if (current === owner.processIdentity) throw alreadyActive(owner);
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
