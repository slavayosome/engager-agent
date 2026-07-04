import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { CONFIG_DEFAULTS, saveConfig, type AgentConfig } from "./config.js";
import { runCycle } from "./loop.js";
import { EngagerMcp } from "./mcp.js";
import { skillsRoot, syncSkill } from "./skills.js";

/**
 * First-run setup: connect → agent CLI + model → skill install → campaign pick
 * → save → prove the whole chain with a batch-size-1 dry cycle before arming
 * the schedule. Every step verifies live; nothing is taken on faith.
 */
export async function runWizard(existing?: Partial<AgentConfig>): Promise<AgentConfig> {
  p.intro("engager-agent — autonomous drafting runner");

  // 1. Connect + verify (clear error taxonomy: bad URL vs bad key vs scopes).
  let mcpUrl = "";
  let apiKey = "";
  let mcp: EngagerMcp | null = null;
  let campaigns: Awaited<ReturnType<EngagerMcp["listCampaigns"]>> = [];
  while (!mcp) {
    mcpUrl = must(
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
    apiKey = must(
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
      s.stop(
        /401|unauthorized/i.test(msg)
          ? "Rejected: the API key is invalid for this endpoint."
          : /fetch|ECONN|ENOTFOUND|404/i.test(msg)
            ? "Could not reach the endpoint — check the URL (it should end in /mcp)."
            : `Failed: ${msg}`,
      );
    }
  }

  try {
    // 2. Agent CLI + model. v1 requires claude; detect it and pick the model.
    const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (claude.status !== 0) {
      p.log.error(
        "The `claude` CLI is required (v1 runs sessions via headless Claude Code). Install it, then re-run: https://claude.com/claude-code",
      );
      throw new Error("claude CLI not found");
    }
    p.log.info(`Found Claude Code ${claude.stdout.trim()} — sessions run on your Claude plan.`);
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

    const cfg: AgentConfig = {
      ...CONFIG_DEFAULTS,
      ...existing,
      mcpUrl,
      apiKey,
      cli: "claude",
      model,
      campaignId,
    };
    saveConfig(cfg);
    p.log.success("Saved ~/.engager/agent.json (0600).");

    // 5. Dry-run cycle (batch size 1) — prove the whole chain before walking away.
    const dryRun = must(
      await p.confirm({
        message: "Run one batch-size-1 session now to prove the chain end-to-end?",
        initialValue: true,
      }),
    );
    if (dryRun) {
      const outcome = await runCycle(cfg, { batchOverride: 1 });
      if (outcome.ok) p.log.success(`Dry run OK — ${outcome.note}`);
      else p.log.warn(`Dry run FAILED — ${outcome.note}. Fix this before arming the loop.`);
    }

    p.outro("Setup complete. Start the loop with: engager-agent");
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
