import type { AgentConfig } from "./config.js";
import { configFileMode, configPathPresent } from "./config.js";
import { readDisconnectTransition, readSanitizedDisconnectReceipt, safeDisconnectProgress, type DisconnectTransition } from "./disconnect-transition.js";
import { engineFor } from "./engines/index.js";
import { isEngineReady } from "./engine.js";
import { asRunnerFault } from "./errors.js";
import { inspectJournal, journalBinding } from "./journal.js";
import {
  diagnoseLock,
  inspectMaintenanceLock,
  inspectRunnerLock,
  type LockDiagnostic,
} from "./lock.js";
import { EngagerMcp } from "./mcp.js";
import { providerSessionsToday } from "./session-usage.js";
import { serviceState } from "./service.js";
import { readUpgradeTransition } from "./upgrade-transition.js";

export type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  recovery?: string;
};

export type DoctorReport = {
  ok: boolean;
  checkedAt: number;
  checks: DoctorCheck[];
};

/** Read-only diagnostics: no heartbeat, claim, provider model call, or service mutation. */
export async function runDoctor(
  config: AgentConfig | null,
  now: number = Date.now(),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let activeDisconnectPhase: DisconnectTransition["phase"] | null = null;
  try {
    activeDisconnectPhase = readDisconnectTransition()?.phase ?? null;
  } catch {
    /* dedicated check below reports unsafe transition state */
  }
  addRecoveryCheck(checks, config, now);
  addLockChecks(checks, config);
  checks.push(diagnoseUpgradeTransition());
  checks.push(diagnoseDisconnectTransition());
  checks.push(diagnoseDisconnectReceipt());
  try {
    const sessions = providerSessionsToday(now);
    checks.push({
      name: "provider-session-ledger",
      status: "pass",
      detail: `${sessions} provider session${sessions === 1 ? "" : "s"} reserved for the current UTC day`,
    });
  } catch {
    checks.push({
      name: "provider-session-ledger",
      status: "fail",
      detail: "session-usage.json is corrupt, unsafe, or not a private regular file",
      recovery: "Repair ownership and chmod 600 ~/.engager/session-usage.json, or move it aside only after preserving the conservative session count.",
    });
  }
  if (!config) {
    const mode = configFileMode();
    const configPresent = configPathPresent();
    let completedDisconnect: ReturnType<typeof readSanitizedDisconnectReceipt> = null;
    try {
      completedDisconnect = readSanitizedDisconnectReceipt();
    } catch {
      /* the dedicated receipt check reports unsafe retained evidence */
    }
    const bearerlessRecovery = activeDisconnectPhase === "pending" || activeDisconnectPhase === "approved" || activeDisconnectPhase === "acknowledged";
    const preStartRecovery = activeDisconnectPhase === "prepared" || activeDisconnectPhase === "quiesced";
    checks.push({
      name: "configuration",
      status: configPresent && mode !== 0o600
        ? "fail"
        : completedDisconnect && !activeDisconnectPhase && !configPresent
          ? "pass"
          : bearerlessRecovery
            ? "warn"
            : "fail",
      detail:
        configPresent && mode !== 0o600
          ? `agent.json is unsafe${mode == null ? " or not a regular file" : ` (${mode.toString(8)})`}; the runner refused to read or transmit its credential`
          : bearerlessRecovery
            ? `agent.json is unavailable; phase ${activeDisconnectPhase} recovery is bearerless and remains available from the private challenge journal`
          : completedDisconnect && !activeDisconnectPhase && !configPresent
            ? `agent.json is absent because runner disconnect receipt ${completedDisconnect.receiptId} completed local teardown`
          : preStartRecovery
            ? `agent.json is unavailable but phase ${activeDisconnectPhase} still requires the exact original credential binding`
          : "runner is not configured or the saved configuration is invalid",
      recovery:
        configPresent && mode !== 0o600
          ? "Repair agent.json into an owned private 0600 regular file, then rerun doctor."
          : bearerlessRecovery
            ? "Rerun `engager-agent disconnect`; do not create replacement credentials or replace the recovery journal."
          : completedDisconnect && !activeDisconnectPhase && !configPresent
            ? "No action is required; run `engager-agent setup` only to connect this machine again."
          : preStartRecovery
            ? "Restore the exact original private agent.json, then rerun `engager-agent disconnect`."
          : "Run `engager-agent setup`.",
    });
    checks.push(diagnoseService());
    return report(checks);
  }
  checks.push({
    name: "configuration",
    status: configMode() === 0o600 ? "pass" : "fail",
    detail: configMode() === 0o600 ? "agent.json is private (0600)" : "agent.json permissions are not 0600",
    ...(configMode() === 0o600 ? {} : { recovery: "Run `chmod 600 ~/.engager/agent.json`." }),
  });

  if (activeDisconnectPhase) {
    checks.push(
      {
        name: `engine:${config.engine}`,
        status: "warn",
        detail: `provider detection skipped while disconnect recovery is at phase ${activeDisconnectPhase}`,
        recovery: "Rerun `engager-agent disconnect` before provider diagnostics.",
      },
      {
        name: "server",
        status: "warn",
        detail: `credential probe skipped while disconnect recovery is at phase ${activeDisconnectPhase}`,
        recovery: "Rerun `engager-agent disconnect`; its bearerless recovery path remains authoritative.",
      },
      diagnoseService(),
    );
    return report(checks);
  }

  const engine = await engineFor(
    config.engine,
    config.enginePath,
    config.engineConfigDir,
  ).detect();
  checks.push({
    name: `engine:${config.engine}`,
    status: isEngineReady(engine) ? "pass" : "fail",
    detail: !engine.installed
      ? "not installed"
      : `${engine.version ?? "installed"}; ${
          engine.authenticated === true
            ? "authenticated"
            : engine.authenticated === false
              ? "not authenticated"
              : "authentication could not be verified"
        }${engine.detail ? `; ${engine.detail}` : ""}`,
    ...(!engine.installed
      ? { recovery: `Install ${config.engine}, then rerun setup.` }
      : !engine.supported
        ? { recovery: `Install a runner-certified ${config.engine} version, then rerun doctor.` }
        : engine.authenticated !== true
          ? { recovery: `Authenticate ${config.engine}, then rerun doctor.` }
          : {}),
  });

  const mcp = new EngagerMcp(config.mcpUrl, config.apiKey, "doctor");
  try {
    const surface = await mcp.connect();
    checks.push({
      name: "server",
      status: "pass",
      detail:
        surface === "v2"
          ? "authenticated; leased protocol 2.1 surface is active"
          : surface === "v2-setup-proof"
            ? "authenticated; purpose-bound setup-proof surface is active"
          : "authenticated; legacy/bootstrap surface will negotiate on run",
    });
  } catch (error) {
    const fault = asRunnerFault(error);
    checks.push({
      name: "server",
      status: "fail",
      detail: `${fault.code}: ${fault.message}`,
      recovery: fault.recovery,
    });
  } finally {
    await mcp.close();
  }

  checks.push(diagnoseService());

  return report(checks);
}

function diagnoseService(): DoctorCheck {
  const service = serviceState();
  return {
    name: "service",
    status: !service.supported || (service.installed && !service.entryExists) ? "warn" : "pass",
    detail: !service.supported
      ? "native background service is not supported on this platform; foreground run is available"
      : !service.installed
        ? "not installed (optional)"
        : service.entryExists
          ? `installed${service.loaded ? ", loaded" : ", stopped"}`
          : "installed service entry is missing",
    ...(service.installed && !service.entryExists
      ? { recovery: "Run `engager-agent service install --repair`." }
      : {}),
  };
}

export function diagnoseUpgradeTransition(): DoctorCheck {
  try {
    const transition = readUpgradeTransition();
    if (!transition) {
      return {
        name: "upgrade-transition",
        status: "pass",
        detail: "no interrupted runtime or launchd transition",
      };
    }
    return {
      name: "upgrade-transition",
      status: "fail",
      detail: `interrupted runner ${transition.target.version} transition remains at phase ${transition.phase}`,
      recovery: "Run `engager-agent upgrade`, `engager-agent service repair`, or `engager-agent start`; status and doctor are read-only.",
    };
  } catch {
    return {
      name: "upgrade-transition",
      status: "fail",
      detail: "upgrade-transition.json is corrupt, unsafe, or not a private regular file",
      recovery: "Preserve the journal and run `engager-agent service repair` or `engager-agent upgrade` after repairing ~/.engager ownership/permissions.",
    };
  }
}

export function diagnoseDisconnectTransition(): DoctorCheck {
  try {
    const transition = readDisconnectTransition();
    if (!transition) {
      return {
        name: "disconnect-transition",
        status: "pass",
        detail: "no interrupted runner disconnect",
      };
    }
    const safe = safeDisconnectProgress(transition);
    const approval = safe.verificationUri && safe.userCode
      ? `; owner approval ${safe.verificationUri} code ${safe.userCode}`
      : "";
    return {
      name: "disconnect-transition",
      status: "fail",
      detail: `runner disconnect remains at phase ${safe.phase}${approval}`,
      recovery: "Rerun `engager-agent disconnect`; execution and lifecycle mutations remain fail-closed until recovery completes.",
    };
  } catch {
    return {
      name: "disconnect-transition",
      status: "fail",
      detail: "disconnect-transition.json is corrupt, unsafe, or not a private regular file",
      recovery: "Preserve the journal, repair ~/.engager ownership/permissions, and rerun `engager-agent disconnect`.",
    };
  }
}

export function diagnoseDisconnectReceipt(): DoctorCheck {
  try {
    const receipt = readSanitizedDisconnectReceipt();
    return receipt
      ? {
          name: "disconnect-receipt",
          status: "pass",
          detail: `acknowledged receipt ${receipt.receiptId} is retained without bearer or device authority`,
        }
      : {
          name: "disconnect-receipt",
          status: "pass",
          detail: "no completed disconnect receipt",
        };
  } catch {
    return {
      name: "disconnect-receipt",
      status: "fail",
      detail: "disconnect-receipt.json is corrupt, unsafe, or not a private regular file",
      recovery: "Preserve the receipt and repair ~/.engager ownership/permissions before trusting local teardown evidence.",
    };
  }
}

function addLockChecks(checks: DoctorCheck[], config: AgentConfig | null): void {
  checks.push(
    lockCheck(
      "execution-lock",
      diagnoseLock(inspectRunnerLock(config?.runnerId ?? "global")),
      "Run `engager-agent stop` if the verified process should exit; otherwise leave it running.",
    ),
    lockCheck(
      "maintenance-lock",
      diagnoseLock(inspectMaintenanceLock()),
      "Wait for the active lifecycle command; if it exited, rerun `engager-agent upgrade`, `engager-agent service repair`, or `engager-agent start`.",
    ),
  );
}

function lockCheck(
  name: string,
  diagnostic: LockDiagnostic,
  activeRecovery: string,
): DoctorCheck {
  if (diagnostic.state === "absent") {
    return { name, status: "pass", detail: diagnostic.detail };
  }
  const pid = diagnostic.pid ? ` (pid ${diagnostic.pid})` : "";
  if (diagnostic.state === "active") {
    return {
      name,
      status: "warn",
      detail: `${diagnostic.detail}${pid}`,
      recovery: activeRecovery,
    };
  }
  if (diagnostic.state === "stale") {
    return {
      name,
      status: "warn",
      detail: `${diagnostic.detail}${pid}`,
      recovery: "Retry the intended command; it will recover only this structurally valid dead owner under an exclusive recovery guard.",
    };
  }
  return {
    name,
    status: "fail",
    detail: `${diagnostic.detail}${pid}`,
    recovery: "Preserve ~/.engager/locks; repair ownership or metadata only after proving no process owns the lock, then rerun doctor.",
  };
}

function addRecoveryCheck(
  checks: DoctorCheck[],
  config: AgentConfig | null,
  now: number,
): void {
  checks.push(diagnoseRecoveryJournal(config, now));
}

export function diagnoseRecoveryJournal(
  config: AgentConfig | null,
  now: number = Date.now(),
): DoctorCheck {
  const inspection = inspectJournal(now);
  if (inspection.state === "absent") {
    return {
      name: "recovery-journal",
      status: "pass",
      detail: "no unfinished local lease journal",
    };
  }
  if (inspection.state === "invalid") {
    return {
      name: "recovery-journal",
      status: "fail",
      detail: inspection.detail,
      recovery: "Preserve active-work.json; repair clock/permissions and reconcile it with the original credential. Do not rotate credentials while lease authority is unknown.",
    };
  }
  const terminal = new Date(inspection.terminalAt).toISOString();
  if (inspection.state === "expired") {
    return {
      name: "recovery-journal",
      status: "warn",
      detail: `the work order is past its hard expiry and clock-skew margin (${terminal})`,
      recovery: "Run `engager-agent setup --reauthorize`; setup will quarantine the private expired journal before changing credentials.",
    };
  }
  const binding = config ? journalBinding(config) : null;
  const bindingMatches =
    config != null &&
    inspection.journal.runnerId === config.runnerId &&
    inspection.journal.mcpUrl === binding?.mcpUrl &&
    inspection.journal.credentialFingerprint === binding?.credentialFingerprint;
  return {
    name: "recovery-journal",
    status: bindingMatches ? "warn" : "fail",
    detail: bindingMatches
      ? `live leased work is recoverable with the current credential; hard terminal boundary ${terminal}`
      : `live leased work cannot be reconciled with the current or missing configuration; hard terminal boundary ${terminal}`,
    recovery: bindingMatches
      ? "Run `engager-agent run --once` before setup or credential rotation."
      : `Restore the original endpoint/key, or wait until ${terminal} before running setup --reauthorize.`,
  };
}

function configMode(): number | null {
  return configFileMode();
}

function report(checks: DoctorCheck[]): DoctorReport {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checkedAt: Date.now(),
    checks,
  };
}
