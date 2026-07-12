import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import {
  runOnce,
  setupProofOrganizationIdFromArgs,
  USAGE,
  type RunOnceDeps,
} from "./cli.js";
import { RunnerFault } from "./errors.js";
import type { RunnerStatus } from "./status.js";

const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "runner-secret",
  credentialProfile: "runner",
  runnerId: "runner-cli-test",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  model: "sonnet",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

const priorExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = priorExitCode;
});

function dependencies(overrides: Partial<RunOnceDeps> = {}) {
  const persisted: RunnerStatus[] = [];
  const markHalt = vi.fn();
  const output = vi.fn();
  const terminal = vi.fn(async () => ({
    protocol: "2.1" as const,
    directive: {
      contractVersion: 2 as const,
      serverSupportedVersion: { major: 2 as const, minor: 1 },
      directive: "idle" as const,
      reason: "terminal",
      workOrder: null,
    },
  }));
  const deps: RunOnceDeps = {
    load: () => config,
    halt: () => null,
    pause: () => null,
    status: () => null,
    lock: () => ({
      path: "/tmp/test.lock",
      owner: {
        pid: process.pid,
        token: "test-token",
        runnerId: config.runnerId,
        startedAt: Date.now(),
        processIdentity: "test-process",
      },
      release: vi.fn(),
    }),
    cycle: vi.fn(async () => ({
      protocol: "2.1" as const,
      quotaState: { status: "available", observedAt: Date.now() },
      outcome: { ran: false, ok: true, note: "empty" },
    })),
    save: vi.fn(),
    clearProofJournal: vi.fn(),
    persist: (status) => persisted.push(status),
    terminal,
    markHalt,
    sessions: vi.fn(() => 0),
    output,
    ...overrides,
  };
  return { deps, persisted, markHalt, terminal };
}

describe("run --once parity", () => {
  it("claims only setup-proof work and clears the local binding after an accepted receipt", async () => {
    const pendingConfig: AgentConfig = {
      ...config,
      pendingSetupProofOrganizationId: "11111111-1111-4111-8111-111111111111",
    };
    const save = vi.fn();
    const clearProofJournal = vi.fn();
    const cycle = vi.fn(async (_config, _version, _state, options) => {
      expect(options.claimPurpose).toBe("setup_proof");
      return {
        protocol: "2.1" as const,
        quotaState: { status: "available", observedAt: Date.now() },
        outcome: {
          ran: true,
          ok: true,
          note: "proof accepted",
          workOrderId: "22222222-2222-4222-8222-222222222222",
          lane: "triage" as const,
          workPurpose: "setup_proof" as const,
          completion: {
            contractVersion: 2 as const,
            workOrderId: "22222222-2222-4222-8222-222222222222",
            lane: "triage" as const,
            status: "completed" as const,
            completedAt: Date.now(),
            result: {
              accepted: 1,
              rejected: 0,
              alreadyExists: 0,
              failed: 0,
              unfinished: 0,
            },
          },
        },
      };
    });
    const fixture = dependencies({
      load: () => pendingConfig,
      cycle,
      save,
      clearProofJournal,
    });

    await runOnce(fixture.deps);

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty(
      "pendingSetupProofOrganizationId",
    );
    expect(clearProofJournal).toHaveBeenCalledOnce();
    expect(process.exitCode).not.toBe(1);
  });

  it("retains the proof journal when clearing the local marker fails", async () => {
    const pendingConfig: AgentConfig = {
      ...config,
      pendingSetupProofOrganizationId: "11111111-1111-4111-8111-111111111111",
    };
    const clearProofJournal = vi.fn();
    const cycle = vi.fn(async () => ({
      protocol: "2.1" as const,
      quotaState: { status: "available", observedAt: Date.now() },
      outcome: {
        ran: true,
        ok: true,
        note: "proof accepted",
        workOrderId: "22222222-2222-4222-8222-222222222222",
        lane: "triage" as const,
        workPurpose: "setup_proof" as const,
        completion: {
          contractVersion: 2 as const,
          workOrderId: "22222222-2222-4222-8222-222222222222",
          lane: "triage" as const,
          status: "completed" as const,
          completedAt: Date.now(),
          result: {
            accepted: 1,
            rejected: 0,
            alreadyExists: 0,
            failed: 0,
            unfinished: 0,
          },
        },
      },
    }));
    const fixture = dependencies({
      load: () => pendingConfig,
      cycle,
      save: () => {
        throw new Error("disk full before marker commit");
      },
      clearProofJournal,
    });

    await runOnce(fixture.deps);

    expect(clearProofJournal).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("retains the setup-proof binding until the receipt is accepted", async () => {
    const pendingConfig: AgentConfig = {
      ...config,
      pendingSetupProofOrganizationId: "11111111-1111-4111-8111-111111111111",
    };
    const save = vi.fn();
    const fixture = dependencies({ load: () => pendingConfig, save });

    await runOnce(fixture.deps);

    expect(save).not.toHaveBeenCalled();
  });

  it("persists the crash-safe provider-session ledger count after a thrown attempt", async () => {
    const fixture = dependencies({
      status: () => ({
        schemaVersion: 2,
        pid: 1,
        version: "0.9.0",
        runnerId: config.runnerId,
        engine: "claude",
        state: "stopped",
        startedAt: 1,
        updatedAt: 1,
        consecutiveFailures: 1,
        sessionsToday: 5,
        sessionDay: new Date().toISOString().slice(0, 10),
      }),
      cycle: vi.fn(async (_config, _version, _state, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        throw new RunnerFault("ENGINE_TIMEOUT", "provider timed out", {
          impact: "test",
          recovery: "test",
          engineAttempted: true,
        });
      }),
      sessions: vi.fn().mockReturnValueOnce(5).mockReturnValue(6),
    });
    await runOnce(fixture.deps);
    expect(fixture.persisted.at(-1)).toMatchObject({
      sessionsToday: 6,
      consecutiveFailures: 1,
      state: "stopped",
      lastCycle: { errorCode: "ENGINE_TIMEOUT", ok: false },
    });
    expect(fixture.terminal).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("persists a server fatal directive as a real halt", async () => {
    const fixture = dependencies({
      cycle: vi.fn(async () => ({
        protocol: "2.1" as const,
        quotaState: { status: "available", observedAt: Date.now() },
        outcome: {
          ran: false,
          ok: false,
          note: "server stop: kill switch",
          errorCode: "kill_switch",
          fatal: true,
        },
      })),
    });
    await runOnce(fixture.deps);
    expect(fixture.markHalt).toHaveBeenCalledOnce();
    expect(fixture.persisted.at(-1)?.state).toBe("halted");
    expect(process.exitCode).toBe(1);
  });

  it("halts after a third discarded structural submission failure", async () => {
    const fixture = dependencies({
      status: () => ({
        schemaVersion: 2,
        pid: 1,
        version: "0.9.0",
        runnerId: config.runnerId,
        engine: "claude",
        state: "stopped",
        startedAt: 1,
        updatedAt: 1,
        consecutiveFailures: 2,
        sessionsToday: 2,
        sessionDay: new Date().toISOString().slice(0, 10),
      }),
      cycle: vi.fn(async () => {
        throw new RunnerFault("VALIDATION_REJECTED", "server rejected malformed structure", {
          impact: "discard request",
          recovery: "upgrade contract",
          remoteCode: "invalid_submission",
          discardJournal: true,
        });
      }),
    });
    await runOnce(fixture.deps);
    expect(fixture.markHalt).toHaveBeenCalledOnce();
    expect(fixture.persisted.at(-1)).toMatchObject({
      consecutiveFailures: 3,
      state: "halted",
    });
  });
});

describe("setup authorization arguments", () => {
  it("advertises the canonical package-manager upgrade command", () => {
    expect(USAGE).toContain("npx engager-agent@latest upgrade");
  });

  it("parses a purpose-bound project id and rejects a missing value", () => {
    expect(
      setupProofOrganizationIdFromArgs([
        "setup",
        "--setup-proof-org",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(setupProofOrganizationIdFromArgs(["setup"])).toBeUndefined();
    expect(() =>
      setupProofOrganizationIdFromArgs([
        "setup",
        "--setup-proof-org",
        "--reauthorize",
      ]),
    ).toThrow(/requires an Engager project UUID/);
  });
});
