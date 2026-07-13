import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import {
  CONFIG_DEFAULTS,
  createRunnerId,
  isValidRunnerId,
  saveConfig,
  savePartialConfig,
  type AgentConfig,
} from "./config.js";
import { describeSource, detectEndpoints, type DetectedEndpoint } from "./detect.js";
import { openBrowser, pollForKey, startDeviceFlow } from "./deviceauth.js";
import { runCycle } from "./loop.js";
import { EngagerMcp } from "./mcp.js";
import { installService } from "./service.js";
import { skillsRoot, syncSkill } from "./skills.js";

/**
 * First-run setup: preflight (claude CLI is a hard requirement) → pick a
 * detected endpoint (Claude Desktop/Code configs, local dev server, cloud
 * default — manual URL as the escape hatch) → connect → model → skill install
 * → campaign pick → save → prove the whole chain with a batch-size-1 dry cycle
 * before arming the schedule. Every step verifies live; nothing is taken on
 * faith.
 *
 * Returns null when setup finished usefully but incompletely (dedicated runner
 * connected and its batch skill installed, but no agent-led campaign exists).
 * Interactive Claude/Desktop access is a separate credential and setup path.
 */
export async function runWizard(existing?: Partial<AgentConfig>): Promise<AgentConfig | null> {
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

  // The device grant is bound to this stable runner identity. Legacy configs
  // without a runner credential profile intentionally reauthorize below.
  const runnerId = isValidRunnerId(existing?.runnerId) ? existing.runnerId : createRunnerId();

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
        : await acquireKey(mcpUrl, runnerId);

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
      const badKey = /401|unauthorized|dedicated Engager runner profile|tool surface mismatch/i.test(
        msg,
      );
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
    // The runner credential is deliberately NOT registered into Claude Code or
    // Desktop. Headless sessions receive it only through a 0600 temporary MCP
    // config; interactive clients require their own interactive credential.
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

    // 3. Skill install — only the runner's sha256-verified batch workflow.
    const s2 = p.spinner();
    s2.start("Installing the Engager runner skill…");
    const manifests = await mcp.skillManifests();
    const installed: string[] = [];
    for (const m of manifests.filter((manifest) => manifest.name === "engager-batch")) {
      try {
        await syncSkill(mcp, m.name, skillsRoot("claude"));
        installed.push(`${m.name} ${m.version}`);
      } catch (e) {
        throw new Error(`skill ${m.name}: install failed (${(e as Error).message})`);
      }
    }
    if (installed.length === 0) throw new Error("server does not provide engager-batch");
    s2.stop(`Runner skill in place: ${installed.join(", ")}.`);

    // 4. Campaign pick — agent-led only (this runner never drives server-led).
    // Zero campaigns is NOT a failure: everything useful is already done
    // (runner connected, skill installed) — save it and hand off to the
    // dashboard or a separately authorized interactive agent.
    const agentLed = campaigns.filter((c) => c.draftingMode === "agent" && c.status === "active");
    if (agentLed.length === 0) {
      savePartialConfig({
        ...existing,
        mcpUrl,
        apiKey,
        credentialProfile: "runner",
        runnerId,
        cli: "claude",
        model,
      });
      p.log.info("Connection saved — the one missing piece is an active agent-led campaign.");
      p.note(
        "Create an active agent-led campaign:\n" +
          "  · use the Engager dashboard, or\n" +
          "  · use Claude/Desktop with a separate interactive-agent key\n" +
          "then re-run `engager-agent` — it resumes right here.",
        "One step left",
      );
      p.outro("Setup paused, nothing lost — create a campaign, then re-run engager-agent.");
      return null;
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

    // 4b. Wake cadence — how often the runner wakes and how far ahead it drafts
    // (one cadence-window of work per wake). Server-authored from then on: the
    // campaign setting is pushed back in every heartbeat, so it stays editable
    // from the dashboard / update_campaign without re-running this wizard.
    const intervalMinutes = Number(
      must(
        await p.select({
          message: "Wake cadence — how often should the runner wake and draft?",
          initialValue: String(existing?.intervalMinutes ?? CONFIG_DEFAULTS.intervalMinutes),
          options: [
            { value: "60", label: "every hour — hourly micro-batches (recommended)" },
            { value: "120", label: "every 2 hours" },
            { value: "180", label: "every 3 hours" },
            { value: "240", label: "every 4 hours" },
            { value: "360", label: "every 6 hours" },
          ],
        }),
      ) as string,
    );
    let cfg: AgentConfig = {
      ...CONFIG_DEFAULTS,
      ...existing,
      mcpUrl,
      apiKey,
      credentialProfile: "runner",
      runnerId,
      cli: "claude",
      model,
      campaignId,
      intervalMinutes,
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
      else {
        // Do NOT arm anything on a failed proof — config is saved, the user
        // investigates and starts explicitly. (Returning null stops the CLI
        // from falling through into the loop.)
        p.log.warn(`Dry run FAILED — ${outcome.note}.`);
        p.note(
          [
            "Your setup IS saved — only the always-on loop wasn't armed.",
            "",
            "  1. Retry the proof:      engager-agent --once --batch 1",
            "  2. Check runner state:   engager-agent status",
            `  3. Read the full log:    ~/.engager/logs/`,
            '  4. Server-side view:     ask your Claude "how\'s engager doing?"',
            "",
            "When a run verifies OK:",
            "  · start the loop:        engager-agent",
            "  · run it always-on:      engager-agent service install",
          ].join("\n"),
          "Not armed yet — next steps",
        );
        p.outro("Setup saved. Re-prove the chain, then arm the loop.");
        return null;
      }
    }

    // 6. Autostart (opt-in, only offered when the chain is proven). Deliberate
    // halts survive service mode: launchd restarts crashes, never a halt.
    let serviceInstalled = false;
    if (process.platform === "darwin") {
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

    // The card shows THIS campaign's real state, not generic prose — fetch a
    // fresh queue snapshot (the dry run just changed it). Best-effort: if the
    // read fails we fall back to config-only lines.
    const picked = agentLed.find((c) => c.id === campaignId);
    let queueLine: string | null = null;
    let modeLine: string | null = null;
    try {
      const q = await mcp.campaignQueue(campaignId);
      queueLine = `Queue:     ${q.pendingScheduled} scheduled · runway ${q.runwayDays} day(s) · pool ${q.candidatePool.size}/${q.candidatePool.target} candidates`;
      modeLine =
        q.mode === "auto"
          ? "Approvals: AUTO — submitted drafts schedule themselves (paced by your caps)"
          : "Approvals: MANUAL — drafts wait for your review (dashboard or an engager-batch session)";
      if (q.dailyCapacity) {
        queueLine += ` · up to ${q.dailyCapacity} comments/day`;
      }
    } catch {
      /* card degrades gracefully */
    }
    p.note(
      [
        `Campaign:  ${picked?.name ?? `#${campaignId}`} (batch size set by the server each wake)`,
        ...(modeLine ? [modeLine] : []),
        ...(queueLine ? [queueLine] : []),
        `Drafting:  every ~${cfg.intervalMinutes} min when there's headroom, ≤${cfg.dailySessionCap} sessions/day, model ${cfg.model}`,
        'Check:     engager-agent status    · or ask your Claude "how\'s my engager runner?"',
        "Control:   engager-agent pause --for 2h · resume · stop",
        `Logs:      ~/.engager/logs/`,
      ].join("\n"),
      "What happens now",
    );
    p.outro(
      serviceInstalled
        ? "Setup complete — the service is running (starts at login, survives crashes)."
        : "Setup complete — starting the loop in this terminal now (Ctrl-C stops it; restart later with: engager-agent).",
    );
    return cfg;
  } finally {
    await mcp.close();
  }
}

/**
 * Get a dedicated runner credential through the server-selected device profile.
 * There is deliberately no pasted/general-key fallback: an old server cannot
 * prove it issued a least-privilege unattended credential, so setup fails closed.
 */
async function acquireKey(mcpUrl: string, runnerId: string): Promise<string> {
  const s = p.spinner();
  s.start("Requesting a least-privilege runner sign-in code…");
  const start = await startDeviceFlow(mcpUrl, runnerId);
  if (!start) {
    s.stop("This server cannot issue dedicated runner credentials.");
    throw new Error("upgrade the Engager server, then run setup again");
  }
  s.stop(`Your code: ${start.userCode}`);
  p.note(
    `Opening your browser. Confirm the code matches, then Approve:\n${start.verificationUrl}`,
    `Code ${start.userCode}`,
  );
  openBrowser(start.verificationUrl);
  const s2 = p.spinner();
  s2.start("Waiting for runner approval in the browser…");
  const result = await pollForKey(mcpUrl, start);
  if (result.outcome === "approved") {
    s2.stop("Approved — dedicated runner credential received.");
    return result.apiKey;
  }
  s2.stop(`Browser sign-in didn't complete: ${result.note}.`);
  throw new Error(`runner authorization failed: ${result.note}`);
}

function must<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  return v as T;
}
