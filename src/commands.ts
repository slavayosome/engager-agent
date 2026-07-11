import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentHome, configFileMode, loadConfig } from "./config.js";
import { redact, sanitizeTerminalText } from "./errors.js";
import { log } from "./log.js";
import { isLockOwnerLive, readRunnerLockOwner } from "./lock.js";
import { clearHalt, clearPause, readHalt, readPause, writePause } from "./markers.js";
import {
  installService,
  serviceState,
  startService,
  stopService,
  uninstallService,
} from "./service.js";
import { readStatus, writeStatus } from "./status.js";

const fmtAge = (timestamp: number, now: number): string => {
  const minutes = Math.round((now - timestamp) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

export function statusCommand(json: boolean): void {
  const now = Date.now();
  const config = loadConfig();
  const status = readStatus();
  const halt = readHalt();
  const pause = readPause(now);
  const service = serviceState();
  const owner = config ? readRunnerLockOwner(config.runnerId) : null;
  const alive = status != null && owner?.pid === status.pid && isLockOwnerLive(owner);
  const verdict = halt
    ? `HALTED — ${halt.reason}`
    : !config
      ? configFileMode() != null && configFileMode() !== 0o600
        ? "configuration blocked — agent.json must be 0600"
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
      `${JSON.stringify({ now, verdict, alive, config: safeConfig, status, halt, pause, service }, null, 2)}\n`,
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
  lines.push(
    `  service ${!service.supported ? "unsupported on this platform" : !service.installed ? "not installed" : !service.entryExists ? "BROKEN (entry missing)" : service.loaded ? `loaded${service.pid ? ` (pid ${service.pid})` : ""}` : "installed, stopped"}`,
  );
  lines.push(
    config ? "  next: engager-agent doctor" : "  next: engager-agent setup",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function pauseCommand(duration?: string): void {
  let until: number | undefined;
  if (duration) {
    const milliseconds = parseDuration(duration);
    if (milliseconds == null) {
      log(`could not parse duration "${duration}" — use 30m, 2h, or 1d`);
      process.exitCode = 1;
      return;
    }
    until = Date.now() + milliseconds;
  }
  writePause(until);
  log(`paused${until ? ` until ${new Date(until).toLocaleString()}` : " until resumed"}`);
}

export function resumeCommand(): void {
  clearHalt();
  clearPause();
  const status = readStatus();
  if (status) {
    writeStatus({
      ...status,
      quotaState: {
        status: "available",
        reasonCode: "manual_resume",
        observedAt: Date.now(),
      },
    });
  }
  const service = serviceState();
  if (service.installed) {
    const result = startService();
    log(result.note);
    if (!result.ok) process.exitCode = 1;
  } else {
    log("local pause/halt cleared — start with `engager-agent run`");
  }
}

export type StopCommandDeps = {
  serviceState: typeof serviceState;
  stopService: typeof stopService;
  loadConfig: typeof loadConfig;
  readOwner: typeof readRunnerLockOwner;
  ownerLive: typeof isLockOwnerLive;
  kill: typeof process.kill;
  output: typeof log;
};

const REAL_STOP_DEPS: StopCommandDeps = {
  serviceState,
  stopService,
  loadConfig,
  readOwner: readRunnerLockOwner,
  ownerLive: isLockOwnerLive,
  kill: process.kill.bind(process),
  output: log,
};

export function stopCommand(deps: StopCommandDeps = REAL_STOP_DEPS): void {
  const service = deps.serviceState();
  let serviceFailed = false;
  if (service.installed) {
    const result = deps.stopService();
    deps.output(result.note);
    serviceFailed = !result.ok;
  }
  const config = deps.loadConfig();
  // The lock is home-global even when agent.json is temporarily unreadable.
  // Always inspect it after service shutdown so a foreground owner cannot be
  // left running merely because an installed plist also exists.
  const owner = deps.readOwner(config?.runnerId ?? "global");
  if (owner?.processIdentity && deps.ownerLive(owner)) {
    deps.kill(owner.pid, "SIGTERM");
    deps.output(`sent SIGTERM to verified runner lock owner pid ${owner.pid}`);
  } else if (owner && !owner.processIdentity) {
    deps.output("runner lock owner has no verifiable process identity; refusing to signal its pid");
    process.exitCode = 1;
  } else {
    deps.output("runner is not running (no verified live lock owner)");
  }
  if (serviceFailed) process.exitCode = 1;
}

export function startCommand(): boolean {
  const state = serviceState();
  if (!state.installed) return false;
  const result = startService();
  log(result.note);
  if (!result.ok) process.exitCode = 1;
  return true;
}

export function serviceCommand(action: string | undefined, version: string): void {
  const result =
    action === "install" || action === "repair"
      ? installService(version)
      : action === "uninstall"
        ? uninstallService()
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
  const redacted = redact(value, [loadConfig()?.apiKey])
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|token|secret)"?\s*[:=]\s*)"?[^\s",}]+"?/gi, "$1[REDACTED]");
  return redacted
    .split(/\r?\n/)
    .map((line) => sanitizeTerminalText(line))
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
