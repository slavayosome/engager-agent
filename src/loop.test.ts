import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import type { AgentEngine } from "./engine.js";
import type { ControlCycleDeps } from "./loop.js";
import { RunnerFault } from "./errors.js";
import { countsTowardHalt, faultCountsTowardHalt, runControlCycle } from "./loop.js";
import type { EngagerMcp } from "./mcp.js";

const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "runner-secret",
  credentialProfile: "runner",
  runnerId: "runner-test",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  model: "sonnet",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

const mcp = { close: vi.fn(async () => undefined) } as unknown as EngagerMcp;

function engine(ready: boolean): AgentEngine {
  return {
    name: "claude",
    detect: async () => ({
      name: "claude",
      installed: ready,
      supported: ready,
      authenticated: ready,
      ...(ready ? { version: "2.1.201" } : {}),
    }),
    run: async () => {
      throw new Error("not used by this control test");
    },
  };
}

function deps(overrides: Partial<ControlCycleDeps> = {}): ControlCycleDeps {
  return {
    engine: () => engine(true),
    connect: async () => ({
      mcp,
      negotiated: {
        protocol: "2.1",
        directive: {
          contractVersion: 2,
          serverSupportedVersion: { major: 2, minor: 1 },
          directive: "run",
          reason: "ok",
          workOrder: null,
        },
      },
    }),
    execute: vi.fn(async () => ({ ran: false, ok: true, note: "empty claim" })),
    hasJournal: () => false,
    ...overrides,
  };
}

const heartbeat = {
  state: "preflight" as const,
  consecutiveFailures: 0,
  sessionsToday: 0,
};

describe("fail-closed control loop", () => {
  it("persists the negotiated startup milestone before invoking the claim executor", async () => {
    const events: string[] = [];
    const execute = vi.fn(async () => {
      events.push("execute");
      return { ran: false, ok: true, note: "empty claim" };
    });
    await runControlCycle(
      config,
      "0.9.0",
      heartbeat,
      {
        onNegotiated: (protocol, _quota, engineReady) =>
          events.push(`negotiated:${protocol}:engine-${engineReady ? "ready" : "blocked"}`),
      },
      deps({ execute }),
    );
    expect(events).toEqual(["negotiated:2.1:engine-ready", "execute"]);
  });

  it("passes an explicit setup-proof claim purpose through to the executor", async () => {
    const execute = vi.fn(async () => ({ ran: false, ok: true, note: "proof empty" }));
    await runControlCycle(
      config,
      "0.9.0",
      heartbeat,
      { claimPurpose: "setup_proof" },
      deps({ execute }),
    );
    expect(execute).toHaveBeenCalledWith(
      config,
      mcp,
      expect.any(Object),
      expect.objectContaining({ claimPurpose: "setup_proof" }),
    );
  });
  it("does not claim when the engine is missing, but reports unavailable quota", async () => {
    const execute = vi.fn();
    const negotiated = vi.fn();
    const result = await runControlCycle(
      config,
      "0.9.0",
      heartbeat,
      { onNegotiated: negotiated },
      deps({
        engine: () => engine(false),
        execute,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(negotiated).toHaveBeenCalledWith(
      "2.1",
      expect.objectContaining({ reasonCode: "engine_not_found" }),
      false,
    );
    expect(result.outcome.errorCode).toBe("ENGINE_NOT_FOUND");
    expect(result.quotaState).toMatchObject({ status: "unavailable", reasonCode: "engine_not_found" });
  });

  it("propagates heartbeat/connect failure and never invents local work", async () => {
    const execute = vi.fn();
    await expect(
      runControlCycle(config, "0.9.0", heartbeat, {}, deps({
        connect: async () => {
          throw new Error("SERVER_UNREACHABLE");
        },
        execute,
      })),
    ).rejects.toThrow("SERVER_UNREACHABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the same claim executor every control cycle with no local draft cadence", async () => {
    const execute = vi.fn(async () => ({ ran: false, ok: true, note: "empty claim" }));
    const shared = deps({ execute });
    await runControlCycle(config, "0.9.0", heartbeat, {}, shared);
    await runControlCycle(config, "0.9.0", heartbeat, {}, shared);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not claim after the persisted daily provider-session ceiling", async () => {
    const execute = vi.fn();
    const result = await runControlCycle(
      config,
      "0.9.0",
      { ...heartbeat, sessionsToday: config.dailySessionCap },
      {},
      deps({ execute }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.quotaState).toMatchObject({ status: "exhausted", reasonCode: "local_daily_session_cap" });
  });

  it("never executes the retired v1 model path, even for migrated campaign config", async () => {
    const execute = vi.fn();
    const result = await runControlCycle(
      {
        ...config,
        legacy: { campaignId: 42, intervalMinutes: 60 },
      },
      "0.9.0",
      heartbeat,
      {},
      deps({
        connect: async () => ({
          mcp,
          negotiated: {
            protocol: "v1",
            directive: {
              directive: "run",
              reason: "ok",
              workOrder: null,
              intervalMinutes: 60,
              intervalMinutesBase: 60,
              runner: {},
            },
          },
        }),
        execute,
      }),
    );
    expect(result.outcome.errorCode).toBe("CONTRACT_UPGRADE_REQUIRED");
    expect(result.outcome.ran).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("obeys a server stop before any claim", async () => {
    const execute = vi.fn();
    const result = await runControlCycle(config, "0.9.0", heartbeat, {}, deps({
      connect: async () => ({
        mcp,
        negotiated: {
          protocol: "2.1",
          directive: {
            contractVersion: 2,
            serverSupportedVersion: { major: 2, minor: 1 },
            directive: "stop",
            reason: "campaign archived",
            code: "campaign_archived",
            workOrder: null,
          },
        },
      }),
      execute,
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome.errorCode).toBe("campaign_archived");
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.fatal).toBe(true);
  });

  it("still heartbeats server control when the local engine probe throws", async () => {
    const connect = vi.fn(deps().connect);
    const execute = vi.fn();
    const result = await runControlCycle(config, "0.9.0", heartbeat, {}, deps({
      engine: () => ({
        name: "claude",
        detect: async () => {
          throw new Error("probe subprocess crashed");
        },
        run: async () => {
          throw new Error("must not run");
        },
      }),
      connect,
      execute,
    }));
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[2].quotaState).toMatchObject({
      status: "error",
      reasonCode: "engine_probe_failed",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome.errorCode).toBe("ENGINE_FAILED");
  });

  it("reconciles an existing journal even when heartbeat is idle", async () => {
    const execute = vi.fn(async () => ({ ran: true, ok: true, note: "receipt replayed" }));
    const result = await runControlCycle(config, "0.9.0", heartbeat, {}, deps({
      hasJournal: () => true,
      connect: async () => ({
        mcp,
        negotiated: {
          protocol: "2.1",
          directive: {
            contractVersion: 2,
            serverSupportedVersion: { major: 2, minor: 1 },
            directive: "idle",
            reason: "no new work",
            workOrder: null,
          },
        },
      }),
      execute,
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(result.outcome.note).toBe("receipt replayed");
  });

  it("counts clock skew toward a durable halt", () => {
    expect(countsTowardHalt("CLOCK_SKEW")).toBe(true);
  });

  it("counts discarded structural submissions without counting ordinary stale-state discards", () => {
    const structural = new RunnerFault("VALIDATION_REJECTED", "invalid request", {
      impact: "discard",
      recovery: "upgrade",
      remoteCode: "invalid_submission",
      discardJournal: true,
    });
    const stale = new RunnerFault("VALIDATION_REJECTED", "stale context", {
      impact: "discard",
      recovery: "retry",
      remoteCode: "context_revision_mismatch",
      discardJournal: true,
    });
    expect(faultCountsTowardHalt(structural)).toBe(true);
    expect(faultCountsTowardHalt(stale)).toBe(false);
  });
});
