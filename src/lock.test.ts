import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireMaintenanceLock,
  acquireRunnerLock,
  isLockOwnerLive,
  MAINTENANCE_TOKEN_ENV,
  maintenanceLockPath,
  processIdentityArgs,
  runnerLockPath,
  TRUSTED_PROCESS_IDENTITY_EXECUTABLES,
  type LockIdentityDeps,
  type LockOwner,
} from "./lock.js";
import { upgradeTransitionPath } from "./upgrade-transition.js";
import { disconnectTransitionPath } from "./disconnect-transition.js";

let prior: string | undefined;
let priorMaintenanceToken: string | undefined;
const identityDeps: LockIdentityDeps = {
  identity: (pid) => (pid === process.pid ? "test-process-start" : null),
  alive: (pid) => pid === process.pid,
};
const acquire = (runnerId: string) => acquireRunnerLock(runnerId, identityDeps);
beforeEach(() => {
  prior = process.env.ENGAGER_AGENT_HOME;
  priorMaintenanceToken = process.env[MAINTENANCE_TOKEN_ENV];
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-lock-test-"));
});
afterEach(() => {
  if (prior === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = prior;
  if (priorMaintenanceToken === undefined) delete process.env[MAINTENANCE_TOKEN_ENV];
  else process.env[MAINTENANCE_TOKEN_ENV] = priorMaintenanceToken;
});

describe("runner singleton", () => {
  it("fails closed and preserves malformed agent-lock ownership metadata", () => {
    const path = runnerLockPath("malformed-agent");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "owner.json"), "not-json\n", { mode: 0o600 });

    expect(() => acquire("malformed-agent")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(readFileSync(join(path, "owner.json"), "utf8")).toBe("not-json\n");
  });

  it("fails closed and preserves an agent lock with missing ownership metadata", () => {
    const path = runnerLockPath("missing-agent-owner");
    mkdirSync(path, { recursive: true, mode: 0o700 });

    expect(() => acquire("missing-agent-owner")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "owner.json"))).toBe(false);
  });

  it("fails closed and preserves malformed maintenance-lock ownership metadata", () => {
    const path = maintenanceLockPath();
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "owner.json"), "{\"pid\":\"wrong\"}\n", { mode: 0o600 });

    expect(() => acquire("malformed-maintenance")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(runnerLockPath("malformed-maintenance"))).toBe(false);
    expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(
      "{\"pid\":\"wrong\"}\n",
    );
  });

  it("fails closed and preserves a maintenance lock with missing ownership metadata", () => {
    const path = maintenanceLockPath();
    mkdirSync(path, { recursive: true, mode: 0o700 });

    expect(() => acquire("missing-maintenance-owner")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(runnerLockPath("missing-maintenance-owner"))).toBe(false);
  });

  it("blocks new execution during maintenance, admits only the tokened service, and consumes its token", () => {
    const maintenance = acquireMaintenanceLock("runner-maintenance", identityDeps);
    try {
      expect(() => acquire("runner-maintenance")).toThrowError(
        expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
      );
      process.env[MAINTENANCE_TOKEN_ENV] = maintenance.owner.token;
      const replacement = acquire("runner-maintenance");
      try {
        expect(process.env[MAINTENANCE_TOKEN_ENV]).toBeUndefined();
      } finally {
        replacement.release();
      }
    } finally {
      maintenance.release();
    }
  });

  it("fences ordinary execution when a dead upgrader leaves any transition journal", () => {
    writeFileSync(upgradeTransitionPath(), "{}\n", { mode: 0o600 });
    expect(() => acquire("runner-after-crash")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );

    const maintenance = acquireMaintenanceLock("reconciler", identityDeps);
    try {
      process.env[MAINTENANCE_TOKEN_ENV] = maintenance.owner.token;
      const verificationRunner = acquire("tokened-recovery-service");
      verificationRunner.release();
      expect(process.env[MAINTENANCE_TOKEN_ENV]).toBeUndefined();
    } finally {
      maintenance.release();
    }
  });

  it("fences every ordinary execution entry when disconnect recovery exists", () => {
    writeFileSync(disconnectTransitionPath(), "{}\n", { mode: 0o600 });
    expect(() => acquire("runner-disconnect-crash")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(runnerLockPath("runner-disconnect-crash"))).toBe(false);

    const maintenance = acquireMaintenanceLock("disconnect-reconciler", identityDeps);
    try {
      process.env[MAINTENANCE_TOKEN_ENV] = maintenance.owner.token;
      const recovery = acquire("disconnect-recovery-service");
      recovery.release();
    } finally {
      maintenance.release();
    }
  });

  it("rejects a second live owner with RUNNER_ALREADY_ACTIVE", () => {
    const first = acquire("runner-one");
    try {
      expect(() => acquire("runner-one")).toThrowError(
        expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
      );
    } finally {
      first.release();
    }
  });

  it("recovers a dead owner and releases only its own token", () => {
    const path = runnerLockPath("runner-stale");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ pid: 2_147_000_000, token: "stale", runnerId: "runner-stale", startedAt: 1, processIdentity: "exited-process" }),
      { mode: 0o600 },
    );
    const current = acquire("runner-stale");
    expect(current.owner.pid).toBe(process.pid);
    current.release();
    const next = acquire("runner-stale");
    next.release();
  });

  it("recovers only a structurally valid dead recovery guard", () => {
    const path = runnerLockPath("runner-stale-guard");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ pid: 2_147_000_000, token: "stale", runnerId: "runner-stale-guard", startedAt: 1, processIdentity: "exited-process" }),
      { mode: 0o600 },
    );
    mkdirSync(`${path}.recovery`, { mode: 0o700 });
    writeFileSync(
      join(`${path}.recovery`, "owner.json"),
      JSON.stringify({
        pid: 2_146_999_999,
        token: "dead-guard",
        runnerId: "runner-stale-guard",
        startedAt: 1,
        processIdentity: "exited-process",
      }),
      { mode: 0o600 },
    );
    const current = acquire("runner-stale-guard");
    expect(current.owner.pid).toBe(process.pid);
    current.release();
  });

  it("fails closed and preserves missing or malformed recovery-guard metadata", () => {
    for (const contents of [null, "not-json\n"]) {
      process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-lock-guard-test-"));
      const path = runnerLockPath("invalid-guard");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(path, "owner.json"),
        JSON.stringify({ pid: 2_147_000_000, token: "stale", runnerId: "invalid-guard", startedAt: 1, processIdentity: "exited-process" }),
        { mode: 0o600 },
      );
      const guard = `${path}.recovery`;
      mkdirSync(guard, { mode: 0o700 });
      if (contents != null) writeFileSync(join(guard, "owner.json"), contents, { mode: 0o600 });

      expect(() => acquire("invalid-guard")).toThrowError(
        expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
      );
      expect(existsSync(path)).toBe(true);
      expect(existsSync(guard)).toBe(true);
      if (contents != null) {
        expect(readFileSync(join(guard, "owner.json"), "utf8")).toBe(contents);
      }
    }
  });

  it("never removes a lock whose metadata becomes invalid before release", () => {
    const lock = acquire("release-corruption");
    writeFileSync(join(lock.path, "owner.json"), "corrupt\n", { mode: 0o600 });
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(join(lock.path, "owner.json"), "utf8")).toBe("corrupt\n");
  });

  it("rejects a second identity because config and recovery journal are home-global", () => {
    const first = acquire("runner-a");
    try {
      expect(() => acquire("runner-b")).toThrowError(
        expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
      );
    } finally {
      first.release();
    }
  });

  it("refuses PID-only identity for liveness, signaling, and lock recovery", () => {
    expect(TRUSTED_PROCESS_IDENTITY_EXECUTABLES.every((path) => path.startsWith("/"))).toBe(true);
    expect(processIdentityArgs(process.pid)).toEqual([
      "-p",
      String(process.pid),
      "-o",
      "lstart=",
      "-o",
      "command=",
    ]);
    expect(
      isLockOwnerLive({
        pid: process.pid,
        token: "legacy-token",
        runnerId: "legacy-runner",
        startedAt: 1,
      } as unknown as LockOwner, identityDeps),
    ).toBe(false);
    const path = runnerLockPath("legacy-runner");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "legacy-token",
        runnerId: "legacy-runner",
        startedAt: 1,
      }),
      { mode: 0o600 },
    );
    expect(() => acquire("replacement-runner")).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
  });

  it("refuses recovery when a live runner owner identity lookup is unavailable", () => {
    const path = runnerLockPath("lookup-unavailable");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "live-owner",
        runnerId: "lookup-unavailable",
        startedAt: 1,
        processIdentity: "stored-live-identity",
      }),
      { mode: 0o600 },
    );
    let identityCalls = 0;
    const unavailable: LockIdentityDeps = {
      alive: (pid) => pid === process.pid,
      identity: () => (++identityCalls === 1 ? "new-runner-identity" : null),
    };
    expect(() => acquireRunnerLock("replacement", unavailable)).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(path)).toBe(true);
  });

  it("refuses recovery when a live recovery-guard identity lookup is unavailable", () => {
    const path = runnerLockPath("guard-lookup-unavailable");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        pid: 2_147_000_000,
        token: "dead-owner",
        runnerId: "guard-lookup-unavailable",
        startedAt: 1,
        processIdentity: "dead-identity",
      }),
      { mode: 0o600 },
    );
    const guard = `${path}.recovery`;
    mkdirSync(guard, { mode: 0o700 });
    writeFileSync(
      join(guard, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "live-guard",
        runnerId: "guard-lookup-unavailable",
        startedAt: 1,
        processIdentity: "stored-guard-identity",
      }),
      { mode: 0o600 },
    );
    let identityCalls = 0;
    const unavailable: LockIdentityDeps = {
      alive: (pid) => pid === process.pid,
      identity: () => (++identityCalls === 1 ? "new-runner-identity" : null),
    };
    expect(() => acquireRunnerLock("replacement", unavailable)).toThrowError(
      expect.objectContaining({ code: "RUNNER_ALREADY_ACTIVE" }),
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(guard)).toBe(true);
  });
});
