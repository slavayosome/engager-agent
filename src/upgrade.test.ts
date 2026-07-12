import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";
import { credentialFingerprint, writeDisconnectTransition } from "./disconnect-transition.js";
import type { JournalInspection } from "./journal.js";
import type { LockOwner } from "./lock.js";
import type { InstalledPayload, ServiceState } from "./service.js";
import {
  ensureServiceInstalledWithMaintenance,
  installServiceWithMaintenance,
  pauseAgentWithMaintenance,
  recoverInterruptedUpgrade,
  resumeAgentWithMaintenance,
  startServiceWithMaintenance,
  stopAgentWithMaintenance,
  uninstallServiceWithMaintenance,
  upgradeAgent,
  type UpgradeDeps,
} from "./upgrade.js";

const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "eng_runner_secret",
  credentialProfile: "runner",
  runnerId: "upgrade-test-runner",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  model: "sonnet",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

const payload: InstalledPayload = {
  version: "0.9.1",
  sha256: "a".repeat(64),
  versionDir: "/Users/test/.engager/runtime/versions/0.9.1-aaaaaaaaaaaaaaaa",
  versionEntryPath:
    "/Users/test/.engager/runtime/versions/0.9.1-aaaaaaaaaaaaaaaa/cli.mjs",
};

function fixture(overrides: Partial<UpgradeDeps> = {}) {
  const release = vi.fn();
  let maintenanceReleased = false;
  const releaseMaintenance = () => {
    if (maintenanceReleased) return;
    maintenanceReleased = true;
    release();
  };
  const executionRelease = vi.fn();
  const stage = vi.fn(() => payload);
  const activateStandalone = vi.fn(() => ({ ok: true, note: "activated standalone" }));
  const maintenance = vi.fn(() => ({
    path: "/tmp/maintenance.lock",
    owner: {
      pid: process.pid,
      token: "upgrade-token",
      runnerId: config.runnerId,
      startedAt: Date.now(),
      processIdentity: "test-maintenance-process",
    },
    release: releaseMaintenance,
  }));
  const execution = vi.fn(() => ({
    path: "/tmp/agent.lock",
    owner: {
      pid: process.pid,
      token: "execution-token",
      runnerId: config.runnerId,
      startedAt: Date.now(),
      processIdentity: "test-execution-process",
    },
    release: executionRelease,
  }));
  const deps: UpgradeDeps = {
    load: () => config,
    service: () => ({
      supported: true,
      installed: false,
      entryExists: false,
      loaded: false,
    }),
    serviceDisabled: () => false,
    owner: () => ({ state: "absent" }),
    ownerLive: () => false,
    journal: () => ({ state: "absent" }),
    maintenance,
    execution,
    now: Date.now,
    pause: () => undefined,
    stage,
    smoke: () => ({ ok: true, note: "verified" }),
    activateStandalone,
    repairService: () => ({ ok: true, note: "repaired" }),
    reconcileService: () => ({
      ok: true,
      recovered: false,
      note: "no interrupted service transition",
    }),
    startService: () => ({ ok: true, note: "started" }),
    stopService: () => ({ ok: true, note: "stopped" }),
    uninstallService: () => ({ ok: true, note: "uninstalled" }),
    signal: () => true,
    ...overrides,
  };
  return {
    deps,
    stage,
    activateStandalone,
    maintenance,
    execution,
    release,
    executionRelease,
  };
}

describe("upgrade command", () => {
  it("fails every upgrade and service lifecycle entry point closed during disconnect", () => {
    const prior = process.env.ENGAGER_AGENT_HOME;
    process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-upgrade-disconnect-fence-"));
    try {
      writeDisconnectTransition({
        schemaVersion: 1,
        protocolVersion: 1,
        phase: "prepared",
        createdAt: 1,
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        mcpUrl: config.mcpUrl,
        runnerId: config.runnerId,
        credentialFingerprint: credentialFingerprint(config.apiKey),
        priorService: { supported: true, installed: true, entryExists: true, loaded: false, disabled: true },
      });
      const test = fixture();
      const results = [
        upgradeAgent("0.9.1", test.deps),
        recoverInterruptedUpgrade(test.deps),
        installServiceWithMaintenance("0.9.1", test.deps),
        ensureServiceInstalledWithMaintenance("0.9.1", test.deps),
        startServiceWithMaintenance(test.deps),
        resumeAgentWithMaintenance(vi.fn(), test.deps),
        stopAgentWithMaintenance(test.deps),
        uninstallServiceWithMaintenance(test.deps),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, note: expect.stringContaining("DISCONNECT_PENDING") });
      }
      expect(test.maintenance).not.toHaveBeenCalled();
      expect(test.stage).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.ENGAGER_AGENT_HOME;
      else process.env.ENGAGER_AGENT_HOME = prior;
    }
  });

  it("rechecks the disconnect fence after acquiring maintenance to close the start race", () => {
    const prior = process.env.ENGAGER_AGENT_HOME;
    process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-upgrade-disconnect-race-"));
    try {
      const test = fixture();
      const acquire = test.deps.maintenance;
      test.deps.maintenance = (runnerId) => {
        writeDisconnectTransition({
          schemaVersion: 1,
          protocolVersion: 1,
          phase: "prepared",
          createdAt: 1,
          clientRequestId: "11111111-1111-4111-8111-111111111111",
          mcpUrl: config.mcpUrl,
          runnerId: config.runnerId,
          credentialFingerprint: credentialFingerprint(config.apiKey),
          priorService: { supported: true, installed: true, entryExists: true, loaded: false, disabled: true },
        });
        return acquire(runnerId);
      };
      expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
        ok: false,
        note: expect.stringContaining("DISCONNECT_PENDING"),
      });
      expect(test.stage).not.toHaveBeenCalled();
      expect(test.release).toHaveBeenCalledOnce();
    } finally {
      if (prior === undefined) delete process.env.ENGAGER_AGENT_HOME;
      else process.env.ENGAGER_AGENT_HOME = prior;
    }
  });

  it("does not upgrade from a config snapshot removed while waiting for maintenance", () => {
    let reads = 0;
    const test = fixture({ load: () => (++reads === 1 ? config : null) });
    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("changed runner configuration"),
    });
    expect(test.stage).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("does not apply a lifecycle callback from a stale pre-disconnect snapshot", () => {
    let reads = 0;
    const apply = vi.fn();
    const test = fixture({ load: () => (++reads === 1 ? config : null) });
    expect(pauseAgentWithMaintenance(apply, test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("changed runner configuration"),
    });
    expect(apply).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("refuses an active foreground runner before staging", () => {
    const owner: LockOwner = {
      pid: 42,
      token: "foreground-token",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified",
    };
    const test = fixture({ owner: () => ({ state: "valid", owner }), ownerLive: () => true });

    expect(upgradeAgent("0.9.1", test.deps)).toEqual({
      ok: false,
      note: expect.stringContaining("active foreground runner"),
    });
    expect(test.stage).not.toHaveBeenCalled();
    expect(test.maintenance).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("fails closed on legacy execution metadata without process identity", () => {
    const test = fixture({
      owner: () => ({ state: "invalid", detail: "owner metadata failed structural validation" }),
    });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("ownership is unsafe"),
    });
    expect(test.stage).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("refuses live or unverifiable journal authority", () => {
    const active = {
      state: "active",
      terminalAt: Date.now() + 60_000,
      journal: {},
    } as JournalInspection;
    const test = fixture({ journal: () => active });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("live lease authority"),
    });
    expect(test.maintenance).toHaveBeenCalledOnce();
    expect(
      upgradeAgent(
        "0.9.1",
        fixture({
          journal: () => ({ state: "invalid", detail: "unsafe" }),
        }).deps,
      ),
    ).toMatchObject({ ok: false, note: expect.stringContaining("unsafe or unverifiable") });
  });

  it("stages, smokes, and activates a standalone payload under maintenance", () => {
    const test = fixture();

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: true,
      note: expect.stringContaining("no service was installed"),
    });
    expect(test.stage).toHaveBeenCalledWith("0.9.1");
    expect(test.activateStandalone).toHaveBeenCalledWith(payload, "0.9.1");
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("requires an explicit retry after recovering an interrupted transition", () => {
    const test = fixture({
      reconcileService: () => ({
        ok: true,
        recovered: true,
        note: "restored the prior runtime",
      }),
    });
    expect(upgradeAgent("0.9.1", test.deps)).toEqual({
      ok: false,
      note: expect.stringContaining("UPGRADE_RECOVERED_RETRY_REQUIRED"),
    });
    expect(test.stage).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("repairs and verifies an installed service while allowing its matching lock owner", () => {
    const owner: LockOwner = {
      pid: 99,
      token: "service-token",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified-service",
    };
    const state: ServiceState = {
      supported: true,
      installed: true,
      entryExists: true,
      loaded: true,
      pid: owner.pid,
    };
    const ownerAfterStop = vi.fn().mockReturnValue({ state: "valid", owner });
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      options.afterServiceStopped().release();
      return { ok: true, note: "verified service" };
    });
    const test = fixture({
      service: () => state,
      owner: ownerAfterStop,
      ownerLive: () => true,
      repairService,
    });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: true,
      note: expect.stringContaining("installed service verified"),
    });
    expect(repairService).toHaveBeenCalledWith(
      "0.9.1",
      expect.objectContaining({
        maintenanceToken: "upgrade-token",
        afterServiceStopped: expect.any(Function),
        leaveStopped: false,
      }),
    );
    expect(test.stage).not.toHaveBeenCalled();
    expect(test.maintenance).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("repairs a stopped installed service without leaving it loaded", () => {
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      expect(options.leaveStopped).toBe(true);
      options.afterServiceStopped().release();
      return { ok: true, note: "repaired stopped service" };
    });
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: false,
      }),
      serviceDisabled: () => true,
      repairService,
    });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: true,
      note: expect.stringContaining("repaired stopped service"),
    });
    expect(repairService).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("rechecks journal authority after the old service stops and before activation", () => {
    const owner: LockOwner = {
      pid: 99,
      token: "service-token",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified-service",
    };
    const journal = vi.fn()
      .mockReturnValueOnce({ state: "absent" })
      .mockReturnValue({
        state: "active",
        terminalAt: Date.now() + 60_000,
        journal: {},
      } as JournalInspection);
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      options.afterServiceStopped();
      return { ok: true, note: "must not reach" };
    });
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: true,
        pid: owner.pid,
      }),
      owner: vi.fn().mockReturnValue({ state: "valid", owner }),
      ownerLive: () => true,
      journal,
      repairService,
    });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("prior service payload preserved"),
    });
    expect(test.activateStandalone).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("waits boundedly for the old service lock before handing startup to the tokened replacement", () => {
    const owner: LockOwner = {
      pid: 99,
      token: "service-token",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified-service",
    };
    let now = 0;
    const transitionRelease = vi.fn();
    const execution = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("old service is exiting");
      })
      .mockImplementationOnce(() => {
        throw new Error("old service is exiting");
      })
      .mockReturnValue({
        path: "/tmp/agent.lock",
        owner,
        release: transitionRelease,
      });
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      options.afterServiceStopped().release();
      return { ok: true, note: "verified service" };
    });
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: true,
        pid: owner.pid,
      }),
      owner: () => ({ state: "valid", owner }),
      ownerLive: () => true,
      execution,
      now: () => now,
      pause: (milliseconds) => {
        now += milliseconds;
      },
      repairService,
    });

    expect(upgradeAgent("0.9.1", test.deps).ok).toBe(true);
    expect(execution).toHaveBeenCalledTimes(3);
    expect(transitionRelease).toHaveBeenCalledOnce();
    expect(now).toBeGreaterThan(0);
  });

  it("keeps maintenance through the rollback execution-barrier handoff", () => {
    const events: string[] = [];
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: false,
      }),
      repairService: (_version, options) => {
        events.push("prior-link-and-plist-restored");
        const rollbackLock = options.beforeRollbackServiceStart();
        rollbackLock.release();
        events.push("prior-service-restarted");
        return { ok: false, note: "rolled back" };
      },
    });

    expect(upgradeAgent("0.9.1", test.deps)).toEqual({
      ok: false,
      note: "rolled back",
    });
    expect(events).toEqual([
      "prior-link-and-plist-restored",
      "prior-service-restarted",
    ]);
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("reports activation failure as rollback-preserved and releases the lock", () => {
    const test = fixture({
      activateStandalone: () => ({
        ok: false,
        note: "UPGRADE_RECOVERY_REQUIRED: activation rejected",
      }),
    });

    expect(upgradeAgent("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("activation rejected"),
    });
    expect(test.release).toHaveBeenCalledOnce();
  });
});

describe("fresh service install maintenance", () => {
  it("requires an explicit install retry after transition recovery", () => {
    const repairService = vi.fn<UpgradeDeps["repairService"]>();
    const test = fixture({
      reconcileService: () => ({
        ok: true,
        recovered: true,
        note: "restored the prior service",
      }),
      repairService,
    });
    expect(installServiceWithMaintenance("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("UPGRADE_RECOVERED_RETRY_REQUIRED"),
    });
    expect(repairService).not.toHaveBeenCalled();
  });

  it("refuses unsupported platforms before service mutation", () => {
    const test = fixture({
      service: () => ({
        supported: false,
        installed: false,
        entryExists: false,
        loaded: false,
      }),
    });
    expect(installServiceWithMaintenance("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("macOS-only"),
    });
  });

  it("fails closed on live or unverifiable execution and active lease journals", () => {
    const live = fixture({
      execution: () => {
        throw new Error("live foreground owner is unverifiable");
      },
    });
    expect(installServiceWithMaintenance("0.9.1", live.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("live or unverifiable execution"),
    });

    const journal = fixture({
      journal: () => ({
        state: "active",
        terminalAt: Date.now() + 60_000,
        journal: {},
      } as JournalInspection),
    });
    expect(installServiceWithMaintenance("0.9.1", journal.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("live lease authority"),
    });
  });

  it("refuses a concurrent repair or upgrade maintenance owner", () => {
    const test = fixture({
      maintenance: () => {
        throw new Error("maintenance already active");
      },
    });
    expect(installServiceWithMaintenance("0.9.1", test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("could not acquire maintenance"),
    });
  });

  it("passes exact running-intent and transition barriers to a fresh install", () => {
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      expect(options).toMatchObject({
        maintenanceToken: "upgrade-token",
        leaveStopped: false,
        priorLoaded: false,
        priorDisabled: false,
        targetDisabled: false,
      });
      options.afterServiceStopped().release();
      return { ok: true, note: "installed safely" };
    });
    const test = fixture({ repairService });
    expect(installServiceWithMaintenance("0.9.1", test.deps)).toEqual({
      ok: true,
      note: "installed safely",
    });
    expect(repairService).toHaveBeenCalledOnce();
  });
});

describe("serialized lifecycle commands", () => {
  it("reconciles and hands the exact maintenance capability to start before release", () => {
    const events: string[] = [];
    const startService = vi.fn<UpgradeDeps["startService"]>((token) => {
      events.push(`start:${token}`);
      return { ok: true, note: "started safely" };
    });
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: false,
      }),
      reconcileService: () => {
        events.push("reconcile");
        return { ok: true, recovered: false, note: "clean" };
      },
      startService,
    });
    test.release.mockImplementation(() => events.push("release-maintenance"));

    expect(startServiceWithMaintenance(test.deps)).toEqual({
      ok: true,
      note: "started safely",
    });
    expect(events).toEqual([
      "reconcile",
      "start:upgrade-token",
      "release-maintenance",
    ]);
  });

  it("fails before every lifecycle mutator while a pre-journal upgrade owns maintenance", () => {
    const startService = vi.fn<UpgradeDeps["startService"]>();
    const stopService = vi.fn<UpgradeDeps["stopService"]>();
    const uninstallService = vi.fn<UpgradeDeps["uninstallService"]>();
    const applyResume = vi.fn();
    const test = fixture({
      maintenance: () => {
        throw new Error("pre-journal upgrade is staging");
      },
      startService,
      stopService,
      uninstallService,
    });

    for (const result of [
      startServiceWithMaintenance(test.deps),
      resumeAgentWithMaintenance(applyResume, test.deps),
      stopAgentWithMaintenance(test.deps),
      uninstallServiceWithMaintenance(test.deps),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        note: expect.stringContaining("could not acquire lifecycle maintenance"),
      });
    }
    expect(startService).not.toHaveBeenCalled();
    expect(applyResume).not.toHaveBeenCalled();
    expect(stopService).not.toHaveBeenCalled();
    expect(uninstallService).not.toHaveBeenCalled();
  });

  it("reconciles a journaled upgrade under the same lock before stopping", () => {
    const events: string[] = [];
    const stopService = vi.fn<UpgradeDeps["stopService"]>(() => {
      events.push("stop-service");
      return { ok: true, note: "stopped" };
    });
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: false,
      }),
      reconcileService: () => {
        events.push("recover-journal");
        return { ok: true, recovered: true, note: "restored prior" };
      },
      stopService,
    });
    test.release.mockImplementation(() => events.push("release-maintenance"));

    expect(stopAgentWithMaintenance(test.deps)).toMatchObject({ ok: true });
    expect(events).toEqual([
      "recover-journal",
      "stop-service",
      "release-maintenance",
    ]);
  });

  it("reconciles a journaled transition before clearing resume markers or starting", () => {
    const events: string[] = [];
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: false,
      }),
      reconcileService: () => {
        events.push("recover-journal");
        return { ok: true, recovered: true, note: "restored prior" };
      },
      startService: (token) => {
        events.push(`start:${token}`);
        return { ok: true, note: "started" };
      },
    });
    test.release.mockImplementation(() => events.push("release-maintenance"));

    expect(
      resumeAgentWithMaintenance(() => events.push("clear-local-resume"), test.deps),
    ).toMatchObject({ ok: true });
    expect(events).toEqual([
      "recover-journal",
      "clear-local-resume",
      "start:upgrade-token",
      "release-maintenance",
    ]);
  });

  it("never signals or mutates through invalid execution ownership", () => {
    const stopService = vi.fn<UpgradeDeps["stopService"]>();
    const signal = vi.fn<UpgradeDeps["signal"]>();
    const test = fixture({
      owner: () => ({ state: "invalid", detail: "owner metadata is missing" }),
      stopService,
      signal,
    });

    expect(stopAgentWithMaintenance(test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("nothing was signaled or removed"),
    });
    expect(stopService).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("leaves resume state untouched when execution ownership is invalid", () => {
    const applyResume = vi.fn();
    const startService = vi.fn<UpgradeDeps["startService"]>();
    const test = fixture({
      owner: () => ({ state: "invalid", detail: "owner metadata is malformed" }),
      startService,
    });
    expect(resumeAgentWithMaintenance(applyResume, test.deps)).toMatchObject({
      ok: false,
      note: expect.stringContaining("ownership is unsafe"),
    });
    expect(applyResume).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();
  });

  it("uninstalls only after transition reconciliation and waits for a loaded service owner", () => {
    const owner: LockOwner = {
      pid: 99,
      token: "service-owner",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified",
    };
    const uninstallService = vi.fn<UpgradeDeps["uninstallService"]>(() => ({
      ok: true,
      note: "uninstalled",
    }));
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: true,
        pid: owner.pid,
      }),
      owner: vi.fn()
        .mockReturnValueOnce({ state: "valid", owner })
        .mockReturnValue({ state: "valid", owner }),
      ownerLive: () => true,
      uninstallService,
    });

    expect(uninstallServiceWithMaintenance(test.deps)).toMatchObject({ ok: true });
    expect(uninstallService).toHaveBeenCalledOnce();
    expect(test.execution).toHaveBeenCalledWith(config.runnerId, "upgrade-token");
  });

  it("keeps maintenance until a loaded service exits even when uninstall reports a partial failure", () => {
    const owner: LockOwner = {
      pid: 99,
      token: "service-owner",
      runnerId: config.runnerId,
      startedAt: 1,
      processIdentity: "verified",
    };
    const test = fixture({
      service: () => ({
        supported: true,
        installed: true,
        entryExists: true,
        loaded: true,
        pid: owner.pid,
      }),
      owner: () => ({ state: "valid", owner }),
      ownerLive: () => true,
      uninstallService: () => ({ ok: false, note: "disable failed after bootout" }),
    });

    expect(uninstallServiceWithMaintenance(test.deps)).toEqual({
      ok: false,
      note: "disable failed after bootout",
    });
    expect(test.execution).toHaveBeenCalledWith(config.runnerId, "upgrade-token");
    expect(test.release).toHaveBeenCalledOnce();
  });
});

describe("idempotent service install", () => {
  it("decides fresh install under maintenance after transition reconciliation", () => {
    const events: string[] = [];
    const repairService = vi.fn<UpgradeDeps["repairService"]>((_version, options) => {
      events.push("install-service");
      expect(options).toMatchObject({
        priorLoaded: false,
        targetDisabled: false,
        leaveStopped: false,
      });
      options.afterServiceStopped().release();
      return { ok: true, note: "installed safely" };
    });
    const test = fixture({
      reconcileService: () => {
        events.push("reconcile");
        return { ok: true, recovered: false, note: "clean" };
      },
      service: () => {
        events.push("read-service-state");
        return {
          supported: true,
          installed: false,
          entryExists: false,
          loaded: false,
        };
      },
      repairService,
    });
    test.release.mockImplementation(() => events.push("release-maintenance"));

    expect(ensureServiceInstalledWithMaintenance("0.9.1", test.deps)).toEqual({
      ok: true,
      note: "installed safely",
    });
    expect(events).toEqual([
      "reconcile",
      "read-service-state",
      "install-service",
      "release-maintenance",
    ]);
    expect(test.stage).not.toHaveBeenCalled();
  });
});
