#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  pauseCommand,
  resumeCommand,
  serviceCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./commands.js";
import { ensureRunnerId, loadConfig, loadPartialConfig, saveConfig } from "./config.js";
import { controlPoll } from "./heartbeat.js";
import { log } from "./log.js";
import { runCycle, runLoop } from "./loop.js";
import { writeHalt } from "./markers.js";
import { offerRegistration } from "./register.js";
import { serviceState } from "./service.js";
import { runWizard } from "./wizard.js";

/** Package version, read at runtime from package.json (one level up from src/ or dist/). */
function version(): string {
  const pkg = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(pkg, "utf8")).version as string;
}

/**
 * engager-agent — local autonomous runner for Engager agent-led campaigns.
 *
 *   engager-agent                 first run: setup wizard; then: start the loop
 *   engager-agent config          re-run the wizard (rotate key, switch campaign/model)
 *   engager-agent register        (re-)register the Engager MCP in Claude Code + Desktop
 *   engager-agent status [--json] runner health: state, last cycle, markers, service
 *   engager-agent pause [--for 2h]  hold drafting (marker; survives restarts)
 *   engager-agent resume          clear pause/halt markers + restart the service
 *   engager-agent stop            stop (and disable) the service, or SIGTERM the loop
 *   engager-agent start           start the installed service (or fall through to the loop)
 *   engager-agent service install|uninstall|status   manage the launchd autostart
 *   engager-agent --once          run a single cycle and exit (cron-friendly)
 *   engager-agent --once --batch N  override the batch size for that cycle
 *   engager-agent --campaign ID   override the configured campaign
 *   engager-agent --interval N|Nh  set + persist the wake cadence (minutes, or hours with "h")
 *   engager-agent --service       loop in service mode (used by the launchd plist)
 *   engager-agent --version       print the version and exit
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;

  if (has("--version") || has("-v")) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  switch (cmd) {
    case "config":
      await runWizard(loadConfig() ?? loadPartialConfig() ?? undefined);
      return;
    case "register": {
      // A partial (campaign-less) config is enough — registration only needs
      // the endpoint + key.
      const partial = loadPartialConfig();
      if (!partial?.mcpUrl || !partial.apiKey) {
        log("not configured yet — run: engager-agent");
        process.exit(1);
      }
      await offerRegistration(partial.mcpUrl, partial.apiKey);
      return;
    }
    case "status":
      statusCommand(has("--json"));
      return;
    case "pause":
      pauseCommand(val("--for"));
      return;
    case "resume":
      resumeCommand();
      return;
    case "stop":
      stopCommand();
      return;
    case "service":
      serviceCommand(argv[1]);
      return;
    case "start":
      if (startCommand()) return;
      break; // no service installed → fall through to the foreground loop
    case null:
      break;
    default:
      log(`unknown command "${cmd}" — see: engager-agent --help (or the README)`);
      process.exit(1);
  }

  let cfg = loadConfig();
  if (!cfg && has("--service")) {
    // No TTY under launchd — never try to run the wizard there. Exit 0 so
    // KeepAlive doesn't crash-loop a half-installed setup.
    log("not configured — run `engager-agent` in a terminal to set up");
    process.exit(0);
  }
  if (!cfg) {
    const done = await runWizard(loadPartialConfig() ?? undefined);
    // null = useful-but-incomplete (connected + registered + skills, no
    // campaign yet): the wizard already said how to continue — exit cleanly.
    if (!done) return;
    cfg = done;
    // The wizard may have installed + started the service; don't double-run.
    if (serviceState().loaded) {
      log("the background service is running — check it any time with: engager-agent status");
      return;
    }
  }
  cfg = ensureRunnerId(cfg);

  const campaignOverride = val("--campaign");
  if (campaignOverride) cfg = { ...cfg, campaignId: Number(campaignOverride) };

  // Persisted cadence override: "90" = minutes, "2h" = hours. Local seed only —
  // when the campaign carries a server-authored cadence, the next heartbeat wins.
  const intervalOverride = val("--interval");
  if (intervalOverride) {
    const m = /^(\d+(?:\.\d+)?)(h)?$/i.exec(intervalOverride.trim());
    const minutes = m ? Math.round(Number(m[1]) * (m[2] ? 60 : 1)) : NaN;
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 1440) {
      log(`--interval must be 15..1440 minutes (or 1h..24h), got "${intervalOverride}"`);
      process.exit(1);
    }
    cfg = { ...cfg, intervalMinutes: minutes };
    saveConfig(cfg);
    log(`wake cadence set: every ${minutes} min (persisted)`);
  }

  if (has("--once")) {
    const batch = val("--batch");
    const outcome = await runCycle(cfg, {
      batchOverride: batch != null ? Number(batch) : undefined,
    });
    log(`${outcome.ok ? "OK" : "FAILED"} — ${outcome.note}`);
    if (outcome.fatal) writeHalt(outcome.note); // cron wrappers see the marker too
    try {
      await controlPoll(cfg, version(), {
        state: "sleeping",
        lastCycle: { at: Date.now(), ran: outcome.ran, ok: outcome.ok, note: outcome.note },
        consecutiveFailures: outcome.ok ? 0 : 1,
        sessionsToday: outcome.ran ? 1 : 0,
      });
    } catch {
      /* heartbeat is best-effort */
    }
    process.exit(outcome.ok ? 0 : 1);
  }

  await runLoop(cfg, { service: has("--service"), version: version() });
}

main().catch((e: unknown) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
