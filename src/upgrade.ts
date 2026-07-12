import { loadConfig } from "./config.js";
import { inspectJournal, type JournalInspection } from "./journal.js";
import {
  acquireMaintenanceLock,
  acquireRunnerLock,
  inspectRunnerLock,
  isLockOwnerLive,
  type LockInspection,
  type LockOwner,
  type RunnerLock,
} from "./lock.js";
import {
  activateStandaloneDurablePayload,
  installDurablePayload,
  installService,
  reconcileServiceUpgradeTransition,
  serviceDisabledState,
  serviceState,
  smokeDurablePayload,
  startServiceWithMaintenanceToken,
  stopService,
  uninstallService,
  type InstalledPayload,
  type ServiceState,
} from "./service.js";

export type UpgradeResult = { ok: boolean; note: string };

export type UpgradeDeps = {
  load: typeof loadConfig;
  service: () => ServiceState;
  serviceDisabled: () => boolean | null;
  owner: (runnerId: string) => LockInspection;
  ownerLive: (owner: LockOwner) => boolean;
  journal: () => JournalInspection;
  maintenance: (runnerId: string) => RunnerLock;
  execution: (runnerId: string, maintenanceToken: string) => RunnerLock;
  now: () => number;
  pause: (milliseconds: number) => void;
  stage: (version: string) => InstalledPayload;
  smoke: (payload: InstalledPayload, version: string) => UpgradeResult;
  activateStandalone: typeof activateStandaloneDurablePayload;
  repairService: (
    version: string,
    options: {
      maintenanceToken: string;
      afterServiceStopped: () => { release(): void };
      beforeRollbackServiceStart: () => { release(): void };
      leaveStopped: boolean;
      priorLoaded: boolean;
      priorDisabled: boolean;
      targetDisabled: boolean;
    },
  ) => UpgradeResult;
  reconcileService: typeof reconcileServiceUpgradeTransition;
  startService: typeof startServiceWithMaintenanceToken;
  stopService: typeof stopService;
  uninstallService: typeof uninstallService;
  signal: (pid: number, signal: NodeJS.Signals) => unknown;
};

const REAL_UPGRADE_DEPS: UpgradeDeps = {
  load: loadConfig,
  service: serviceState,
  serviceDisabled: serviceDisabledState,
  owner: inspectRunnerLock,
  ownerLive: isLockOwnerLive,
  journal: inspectJournal,
  maintenance: acquireMaintenanceLock,
  execution: (runnerId, maintenanceToken) =>
    acquireRunnerLock(runnerId, undefined, maintenanceToken),
  now: Date.now,
  pause: (milliseconds) => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, milliseconds);
  },
  stage: installDurablePayload,
  smoke: (payload, version) => smokeDurablePayload(payload, version),
  activateStandalone: activateStandaloneDurablePayload,
  repairService: installService,
  reconcileService: reconcileServiceUpgradeTransition,
  startService: startServiceWithMaintenanceToken,
  stopService,
  uninstallService,
  signal: (pid, signal) => process.kill(pid, signal),
};

/** Upgrade only the signed-off runner payload invoked by this command. Server
 * authority, credentials, config, work receipts, and provider state are never
 * migrated here. */
export function upgradeAgent(
  version: string,
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  const config = deps.load();
  let maintenance: RunnerLock;
  try {
    maintenance = deps.maintenance(config?.runnerId ?? "global");
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: another upgrade transition is active or unverifiable: ${errorMessage(error)}`,
    };
  }
  try {
    const preflightOwner = deps.owner(config?.runnerId ?? "global");
    if (preflightOwner.state === "invalid") {
      return unsafeLifecycleOwner(preflightOwner.detail);
    }
    const recovery = reconcileUnderMaintenance(
      deps,
      config?.runnerId ?? "global",
      maintenance,
    );
    if (!recovery.ok) return recovery;
    if (recovery.recovered) {
      return {
        ok: false,
        note: `UPGRADE_RECOVERED_RETRY_REQUIRED: ${recovery.note}; rerun \`engager-agent upgrade\` to install the requested version`,
      };
    }
    const state = deps.service();
    const priorDisabled = state.installed ? deps.serviceDisabled() : false;
    if (state.installed && priorDisabled == null) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: launchd enabled/disabled intent could not be determined",
      };
    }
    const ownerInspection = deps.owner(config?.runnerId ?? "global");
    if (ownerInspection.state === "invalid") {
      return {
        ok: false,
        note: `UPGRADE_BLOCKED: execution lock ownership is unsafe: ${ownerInspection.detail}`,
      };
    }
    const owner = ownerInspection.state === "valid" ? ownerInspection.owner : null;
    const liveOwner = owner != null && deps.ownerLive(owner);
    const serviceOwnsLock = Boolean(
      liveOwner && state.loaded && state.pid != null && owner?.pid === state.pid,
    );

    if (liveOwner && !serviceOwnsLock) {
      return {
        ok: false,
        note:
          "UPGRADE_BLOCKED: an active foreground runner owns the execution lock; stop it before upgrading",
      };
    }
    if (state.loaded && !serviceOwnsLock) {
      return {
        ok: false,
        note:
          "UPGRADE_BLOCKED: the loaded service does not have a verifiable matching runner lock; run `engager-agent stop`, then retry",
      };
    }

    if (!serviceOwnsLock) {
      try {
        const idleBarrier = acquireExecutionBarrier(
          deps,
          config?.runnerId ?? "global",
          maintenance.owner.token,
          0,
        );
        idleBarrier.release();
      } catch (error) {
        return {
          ok: false,
          note: `UPGRADE_BLOCKED: the existing execution lock is live or unverifiable: ${errorMessage(error)}`,
        };
      }
    }

    const journalBlock = unsafeJournalNote(deps.journal());
    if (journalBlock) return { ok: false, note: journalBlock };

    if (state.installed) {
      try {
        const repaired = deps.repairService(version, {
          maintenanceToken: maintenance.owner.token,
          afterServiceStopped: () => {
            const transitionLock = acquireExecutionBarrier(
              deps,
              config?.runnerId ?? "global",
              maintenance.owner.token,
              5_000,
            );
            try {
              const stoppedJournalBlock = unsafeJournalNote(deps.journal());
              if (stoppedJournalBlock) throw new Error(stoppedJournalBlock);
              return transitionLock;
            } catch (error) {
              transitionLock.release();
              throw error;
            }
          },
          beforeRollbackServiceStart: () =>
            acquireExecutionBarrier(
              deps,
              config?.runnerId ?? "global",
              maintenance.owner.token,
              5_000,
            ),
          leaveStopped: priorDisabled === true,
          priorLoaded: state.loaded,
          priorDisabled: priorDisabled === true,
          targetDisabled: priorDisabled === true,
        });
        return repaired.ok
          ? {
              ok: true,
              note: `upgrade activated and installed service verified — ${repaired.note}`,
            }
          : repaired;
      } catch (error) {
        return {
          ok: false,
          note: `SERVICE_ENTRY_MISSING: upgrade failed with the prior service payload preserved: ${errorMessage(error)}`,
        };
      }
    }

    const payload = deps.stage(version);
    const smoke = deps.smoke(payload, version);
    if (!smoke.ok) return smoke;
    const activation = deps.activateStandalone(payload, version);
    if (!activation.ok) {
      const restored = reconcileUnderMaintenance(
        deps,
        config?.runnerId ?? "global",
        maintenance,
      );
      return {
        ok: false,
        note: `${activation.note}; ${restored.ok ? restored.note : restored.note}`,
      };
    }
    return {
      ok: true,
      note:
        `${activation.note} at ~/.engager/runtime/current/cli.mjs; no service was installed`,
    };
  } catch (error) {
    return {
      ok: false,
      note: `SERVICE_ENTRY_MISSING: upgrade failed with the prior durable payload preserved: ${errorMessage(error)}`,
    };
  } finally {
    maintenance.release();
  }
}

export function recoverInterruptedUpgrade(
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult & { recovered?: boolean } {
  const config = deps.load();
  let maintenance: RunnerLock;
  try {
    maintenance = deps.maintenance(config?.runnerId ?? "global");
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: recovery could not acquire maintenance: ${errorMessage(error)}`,
    };
  }
  try {
    const owner = deps.owner(config?.runnerId ?? "global");
    if (owner.state === "invalid") return unsafeLifecycleOwner(owner.detail);
    return reconcileUnderMaintenance(
      deps,
      config?.runnerId ?? "global",
      maintenance,
    );
  } finally {
    maintenance.release();
  }
}

export function installServiceWithMaintenance(
  version: string,
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  const config = deps.load();
  if (!config) {
    return { ok: false, note: "RUNNER_NOT_CONFIGURED: run `engager-agent setup` first" };
  }
  let maintenance: RunnerLock;
  try {
    maintenance = deps.maintenance(config.runnerId);
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: service install could not acquire maintenance: ${errorMessage(error)}`,
    };
  }
  try {
    const owner = deps.owner(config.runnerId);
    if (owner.state === "invalid") return unsafeLifecycleOwner(owner.detail);
    const recovery = reconcileUnderMaintenance(deps, config.runnerId, maintenance);
    if (!recovery.ok) return recovery;
    if (recovery.recovered) {
      return {
        ok: false,
        note: `UPGRADE_RECOVERED_RETRY_REQUIRED: ${recovery.note}; rerun the service install after recovery`,
      };
    }
    const state = deps.service();
    if (!state.supported) {
      return {
        ok: false,
        note: "native background service is macOS-only; use `engager-agent run`",
      };
    }
    if (state.installed) {
      return { ok: false, note: "service is already installed; use `engager-agent service repair`" };
    }
    const priorDisabled = deps.serviceDisabled();
    if (priorDisabled == null) {
      return { ok: false, note: "launchd enabled/disabled intent could not be determined" };
    }
    try {
      const idle = acquireExecutionBarrier(
        deps,
        config.runnerId,
        maintenance.owner.token,
        0,
      );
      idle.release();
    } catch (error) {
      return {
        ok: false,
        note: `UPGRADE_BLOCKED: fresh install found live or unverifiable execution: ${errorMessage(error)}`,
      };
    }
    const journalBlock = unsafeJournalNote(deps.journal());
    if (journalBlock) return { ok: false, note: journalBlock };
    return deps.repairService(version, {
      maintenanceToken: maintenance.owner.token,
      afterServiceStopped: () => {
        const transition = acquireExecutionBarrier(
          deps,
          config.runnerId,
          maintenance.owner.token,
          5_000,
        );
        try {
          const stoppedJournalBlock = unsafeJournalNote(deps.journal());
          if (stoppedJournalBlock) throw new Error(stoppedJournalBlock);
          return transition;
        } catch (error) {
          transition.release();
          throw error;
        }
      },
      beforeRollbackServiceStart: () =>
        acquireExecutionBarrier(
          deps,
          config.runnerId,
          maintenance.owner.token,
          5_000,
        ),
      leaveStopped: false,
      priorLoaded: false,
      priorDisabled,
      targetDisabled: false,
    });
  } finally {
    maintenance.release();
  }
}

/** `service install` is idempotent: decide fresh install versus repair only
 * after maintenance is held and any transition journal has been reconciled. */
export function ensureServiceInstalledWithMaintenance(
  version: string,
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  return withLifecycleMaintenance("service install", deps, (config, maintenance) => {
    if (!config) {
      return { ok: false, note: "RUNNER_NOT_CONFIGURED: run `engager-agent setup` first" };
    }
    const state = deps.service();
    if (!state.supported) {
      return { ok: false, note: "native background service is macOS-only; use `engager-agent run`" };
    }
    const priorDisabled = deps.serviceDisabled();
    if (priorDisabled == null) {
      return { ok: false, note: "launchd enabled/disabled intent could not be determined" };
    }
    const ownerInspection = deps.owner(config.runnerId);
    if (ownerInspection.state === "invalid") return unsafeLifecycleOwner(ownerInspection.detail);
    const owner = ownerInspection.state === "valid" ? ownerInspection.owner : null;
    const liveOwner = owner != null && deps.ownerLive(owner);
    const serviceOwnsLock = Boolean(
      liveOwner && state.loaded && state.pid != null && owner?.pid === state.pid,
    );
    if (liveOwner && !serviceOwnsLock) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: an active foreground runner owns execution; stop it before installing the service",
      };
    }
    if (state.loaded && !serviceOwnsLock) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: loaded service ownership could not be verified before install/repair",
      };
    }
    if (!serviceOwnsLock) {
      try {
        const idle = acquireExecutionBarrier(
          deps,
          config.runnerId,
          maintenance.owner.token,
          0,
        );
        idle.release();
      } catch (error) {
        return {
          ok: false,
          note: `UPGRADE_BLOCKED: service install found live or unverifiable execution: ${errorMessage(error)}`,
        };
      }
    }
    const journalBlock = unsafeJournalNote(deps.journal());
    if (journalBlock) return { ok: false, note: journalBlock };
    const targetDisabled = state.installed ? priorDisabled : false;
    const repaired = deps.repairService(version, {
      maintenanceToken: maintenance.owner.token,
      afterServiceStopped: () => {
        const transition = acquireExecutionBarrier(
          deps,
          config.runnerId,
          maintenance.owner.token,
          5_000,
        );
        try {
          const stoppedJournalBlock = unsafeJournalNote(deps.journal());
          if (stoppedJournalBlock) throw new Error(stoppedJournalBlock);
          return transition;
        } catch (error) {
          transition.release();
          throw error;
        }
      },
      beforeRollbackServiceStart: () =>
        acquireExecutionBarrier(
          deps,
          config.runnerId,
          maintenance.owner.token,
          5_000,
        ),
      leaveStopped: targetDisabled,
      priorLoaded: state.loaded,
      priorDisabled,
      targetDisabled,
    });
    return repaired.ok && state.installed
      ? { ok: true, note: `installed service repaired and verified — ${repaired.note}` }
      : repaired;
  });
}

/** All launchd lifecycle mutations share the same maintenance boundary as an
 * upgrade. A pending transition is reconciled while that lock remains held;
 * no command can observe recovery, release maintenance, and then race another
 * mutator before acting. */
export function startServiceWithMaintenance(
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  return withLifecycleMaintenance("start", deps, (config, maintenance) => {
    if (!config) {
      return { ok: false, note: "RUNNER_NOT_CONFIGURED: run `engager-agent setup` first" };
    }
    const state = deps.service();
    const ownerInspection = deps.owner(config.runnerId);
    if (ownerInspection.state === "invalid") return unsafeLifecycleOwner(ownerInspection.detail);
    const owner = ownerInspection.state === "valid" ? ownerInspection.owner : null;
    if (state.loaded) {
      return owner && state.pid === owner.pid && deps.ownerLive(owner)
        ? { ok: true, note: "com.engager.agent is already running with a verified execution owner" }
        : {
            ok: false,
            note: "UPGRADE_BLOCKED: launchd reports a loaded service without a matching verified execution owner",
          };
    }
    if (!state.installed) {
      return { ok: false, note: "SERVICE_ENTRY_MISSING: service is not installed" };
    }
    if (owner && deps.ownerLive(owner)) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: a verified foreground runner owns execution; stop it before starting the service",
      };
    }
    return deps.startService(maintenance.owner.token);
  });
}

export function resumeAgentWithMaintenance(
  applyLocalResume: () => void,
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  return withLifecycleMaintenance("resume", deps, (config, maintenance) => {
    const runnerId = config?.runnerId ?? "global";
    const state = deps.service();
    const ownerInspection = deps.owner(runnerId);
    if (ownerInspection.state === "invalid") return unsafeLifecycleOwner(ownerInspection.detail);
    const owner = ownerInspection.state === "valid" ? ownerInspection.owner : null;
    const liveOwner = owner != null && deps.ownerLive(owner);
    if (
      state.loaded &&
      (!owner || state.pid !== owner.pid || !liveOwner)
    ) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: loaded service ownership could not be verified before resume",
      };
    }

    // The callback owns halt/pause/status mutation. It runs only after lock
    // tri-state validation and transition reconciliation, while maintenance
    // still fences every control-loop claim boundary.
    applyLocalResume();

    if (state.loaded) {
      return { ok: true, note: "local pause/halt cleared for the verified running service" };
    }
    if (liveOwner) {
      return { ok: true, note: `local pause/halt cleared for verified foreground runner pid ${owner!.pid}` };
    }
    if (!state.installed) {
      return { ok: true, note: "local pause/halt cleared — start with `engager-agent run`" };
    }
    return deps.startService(maintenance.owner.token);
  });
}

export function stopAgentWithMaintenance(
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  return withLifecycleMaintenance("stop", deps, (config, maintenance) => {
    const runnerId = config?.runnerId ?? "global";
    const state = deps.service();
    const before = deps.owner(runnerId);
    if (before.state === "invalid") return unsafeLifecycleOwner(before.detail);

    const serviceResult = state.installed
      ? deps.stopService()
      : { ok: true, note: "native service is not installed" };
    const after = deps.owner(runnerId);
    if (after.state === "invalid") return unsafeLifecycleOwner(after.detail);
    let signalNote = "no verified live foreground owner";
    if (after.state === "valid" && deps.ownerLive(after.owner)) {
      if (!after.owner.processIdentity) {
        return unsafeLifecycleOwner("live execution owner lacks process identity");
      }
      try {
        deps.signal(after.owner.pid, "SIGTERM");
        signalNote = `sent SIGTERM to verified runner pid ${after.owner.pid}`;
      } catch (error) {
        return {
          ok: false,
          note: `UPGRADE_BLOCKED: verified runner could not be signaled: ${errorMessage(error)}`,
        };
      }
    }
    try {
      const barrier = acquireExecutionBarrier(
        deps,
        runnerId,
        maintenance.owner.token,
        5_000,
      );
      barrier.release();
    } catch (error) {
      return {
        ok: false,
        note: `UPGRADE_BLOCKED: stop could not prove execution quiescence: ${errorMessage(error)}`,
      };
    }
    return {
      ok: serviceResult.ok,
      note: `${serviceResult.note}; ${signalNote}; execution is quiescent`,
    };
  });
}

export function uninstallServiceWithMaintenance(
  deps: UpgradeDeps = REAL_UPGRADE_DEPS,
): UpgradeResult {
  return withLifecycleMaintenance("uninstall", deps, (config, maintenance) => {
    const runnerId = config?.runnerId ?? "global";
    const state = deps.service();
    const ownerInspection = deps.owner(runnerId);
    if (ownerInspection.state === "invalid") return unsafeLifecycleOwner(ownerInspection.detail);
    const owner = ownerInspection.state === "valid" ? ownerInspection.owner : null;
    if (
      state.loaded &&
      (!owner || state.pid !== owner.pid || !deps.ownerLive(owner))
    ) {
      return {
        ok: false,
        note: "UPGRADE_BLOCKED: loaded service ownership could not be verified before uninstall",
      };
    }
    const result = deps.uninstallService();
    if (!state.loaded) return result;
    try {
      const barrier = acquireExecutionBarrier(
        deps,
        runnerId,
        maintenance.owner.token,
        5_000,
      );
      barrier.release();
      return result;
    } catch (error) {
      return {
        ok: false,
        note: `${result.note}; uninstall could not prove the old service exited: ${errorMessage(error)}`,
      };
    }
  });
}

function withLifecycleMaintenance(
  action: string,
  deps: UpgradeDeps,
  mutate: (config: ReturnType<typeof loadConfig>, maintenance: RunnerLock) => UpgradeResult,
): UpgradeResult {
  const config = deps.load();
  const runnerId = config?.runnerId ?? "global";
  let maintenance: RunnerLock;
  try {
    maintenance = deps.maintenance(runnerId);
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: ${action} could not acquire lifecycle maintenance: ${errorMessage(error)}`,
    };
  }
  try {
    const owner = deps.owner(runnerId);
    if (owner.state === "invalid") return unsafeLifecycleOwner(owner.detail);
    const recovery = reconcileUnderMaintenance(deps, runnerId, maintenance);
    if (!recovery.ok) return recovery;
    return mutate(config, maintenance);
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: ${action} failed inside lifecycle maintenance: ${errorMessage(error)}`,
    };
  } finally {
    maintenance.release();
  }
}

function unsafeLifecycleOwner(detail: string): UpgradeResult {
  return {
    ok: false,
    note: `UPGRADE_BLOCKED: execution lock ownership is unsafe: ${detail}; nothing was signaled or removed`,
  };
}

function reconcileUnderMaintenance(
  deps: UpgradeDeps,
  runnerId: string,
  maintenance: RunnerLock,
): UpgradeResult & { recovered?: boolean } {
  const result = deps.reconcileService({
    maintenanceToken: maintenance.owner.token,
    acquireBarrier: () =>
      acquireExecutionBarrier(
        deps,
        runnerId,
        maintenance.owner.token,
        5_000,
      ),
  });
  return result.ok
    ? { ok: true, note: result.note, ...(result.recovered ? { recovered: true } : {}) }
    : {
        ok: false,
        note: result.recovered
          ? `UPGRADE_RECOVERY_INCOMPLETE: ${result.note}`
          : `UPGRADE_RECOVERY_REQUIRED: ${result.note}`,
        ...(result.recovered ? { recovered: true } : {}),
      };
}

function acquireExecutionBarrier(
  deps: UpgradeDeps,
  runnerId: string,
  maintenanceToken: string,
  timeoutMs: number,
): RunnerLock {
  const deadline = deps.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return deps.execution(runnerId, maintenanceToken);
    } catch (error) {
      lastError = error;
      if (deps.now() >= deadline) break;
      deps.pause(Math.min(50, Math.max(1, deadline - deps.now())));
    }
  } while (deps.now() <= deadline);
  throw new Error(
    `execution lock did not become safely available during maintenance: ${errorMessage(lastError)}`,
  );
}

function unsafeJournalNote(inspection: JournalInspection): string | null {
  if (inspection.state === "active") {
    return (
      "UPGRADE_BLOCKED: active-work.json still carries live lease authority until " +
      `${new Date(inspection.terminalAt).toISOString()}; run \`engager-agent run --once\` to reconcile it before upgrading`
    );
  }
  if (inspection.state === "invalid") {
    return (
      "UPGRADE_BLOCKED: active-work.json is unsafe or unverifiable; run `engager-agent doctor` " +
      "and reconcile it with the existing credential before upgrading"
    );
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
