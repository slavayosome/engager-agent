import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRunnerLock,
  isLockOwnerLive,
  processIdentityArgs,
  runnerLockPath,
  TRUSTED_PROCESS_IDENTITY_EXECUTABLES,
  type LockIdentityDeps,
} from "./lock.js";

let prior: string | undefined;
const identityDeps: LockIdentityDeps = {
  identity: (pid) => (pid === process.pid ? "test-process-start" : null),
  alive: (pid) => pid === process.pid,
};
const acquire = (runnerId: string) => acquireRunnerLock(runnerId, identityDeps);
beforeEach(() => {
  prior = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-lock-test-"));
});
afterEach(() => {
  if (prior === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = prior;
});

describe("runner singleton", () => {
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
      JSON.stringify({ pid: 2_147_000_000, token: "stale", runnerId: "runner-stale", startedAt: 1 }),
      { mode: 0o600 },
    );
    const current = acquire("runner-stale");
    expect(current.owner.pid).toBe(process.pid);
    current.release();
    const next = acquire("runner-stale");
    next.release();
  });

  it("recovers a dead or crash-abandoned recovery guard", () => {
    const path = runnerLockPath("runner-stale-guard");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ pid: 2_147_000_000, token: "stale", runnerId: "runner-stale-guard", startedAt: 1 }),
      { mode: 0o600 },
    );
    mkdirSync(`${path}.recovery`, { mode: 0o700 });
    const current = acquire("runner-stale-guard");
    expect(current.owner.pid).toBe(process.pid);
    current.release();
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
      }, identityDeps),
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
