#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runCycle, runLoop } from "./loop.js";
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
 *   engager-agent --once          run a single cycle and exit (cron-friendly)
 *   engager-agent --once --batch N  override the batch size for that cycle
 *   engager-agent --campaign ID   override the configured campaign
 *   engager-agent --version       print the version and exit
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (has("--version") || has("-v")) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  if (has("config")) {
    await runWizard(loadConfig() ?? undefined);
    return;
  }

  let cfg = loadConfig();
  if (!cfg) cfg = await runWizard();

  const campaignOverride = val("--campaign");
  if (campaignOverride) cfg = { ...cfg, campaignId: Number(campaignOverride) };

  if (has("--once")) {
    const batch = val("--batch");
    const outcome = await runCycle(cfg, {
      batchOverride: batch != null ? Number(batch) : undefined,
    });
    log(`${outcome.ok ? "OK" : "FAILED"} — ${outcome.note}`);
    process.exit(outcome.ok ? 0 : 1);
  }

  await runLoop(cfg);
}

main().catch((e: unknown) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
