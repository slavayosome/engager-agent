import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { CONFIG_DEFAULTS, ensureRunnerId, saveConfig, type AgentConfig } from "./config.js";
import { describeSource, detectEndpoints, type DetectedEndpoint } from "./detect.js";
import { runCycle } from "./loop.js";
import { EngagerMcp } from "./mcp.js";
import { offerRegistration } from "./register.js";
import { installService } from "./service.js";
import { skillsRoot, syncSkill } from "./skills.js";

/**
 * First-run setup: preflight (claude CLI is a hard requirement) → pick a
 * detected endpoint (Claude Desktop/Code configs, local dev server, cloud
 * default — manual URL as the escape hatch) → connect → model → skill install
 * → campaign pick → save → prove the whole chain with a batch-size-1 dry cycle
 * before arming the schedule. Every step verifies live; nothing is taken on
 * faith.
 */
export async function runWizard(existing?: Partial<AgentConfig>): Promise<AgentConfig> {
  p.intro("engager-agent — autonomous drafting runner");

  // 0. Preflight — without the claude CLI nothing downstream can work, so say
  // so BEFORE asking the user for anything.
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (claude.status !== 0) {
    p.log.error(
      "engager-agent drives headless Claude Code sessions — the `claude` CLI is required and was not found on your PATH.\n" +
        "Install it, then re-run this wizard:\n" +
        "  npm install -g @anthropic-ai/claude-code   (or see https://claude.com/claude-code)",
    );
    p.outro("Setup cannot continue without Claude Code.");
    process.exit(1);
  }
  p.log.info(`Claude Code ${claude.stdout.trim()} detected — sessions run on your Claude plan.`);

  // 1. Endpoint — offer what the machine already knows before asking for URLs.
  const sDetect = p.spinner();
  sDetect.start("Looking for existing Engager connections…");
  const detected = await detectEndpoints(existing);
  sDetect.stop(
    detected.some((d) => d.source !== "cloud")
      ? "Found existing Engager connection(s) on this machine."
      : "No existing connections found — Engager Cloud offered as the default.",
  );

  let mcpUrl = "";
  let apiKey = "";
  let mcp: EngagerMcp | null = null;
  let campaigns: Awaited<ReturnType<EngagerMcp["listCampaigns"]>> = [];
  /** Keys that already failed a live connect — never silently reuse them again. */
  const burntKeys = new Set<string>();
  while (!mcp) {
    const MANUAL = -1;
    const choice = must(
      await p.select({
        message: "Which Engager should this runner connect to?",
        options: [
          ...detected.map((d, i) => ({
            value: i,
            label: `${d.url} — ${describeSource(d)}${d.apiKey && !burntKeys.has(d.apiKey) ? " (API key found, no paste needed)" : ""}`,
          })),
          { value: MANUAL, label: "Other — enter a URL manually" },
        ],
      }),
    ) as number;

    let picked: DetectedEndpoint | null = choice === MANUAL ? null : (detected[choice] ?? null);
    if (!picked) {
      const url = must(
        await p.text({
          message: "Engager MCP endpoint",
          placeholder: "https://<your-engager-host>/mcp",
          initialValue: existing?.mcpUrl ?? "",
          validate: (v) => {
            try {
              new URL(v);
              return undefined;
            } catch {
              return "enter a full URL, e.g. https://host/mcp";
            }
          },
        }),
      );
      picked = { url, source: "cloud" };
    }
    mcpUrl = picked.url;
    apiKey =
      picked.apiKey && !burntKeys.has(picked.apiKey)
        ? picked.apiKey
        : must(
            await p.password({
              message: "API key (Settings → API keys — needs feed:read + messages:write)",
            }),
          );

    const s = p.spinner();
    s.start("Connecting…");
    const candidate = new EngagerMcp(mcpUrl, apiKey);
    try {
      await candidate.connect();
      campaigns = await candidate.listCampaigns();
      s.stop(`Connected — ${campaigns.length} campaign(s) visible.`);
      mcp = candidate;
    } catch (e) {
      const msg = (e as Error).message;
      const badKey = /401|unauthorized/i.test(msg);
      if (badKey) burntKeys.add(apiKey); // a reused key that failed → ask next round
      s.stop(
        badKey
          ? `Rejected: the API key is invalid for this endpoint${picked.apiKey === apiKey ? " (the stored one may be stale — enter a fresh key)" : ""}.`
          : /fetch|ECONN|ENOTFOUND|404/i.test(msg)
            ? "Could not reach the endpoint — check the URL (it should end in /mcp)."
            : `Failed: ${msg}`,
      );
    }
  }

  try {
    // 2. Register the hosted MCP in the user's Claude surfaces (idempotent:
    // detect → skip if identical → confirm before any add/update).
    await offerRegistration(mcpUrl, apiKey);

    const model = must(
      await p.select({
        message: "Drafting model for the hourly sessions",
        initialValue: existing?.model ?? CONFIG_DEFAULTS.model,
        options: [
          { value: "sonnet", label: "sonnet — recommended (quality/cost sweet spot)" },
          { value: "opus", label: "opus — premium quality, slower + pricier" },
          { value: "haiku", label: "haiku — cheapest; expect weaker drafts" },
        ],
      }),
    ) as string;

    // 3. Skill install (sha256-verified; refreshed again at every loop start).
    const s2 = p.spinner();
    s2.start("Installing the engager-batch skill…");
    const sync = await syncSkill(mcp, "engager-batch", skillsRoot("claude"));
    s2.stop(
      `engager-batch ${sync.version} in place (${sync.verified} files${
        sync.updated.length ? `, ${sync.updated.length} updated` : ", all current"
      }).`,
    );

    // 4. Campaign pick — agent-led only (this runner never drives server-led).
    const agentLed = campaigns.filter((c) => c.draftingMode === "agent" && c.status === "active");
    if (agentLed.length === 0) {
      p.log.error(
        "No active agent-led campaign found. Create one (draftingMode: agent) in the dashboard or via the engager-campaign skill, then re-run.",
      );
      throw new Error("no agent-led campaign");
    }
    const lines = await Promise.all(
      agentLed.map(async (c) => {
        const q = await mcp!.campaignQueue(c.id);
        return {
          value: c.id,
          label: `${c.name} — runway ${q.runwayDays}d, recommended ${q.recommendedBatchSize}, pool ${q.candidatePool.size}/${q.candidatePool.target}`,
        };
      }),
    );
    const campaignId = must(
      await p.select({ message: "Which campaign should this runner drive?", options: lines }),
    ) as number;

    let cfg: AgentConfig = {
      ...CONFIG_DEFAULTS,
      ...existing,
      mcpUrl,
      apiKey,
      cli: "claude",
      model,
      campaignId,
    };
    saveConfig(cfg);
    cfg = ensureRunnerId(cfg);
    p.log.success("Saved ~/.engager/agent.json (0600).");

    // 5. Dry-run cycle (batch size 1) — prove the whole chain before walking away.
    const dryRun = must(
      await p.confirm({
        message: "Run one batch-size-1 session now to prove the chain end-to-end?",
        initialValue: true,
      }),
    );
    let dryRunOk = true;
    if (dryRun) {
      const outcome = await runCycle(cfg, { batchOverride: 1 });
      if (outcome.ok) p.log.success(`Dry run OK — ${outcome.note}`);
      else {
        dryRunOk = false;
        p.log.warn(`Dry run FAILED — ${outcome.note}. Fix this before arming the loop.`);
      }
    }

    // 6. Autostart (opt-in, only offered when the chain is proven). Deliberate
    // halts survive service mode: launchd restarts crashes, never a halt.
    let serviceInstalled = false;
    if (process.platform === "darwin" && dryRunOk) {
      const auto = must(
        await p.confirm({
          message: "Run engager-agent automatically at login (launchd service, always on)?",
          initialValue: true,
        }),
      );
      if (auto) {
        const r = installService();
        if (r.ok) {
          serviceInstalled = true;
          p.log.success(r.note);
        } else {
          p.log.error(r.note);
        }
      }
    }

    p.outro(
      serviceInstalled
        ? "Setup complete — the service is running. Check it any time with: engager-agent status"
        : "Setup complete. Start the loop with: engager-agent",
    );
    return cfg;
  } finally {
    await mcp.close();
  }
}

function must<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  return v as T;
}
