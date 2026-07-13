#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findUnknownFlag,
  logsCommand,
  pauseCommand,
  resumeCommand,
  serviceCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./commands.js";
import { loadConfig, loadPartialConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { asRunnerFault, formatRunnerFault } from "./errors.js";
import { controlPoll } from "./heartbeat.js";
import { acquireRunnerLock } from "./lock.js";
import { log } from "./log.js";
import {
  MAX_CONSECUTIVE_FAILURES,
  countsTowardHalt,
  cycleInfoFromOutcome,
  faultCountsTowardHalt,
  quotaStateForFault,
  runControlCycle,
  runLoop,
} from "./loop.js";
import { readHalt, readPause, writeHalt } from "./markers.js";
import { readStatus, writeStatus, type RunnerState, type RunnerStatus } from "./status.js";
import { AGENT_VERSION } from "./version.js";
import { providerSessionsToday } from "./session-usage.js";
import { runWizard } from "./wizard.js";

const USAGE = `engager-agent — least-privilege Engager runner

  engager-agent setup [--reauthorize] [--setup-proof-org UUID]
                                        guided engine detection + browser authorization
  engager-agent status [--json]         local runner, protocol, quota, receipt health
  engager-agent doctor [--json]         read-only engine/auth/server/service diagnostics
  engager-agent run                     foreground control loop
  engager-agent run --once              claim at most one server-authored work order
  engager-agent service install         install verified versioned launchd payload (macOS)
  engager-agent service repair          repair the durable service entry
  engager-agent service status          service and runner status
  engager-agent service uninstall       remove autostart; preserve config/runtime
  engager-agent logs [--tail N]         sanitized recent local logs
  engager-agent pause [--for 2h]        pause local claims
  engager-agent resume                  clear pause/halt and restart installed service
  engager-agent stop                    stop foreground/service runner
  engager-agent start                   start an installed service

Bare \`engager-agent\` prints status and never starts work.
`;

export function setupProofOrganizationIdFromArgs(
  argv: string[],
): string | undefined {
  const index = argv.indexOf("--setup-proof-org");
  if (index < 0) return undefined;
  const candidate = argv[index + 1];
  if (!candidate || candidate.startsWith("-")) {
    throw new Error("--setup-proof-org requires an Engager project UUID");
  }
  return candidate;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const has = (flag: string) => argv.includes(flag);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;

  if (has("--version") || has("-v")) {
    process.stdout.write(`${AGENT_VERSION}\n`);
    return;
  }
  if (has("--help") || has("-h") || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const unknown = findUnknownFlag(argv);
  if (unknown) {
    throw new Error(`unknown flag "${unknown}"\n\n${USAGE}`);
  }

  switch (command) {
    case null:
      if (has("--once")) return runOnce(); // 0.8.x compatibility; no local fallback.
      statusCommand(has("--json"));
      return;
    case "setup":
    case "config":
      const setupProofOrganizationId = setupProofOrganizationIdFromArgs(argv);
      await runWizard(loadConfig() ?? loadPartialConfig() ?? undefined, {
        reauthorize: has("--reauthorize"),
        setupProofOrganizationId,
      });
      return;
    case "status":
      statusCommand(has("--json"));
      return;
    case "doctor": {
      const report = await runDoctor(loadConfig());
      if (has("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        for (const check of report.checks) {
          process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}\n`);
          if (check.recovery) process.stdout.write(`     Fix: ${check.recovery}\n`);
        }
      }
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "run":
      if (has("--once")) return runOnce();
      return runForeground(has("--service"));
    case "service":
      serviceCommand(argv[1] === "install" && has("--repair") ? "repair" : argv[1], AGENT_VERSION);
      return;
    case "logs":
      logsCommand(Number(value("--tail") ?? 80));
      return;
    case "pause":
      if (has("--for") && !value("--for")) {
        throw new Error("--for requires a duration such as 30m, 2h, or 1d");
      }
      pauseCommand(value("--for"));
      return;
    case "resume":
      resumeCommand();
      return;
    case "stop":
      stopCommand();
      return;
    case "start":
      if (!startCommand()) {
        log("service is not installed — use `engager-agent run` or `engager-agent service install`");
        process.exitCode = 1;
      }
      return;
    case "register":
      throw new Error(
        "runner credentials are never registered into interactive Claude/Codex clients; use a separate interactive-agent key",
      );
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

export async function runForeground(service: boolean): Promise<void> {
  const config = loadConfig();
  if (!config) {
    if (service) {
      log("RUNNER_NOT_CONFIGURED: run `engager-agent setup` in a terminal");
      return;
    }
    throw new Error("RUNNER_NOT_CONFIGURED: run `engager-agent setup`");
  }
  const lock = acquireRunnerLock(config.runnerId);
  const release = () => lock.release();
  process.once("exit", release);
  try {
    await runLoop(config, { service, version: AGENT_VERSION });
  } finally {
    process.off("exit", release);
    lock.release();
  }
}

export type RunOnceDeps = {
  load: typeof loadConfig;
  halt: typeof readHalt;
  pause: typeof readPause;
  status: typeof readStatus;
  lock: typeof acquireRunnerLock;
  cycle: typeof runControlCycle;
  persist: (status: RunnerStatus) => void;
  terminal: typeof controlPoll;
  markHalt: typeof writeHalt;
  sessions: typeof providerSessionsToday;
  output: typeof log;
};

const REAL_RUN_ONCE_DEPS: RunOnceDeps = {
  load: loadConfig,
  halt: readHalt,
  pause: readPause,
  status: readStatus,
  lock: acquireRunnerLock,
  cycle: runControlCycle,
  persist: writeStatus,
  terminal: controlPoll,
  markHalt: writeHalt,
  sessions: providerSessionsToday,
  output: log,
};

export async function runOnce(deps: RunOnceDeps = REAL_RUN_ONCE_DEPS): Promise<void> {
  const config = deps.load();
  if (!config) throw new Error("RUNNER_NOT_CONFIGURED: run `engager-agent setup`");
  const halt = deps.halt();
  if (halt) throw new Error(`runner is halted (${halt.reason}); run \`engager-agent doctor\`, then \`engager-agent resume\``);
  const pause = deps.pause();
  const prior = deps.status();
  const day = new Date().toISOString().slice(0, 10);
  let sessionsToday = deps.sessions();
  let consecutiveFailures = prior?.consecutiveFailures ?? 0;
  let protocol: "v1" | "2.1" | undefined;
  let protocolVerifiedAt: number | undefined;
  let quotaState = prior?.quotaState;
  let fatal = false;
  let signalReceived: string | null = null;
  let cycle = prior?.lastCycle;
  const controller = new AbortController();
  const onSignal = (signal: string): void => {
    signalReceived = signal;
    controller.abort();
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const lock = deps.lock(config.runnerId);
  try {
    try {
      const result = await deps.cycle(
        config,
        AGENT_VERSION,
        {
          state: pause ? "paused-local" : "preflight",
          ...(cycle ? { lastCycle: cycle } : {}),
          consecutiveFailures,
          sessionsToday,
          ...(quotaState ? { quotaState } : {}),
        },
        { allowWork: !pause, signal: controller.signal },
      );
      protocol = result.protocol;
      protocolVerifiedAt = Date.now();
      quotaState = result.quotaState;
      const outcome = result.outcome;
      cycle = cycleInfoFromOutcome(outcome);
      fatal = outcome.fatal === true;
      if (outcome.ok) consecutiveFailures = 0;
      else if (countsTowardHalt(outcome.errorCode)) consecutiveFailures += 1;
    } catch (error) {
      const fault = asRunnerFault(error);
      cycle = {
        at: Date.now(),
        ran: false,
        ok: false,
        note: fault.message.slice(0, 400),
        errorCode: fault.code,
      };
      if (faultCountsTowardHalt(fault)) consecutiveFailures += 1;
      quotaState = quotaStateForFault(fault);
      deps.output(formatRunnerFault(fault));
    }
    sessionsToday = deps.sessions();
    const halted = fatal || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    if (halted) {
      deps.markHalt(
        fatal ? cycle?.note ?? "server stop" : `${MAX_CONSECUTIVE_FAILURES} consecutive contract/execution failures`,
        consecutiveFailures,
      );
    }
    const state: RunnerState = halted
      ? "halted"
      : signalReceived
        ? "stopped"
        : pause
          ? "paused-local"
          : cycle?.errorCode === "CONTRACT_UPGRADE_REQUIRED"
            ? "upgrade-required"
            : cycle?.errorCode === "ENGINE_QUOTA" || cycle?.errorCode === "ENGINE_OVERLOADED"
              ? "quota-blocked"
              : "stopped";
    deps.persist({
      schemaVersion: 2,
      pid: process.pid,
      version: AGENT_VERSION,
      runnerId: config.runnerId,
      engine: config.engine,
      ...(config.model ? { model: config.model } : {}),
      ...(protocol ? { protocol } : {}),
      ...(protocolVerifiedAt != null ? { protocolVerifiedAt } : {}),
      state,
      startedAt: prior?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(cycle ? { lastCycle: cycle } : {}),
      consecutiveFailures,
      sessionsToday,
      sessionDay: day,
      ...(quotaState ? { quotaState } : {}),
    });
    await deps.terminal(config, AGENT_VERSION, {
      state,
      ...(cycle ? { lastCycle: cycle } : {}),
      consecutiveFailures,
      sessionsToday,
      ...(quotaState ? { quotaState } : {}),
    }).catch(() => undefined);
    if (cycle) deps.output(`${cycle.ok ? "OK" : "FAILED"} — ${cycle.note}`);
    if (!cycle?.ok || halted || signalReceived) process.exitCode = signalReceived ? 130 : 1;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    lock.release();
  }
}

if (isDirectInvocation()) {
  main().catch((error: unknown) => {
    log(formatRunnerFault(error));
    process.exitCode = 1;
  });
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
