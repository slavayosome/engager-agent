import { loadConfig } from "./config.js";
import { log } from "./log.js";
import {
  clearHalt,
  clearPause,
  parseDuration,
  readHalt,
  readPause,
  writePause,
} from "./markers.js";
import {
  installService,
  serviceState,
  startService,
  stopService,
  uninstallService,
} from "./service.js";
import { fmtTokens } from "./session.js";
import { pidAlive, readStatus } from "./status.js";

/**
 * The control-surface subcommands: status / pause / resume / stop / start /
 * service. All state they act on is on disk (markers, status.json, launchd),
 * so they work whether the loop runs foreground or as a service. The running
 * loop notices marker changes at its next control poll (≤5 min).
 */

const fmtAge = (ts: number, now: number): string => {
  const min = Math.round((now - ts) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

export function statusCommand(json: boolean): void {
  const now = Date.now();
  const cfg = loadConfig();
  const st = readStatus();
  const halt = readHalt();
  const pause = readPause(now);
  const svc = serviceState();
  const alive = st != null && pidAlive(st.pid);
  // A live loop refreshes status at least every control poll; a status file
  // whose nextWakeAt is long gone while the pid is dead means "not running".
  const stuck = alive && st?.nextWakeAt != null && now - st.nextWakeAt > 15 * 60_000;

  const verdict = halt
    ? `HALTED — ${halt.reason} (resume with: engager-agent resume)`
    : !cfg
      ? "not configured — run: engager-agent"
      : !alive
        ? svc.installed
          ? svc.loaded
            ? "service loaded but no live runner status yet"
            : "stopped (service installed but not running — engager-agent start)"
          : "not running (start with: engager-agent, or install the service)"
        : pause
          ? `paused locally${pause.until ? ` until ${new Date(pause.until).toLocaleString()}` : ""}`
          : stuck
            ? `possibly stuck — pid ${st!.pid} alive but overslept its wake time`
            : `running — ${st!.state}${st!.stateReason ? ` (${st!.stateReason})` : ""}`;

  if (json) {
    const safeCfg = cfg
      ? {
          mcpUrl: cfg.mcpUrl,
          campaignId: cfg.campaignId,
          model: cfg.model,
          intervalMinutes: cfg.intervalMinutes,
          dailySessionCap: cfg.dailySessionCap,
          runnerId: cfg.runnerId,
        }
      : null;
    process.stdout.write(
      JSON.stringify(
        { now, verdict, alive, config: safeCfg, status: st, halt, pause, service: svc },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const lines: string[] = [`engager-agent: ${verdict}`];
  if (cfg) {
    lines.push(
      `  campaign ${cfg.campaignId} · model ${cfg.model} · drafting every ~${cfg.intervalMinutes} min`,
    );
  }
  if (st) {
    if (st.lastCycle) {
      lines.push(
        `  last cycle: ${st.lastCycle.ok ? "ok" : "FAILED"} ${fmtAge(st.lastCycle.at, now)} — ${st.lastCycle.note}`,
      );
    }
    lines.push(
      `  sessions today: ${st.sessionsToday} · consecutive failures: ${st.consecutiveFailures}` +
        (st.lastSessionTokens
          ? ` · last session ${fmtTokens(st.lastSessionTokens)} tokens`
          : ""),
    );
    if (alive && st.nextWakeAt) {
      lines.push(`  next wake: ${new Date(st.nextWakeAt).toLocaleTimeString()}`);
    }
  }
  lines.push(
    `  autostart: ${!svc.supported ? "unsupported (not macOS)" : svc.installed ? (svc.loaded ? `installed, loaded${svc.pid ? ` (pid ${svc.pid})` : ""}` : "installed, not running") : "not installed (engager-agent service install)"}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

export function pauseCommand(forText?: string): void {
  let until: number | undefined;
  if (forText) {
    const ms = parseDuration(forText);
    if (ms == null) {
      log(`could not parse duration "${forText}" — use e.g. 30m, 2h, 1d`);
      process.exit(1);
    }
    until = Date.now() + ms;
  }
  writePause(until);
  log(
    `paused${until ? ` until ${new Date(until).toLocaleString()}` : " until resumed"} — ` +
      `a running loop picks this up at its next control poll (≤5 min); drafts stop, nothing is lost`,
  );
}

export function resumeCommand(): void {
  const halt = readHalt();
  const pause = readPause();
  if (!halt && !pause) {
    log("nothing to resume (no halt or pause marker)");
  } else {
    if (halt) log(`clearing halt (was: ${halt.reason})`);
    if (pause) log("clearing local pause");
    clearHalt();
    clearPause();
  }
  const svc = serviceState();
  if (svc.installed) {
    const r = startService();
    log(r.note);
  } else {
    log("no service installed — start the loop with: engager-agent");
  }
}

export function stopCommand(): void {
  const svc = serviceState();
  if (svc.installed) {
    const r = stopService();
    log(r.note);
    return;
  }
  const st = readStatus();
  if (st && pidAlive(st.pid)) {
    process.kill(st.pid, "SIGTERM");
    log(`sent SIGTERM to pid ${st.pid} — it will shut down cleanly within a moment`);
  } else {
    log("not running");
  }
}

/** True = handled here; false = caller should start the foreground loop. */
export function startCommand(): boolean {
  const svc = serviceState();
  if (!svc.installed) return false;
  const r = startService();
  log(r.note);
  return true;
}

export function serviceCommand(action: string | undefined): void {
  switch (action) {
    case "install": {
      const r = installService();
      log(r.note);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "uninstall": {
      const r = uninstallService();
      log(r.note);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "status": {
      statusCommand(false);
      break;
    }
    default:
      log("usage: engager-agent service <install|uninstall|status>");
      process.exit(1);
  }
}

const BOOLEAN_FLAGS = new Set(["--version", "-v", "--help", "-h", "--once", "--service", "--json"]);
const VALUE_FLAGS = new Set(["--batch", "--campaign", "--interval", "--for"]);

/** First dash-prefixed token that isn't a known flag (or a known flag's value).
 *  Lives here (not cli.ts) so tests can import it — cli.ts runs main() on load. */
export function findUnknownFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("-")) continue;
    if (BOOLEAN_FLAGS.has(a)) continue;
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    return a;
  }
  return undefined;
}
