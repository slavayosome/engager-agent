import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentHome, configFileMode, configPathPresent, loadConfig } from "./config.js";
import { hasDisconnectTransition, readDisconnectTransition, readSanitizedDisconnectReceipt, safeDisconnectProgress } from "./disconnect-transition.js";
import { sanitizeSensitiveText } from "./errors.js";
import { log, logEvent, redactionSecrets } from "./log.js";
import {
  diagnoseLock,
  inspectMaintenanceLock,
  inspectRunnerLock,
} from "./lock.js";
import { clearHalt, clearPause, readHalt, readPause, writePause } from "./markers.js";
import { serviceState } from "./service.js";
import { AGENT_VERSION } from "./version.js";
import { readStatus, writeStatus } from "./status.js";
import {
  ensureServiceInstalledWithMaintenance,
  pauseAgentWithMaintenance,
  resumeAgentWithMaintenance,
  startServiceWithMaintenance,
  stopAgentWithMaintenance,
  uninstallServiceWithMaintenance,
  upgradeAgent,
} from "./upgrade.js";
import { hasUpgradeTransition } from "./upgrade-transition.js";

const fmtAge = (timestamp: number, now: number): string => {
  const minutes = Math.round((now - timestamp) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

export function statusCommand(json: boolean): void {
  const transitionPending = hasUpgradeTransition();
  let disconnectTransition: ReturnType<typeof safeDisconnectProgress> | null = null;
  let disconnectUnsafe = false;
  let disconnectReceipt: ReturnType<typeof readSanitizedDisconnectReceipt> = null;
  let disconnectReceiptUnsafe = false;
  try {
    const transition = readDisconnectTransition();
    disconnectTransition = transition ? safeDisconnectProgress(transition) : null;
  } catch {
    disconnectUnsafe = true;
  }
  try {
    disconnectReceipt = readSanitizedDisconnectReceipt();
  } catch {
    disconnectReceiptUnsafe = true;
  }
  const now = Date.now();
  const config = loadConfig();
  const mode = configFileMode();
  const configPresent = configPathPresent();
  const disconnectReceiptSafetyBlock = disconnectReceiptUnsafe && !config && !configPresent && !disconnectTransition;
  if (transitionPending || disconnectTransition || disconnectUnsafe || disconnectReceiptSafetyBlock) process.exitCode = 1;
  const status = readStatus();
  const halt = readHalt();
  const pause = readPause(now);
  const service = serviceState();
  const executionLock = diagnoseLock(inspectRunnerLock(config?.runnerId ?? "global"));
  const maintenanceLock = diagnoseLock(inspectMaintenanceLock());
  const unsafeLock = executionLock.state === "invalid" || maintenanceLock.state === "invalid";
  if (unsafeLock) process.exitCode = 1;
  const alive =
    status != null &&
    executionLock.state === "active" &&
    executionLock.pid === status.pid;
  const verdict = unsafeLock
    ? "LOCK SAFETY BLOCK — run `engager-agent doctor` before any lifecycle action"
    : disconnectUnsafe
    ? "DISCONNECT SAFETY BLOCK — preserve disconnect-transition.json and run `engager-agent doctor`"
    : disconnectReceiptSafetyBlock
    ? "DISCONNECT RECEIPT SAFETY BLOCK — preserve disconnect-receipt.json and run `engager-agent doctor`"
    : disconnectTransition
    ? `DISCONNECT PENDING (${disconnectTransition.phase}) — rerun \`engager-agent disconnect\``
    : transitionPending
    ? "UPGRADE RECOVERY REQUIRED — run `engager-agent upgrade`, `engager-agent start`, or `engager-agent service repair`"
    : halt
    ? `HALTED — ${halt.reason}`
    : !config
      ? configPresent
        ? mode !== 0o600
          ? "configuration blocked — agent.json must be 0600"
          : "configuration is invalid — preserve agent.json and run doctor"
        : disconnectReceipt
          ? `disconnected — receipt ${disconnectReceipt.receiptId}`
          : "not configured"
      : alive
        ? pause
          ? "paused locally"
          : `running — ${status!.state}`
        : service.loaded
          ? "service loaded; waiting for runner heartbeat"
          : "not running";
  const safeConfig = config
    ? {
        mcpUrl: config.mcpUrl,
        runnerId: config.runnerId,
        engine: config.engine,
        model: config.model ?? null,
        dailySessionCap: config.dailySessionCap,
        legacyCompatibility: config.legacy != null,
      }
    : null;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ now, verdict, alive, config: safeConfig, status, halt, pause, service, transitionPending, disconnectTransition, disconnectUnsafe, disconnectReceipt, disconnectReceiptUnsafe, disconnectReceiptSafetyBlock, locks: { execution: executionLock, maintenance: maintenanceLock } }, null, 2)}\n`,
    );
    return;
  }
  const lines = [`engager-agent: ${verdict}`];
  if (config) {
    lines.push(
      `  engine ${config.engine}${config.model ? ` (${config.model})` : " (provider default)"} · runner ${config.runnerId}`,
    );
  }
  if (status) {
    lines.push(
      `  protocol ${status.protocol ?? "not negotiated"} · sessions today ${status.sessionsToday}/${config?.dailySessionCap ?? "?"}`,
    );
    if (status.lastCycle) {
      const blocked =
        status.lastCycle.errorCode === "ENGINE_QUOTA" ||
        status.lastCycle.errorCode === "ENGINE_OVERLOADED" ||
        status.lastCycle.errorCode === "CONTRACT_UPGRADE_REQUIRED";
      lines.push(
        `  last cycle ${status.lastCycle.ok ? "ok" : blocked ? "BLOCKED" : "FAILED"} ${fmtAge(status.lastCycle.at, now)} — ${status.lastCycle.note}`,
      );
      if (status.lastCycle.receipt) {
        const receipt = status.lastCycle.receipt;
        lines.push(
          `  last receipt ${receipt.status} · accepted ${receipt.accepted} · existing ${receipt.alreadyExists} · rejected ${receipt.rejected} · failed ${receipt.failed} · unfinished ${receipt.unfinished}`,
        );
      }
    }
    if (status.nextPollAt && alive) lines.push(`  next control poll ${new Date(status.nextPollAt).toLocaleTimeString()}`);
  }
  if (disconnectTransition?.verificationUri && disconnectTransition.userCode) {
    lines.push(`  disconnect approval ${disconnectTransition.verificationUri} · code ${disconnectTransition.userCode}`);
  }
  if (!config && !configPresent && !disconnectTransition && disconnectReceipt) {
    lines.push(`  disconnect receipt ${disconnectReceipt.receiptId} · acknowledged ${new Date(disconnectReceipt.completedAt).toISOString()}`);
  }
  lines.push(
    `  service ${!service.supported ? "unsupported on this platform" : !service.installed ? "not installed" : !service.entryExists ? "BROKEN (entry missing)" : service.loaded ? `loaded${service.pid ? ` (pid ${service.pid})` : ""}` : "installed, stopped"}`,
    ...(service.payloadVersion && service.payloadVersion !== AGENT_VERSION
      ? [
          `  WARNING: service payload ${service.payloadVersion} != CLI ${AGENT_VERSION} — the service keeps running the old version until you run \`engager-agent upgrade\``,
        ]
      : []),
  );
  lines.push(
    `  locks execution ${executionLock.state}${executionLock.pid ? ` (pid ${executionLock.pid})` : ""} · maintenance ${maintenanceLock.state}${maintenanceLock.pid ? ` (pid ${maintenanceLock.pid})` : ""}`,
  );
  lines.push(
    config
      ? "  next: engager-agent doctor"
      : !configPresent && disconnectReceipt
        ? "  next: no action required; run setup only to reconnect"
        : "  next: engager-agent setup",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

export type PauseCommandDeps = {
  pause: typeof pauseAgentWithMaintenance;
  write: typeof writePause;
  now: () => number;
  output: typeof log;
};

const REAL_PAUSE_DEPS: PauseCommandDeps = {
  pause: pauseAgentWithMaintenance,
  write: writePause,
  now: Date.now,
  output: log,
};

export function pauseCommand(
  duration?: string,
  deps: PauseCommandDeps = REAL_PAUSE_DEPS,
): void {
  let until: number | undefined;
  if (duration) {
    const milliseconds = parseDuration(duration);
    if (milliseconds == null) {
      deps.output(`could not parse duration "${sanitizeSensitiveText(duration)}" — use 30m, 2h, or 1d`);
      process.exitCode = 1;
      return;
    }
    until = deps.now() + milliseconds;
  }
  const result = deps.pause(() => deps.write(until));
  deps.output(result.ok
    ? `paused${until ? ` until ${new Date(until).toLocaleString()}` : " until resumed"}`
    : result.note);
  logEvent({ event: "lifecycle.result", level: result.ok ? "info" : "error", phase: "pause", detail: result.note });
  if (!result.ok) process.exitCode = 1;
}

export type ResumeCommandDeps = {
  resume: typeof resumeAgentWithMaintenance;
  clearHalt: typeof clearHalt;
  clearPause: typeof clearPause;
  readStatus: typeof readStatus;
  writeStatus: typeof writeStatus;
  now: () => number;
  output: typeof log;
};

const REAL_RESUME_DEPS: ResumeCommandDeps = {
  resume: resumeAgentWithMaintenance,
  clearHalt,
  clearPause,
  readStatus,
  writeStatus,
  now: Date.now,
  output: log,
};

export function resumeCommand(deps: ResumeCommandDeps = REAL_RESUME_DEPS): void {
  const result = deps.resume(() => {
    deps.clearHalt();
    deps.clearPause();
    const status = deps.readStatus();
    if (status) {
      deps.writeStatus({
        ...status,
        quotaState: {
          status: "available",
          reasonCode: "manual_resume",
          observedAt: deps.now(),
        },
      });
    }
  });
  deps.output(result.note);
  logEvent({ event: "lifecycle.result", level: result.ok ? "info" : "error", phase: "resume", detail: result.note });
  if (!result.ok) process.exitCode = 1;
}

export type StopCommandDeps = {
  stop: typeof stopAgentWithMaintenance;
  output: typeof log;
};

const REAL_STOP_DEPS: StopCommandDeps = {
  stop: stopAgentWithMaintenance,
  output: log,
};

export function stopCommand(deps: StopCommandDeps = REAL_STOP_DEPS): void {
  const result = deps.stop();
  deps.output(result.note);
  logEvent({ event: "lifecycle.result", level: result.ok ? "info" : "error", phase: "stop", detail: result.note });
  if (!result.ok) process.exitCode = 1;
}

export function startCommand(): boolean {
  const state = serviceState();
  if (!shouldEnterServiceLifecycle(state.installed, hasUpgradeTransition() || hasDisconnectTransition())) return false;
  const result = startServiceWithMaintenance();
  log(result.note);
  logEvent({ event: "lifecycle.result", level: result.ok ? "info" : "error", phase: "start", detail: result.note });
  if (!result.ok) process.exitCode = 1;
  return true;
}

export function shouldEnterServiceLifecycle(
  serviceInstalled: boolean,
  transitionPending: boolean,
): boolean {
  return serviceInstalled || transitionPending;
}

export function serviceCommand(action: string | undefined, version: string): void {
  const result =
    action === "repair"
      ? upgradeAgent(version)
      : action === "install"
        ? ensureServiceInstalledWithMaintenance(version)
      : action === "uninstall"
        ? uninstallServiceWithMaintenance()
        : null;
  if (action === "status") {
    statusCommand(false);
    return;
  }
  if (!result) {
    log("usage: engager-agent service <install|repair|status|uninstall>");
    process.exitCode = 1;
    return;
  }
  log(result.note);
  logEvent({ event: "lifecycle.result", level: result.ok ? "info" : "error", phase: `service:${action}`, detail: result.note });
  if (!result.ok) process.exitCode = 1;
}

export function logsCommand(lines = 80): void {
  const directory = join(agentHome(), "logs");
  if (!existsSync(directory)) {
    process.stdout.write("No runner logs yet.\n");
    return;
  }
  const files = readdirSync(directory).filter((file) => file.endsWith(".log")).sort();
  const latest = files.at(-1);
  if (!latest) {
    process.stdout.write("No runner logs yet.\n");
    return;
  }
  const count = Number.isFinite(lines) ? Math.min(1_000, Math.max(1, Math.floor(lines))) : 80;
  const safe = sanitizeLogText(readFileSync(join(directory, latest), "utf8"));
  const tail = safe.split("\n").slice(-count);
  process.stdout.write(`${tail.join("\n")}\n`);
}

export function sanitizeLogText(value: string): string {
  const secrets = redactionSecrets();
  return value
    .split(/\r?\n/)
    .map((line) => sanitizeSensitiveText(line, secrets))
    .join("\n");
}

function parseDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const milliseconds = unit.startsWith("m")
    ? amount * 60_000
    : unit.startsWith("h")
      ? amount * 3_600_000
      : amount * 86_400_000;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

const BOOLEAN_FLAGS = new Set([
  "--version",
  "-v",
  "--help",
  "-h",
  "--once",
  "--service",
  "--json",
  "--repair",
  "--reauthorize",
]);
const VALUE_FLAGS = new Set(["--for", "--tail", "--setup-proof-org"]);

export function findUnknownFlag(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value?.startsWith("-")) continue;
    if (BOOLEAN_FLAGS.has(value)) continue;
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    return value;
  }
  return undefined;
}
