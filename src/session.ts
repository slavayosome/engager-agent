import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";
import type { CampaignQueue, CampaignRow, IncomingComment } from "./mcp.js";
import { skillsRoot } from "./skills.js";

/**
 * One headless drafting session: build a fully-resolved work order (the LLM
 * never decides WHETHER or HOW MUCH to work — hardening layer 1), spawn the
 * agent CLI, and parse the mandatory JSON summary its skill contract
 * (references/autonomous.md) requires as the last line of output.
 */

export type WorkOrder = {
  campaignId: number;
  batchSize: number;
  replyIds: number[];
  /** Discover campaigns only: a SCOUT wake — rank unranked candidates and draft
   *  ONLY the user's explicit requests, never window-fill. Absent = the classic
   *  draft wake (batchSize new comments). */
  mode?: "draft" | "rank";
  candidatesToRank?: number;
  requestedDrafts?: number;
};

export type SessionSummary = {
  outcome: "ok" | "nothing_to_do" | "partial" | "failed" | "blocked";
  campaignId?: number;
  planned?: number;
  submitted?: number;
  dropped?: number;
  replies?: number;
  /** Discover rank wakes: candidates scored via submit_candidate_ranking. */
  ranked?: number;
  held?: number;
  reasons?: string[];
};

/** FALLBACK sizing for pre-workOrder servers (newer servers author the batch
 *  size in the heartbeat's workOrder — see loop.ts). One wake-window of need:
 *  never draft past the cadence-window's posting headroom (hourly cap × hours
 *  until the next wake), never past the server's recommendation, floor at 0.
 *  A missing hourlyCommentCap (servers that stopped sending the deprecated
 *  column) degrades to uncapped — the recommendation alone. */
export function computeNeed(
  queue: CampaignQueue,
  campaign: CampaignRow,
  intervalMinutes = 60,
): number {
  const cadenceHours = Math.max(1, intervalMinutes / 60);
  const hourlyCap = campaign.hourlyCommentCap ?? 0;
  const windowCap = hourlyCap > 0 ? Math.ceil(hourlyCap * cadenceHours) : Infinity;
  return Math.max(0, Math.min(queue.recommendedBatchSize, windowCap));
}

export function buildPrompt(order: WorkOrder): string {
  if (order.mode === "rank") return buildRankPrompt(order);
  const replies = replyClause(order.replyIds);
  const batch =
    order.batchSize > 0
      ? `Work order: campaign ${order.campaignId}, batch size ${order.batchSize}. Draft for this campaign only, at most ${order.batchSize} comments.`
      : `Work order: campaign ${order.campaignId}, batch size 0. Do NOT draft any new comments this session — reply work only.`;
  return [
    `Run ONE autonomous Engager micro-batch using the engager-batch skill in AUTONOMOUS MODE (follow its references/autonomous.md decision table exactly — no user is present, never ask a question).`,
    batch,
    replies,
    `Finish by printing the autonomous-mode JSON summary as the LAST line of your output.`,
  ].join("\n");
}

/**
 * A DISCOVER campaign's scout wake: the runner ranks unranked pool candidates
 * (submit_candidate_ranking) and drafts ONLY the posts the user explicitly
 * requested (submit_batch, requested-only on discover) — it never window-fills.
 * The candidate pool is the product; the runner scores it, the user picks.
 */
function buildRankPrompt(order: WorkOrder): string {
  const toRank = order.candidatesToRank ?? 0;
  const toDraft = order.requestedDrafts ?? 0;
  const rank =
    toRank > 0
      ? `Score up to ${toRank} unranked candidate post${toRank === 1 ? "" : "s"} for this campaign and submit the scores via submit_candidate_ranking.`
      : `There are no unranked candidates to score this wake.`;
  const drafts =
    toDraft > 0
      ? `Then draft the ${toDraft} post${toDraft === 1 ? "" : "s"} the user explicitly requested (status 'draft_requested') and submit via submit_batch.`
      : `The user has requested no drafts — do NOT draft window-fill comments (this is a discover campaign; the pool is the product).`;
  return [
    `Run ONE autonomous Engager SCOUT micro-batch for a DISCOVER campaign using the engager-batch skill in AUTONOMOUS MODE (follow its references/autonomous.md rank flow exactly — no user is present, never ask a question).`,
    `Work order: campaign ${order.campaignId}, mode RANK.`,
    rank,
    drafts,
    replyClause(order.replyIds),
    `Finish by printing the autonomous-mode JSON summary as the LAST line of your output.`,
  ].join("\n");
}

function replyClause(replyIds: number[]): string {
  return replyIds.length > 0
    ? `Then draft replies for these pending incoming comments via submit_reply, ids: ${replyIds.join(", ")} (sensitivityHold anything hostile/press/legal/profane).`
    : "There are no pending incoming comments — do not look for reply work.";
}

/**
 * The session's tool surface. The skill's web-facts contract ("use YOUR OWN
 * web search — SEARCH-THEN-DECIDE") requires real search tools, so WebSearch/
 * WebFetch are SANCTIONED — without them, headless fact slots either went
 * unsearched (facts-flagged drafts with zero sources) or the agent improvised
 * fetches through the old blanket `Bash(node *)`, an unsandboxed side channel.
 * Bash is now narrowed to the skill's deterministic lint (every invocation
 * form the skill instruction can produce) — arbitrary node is gone.
 */
export function allowedTools(skillsDir: string): string {
  const lint = "scripts/validate-draft.mjs";
  return [
    "mcp__engager__*",
    "Read",
    "WebSearch",
    "WebFetch",
    `Bash(node ${lint}*)`,
    `Bash(node ./${lint}*)`,
    `Bash(node ${skillsDir}/engager-batch/${lint}*)`,
  ].join(",");
}

/** argv for the agent CLI. Pure — unit-tested; claude is the only adapter in v1. */
export function buildCliArgs(
  cfg: Pick<AgentConfig, "cli" | "model" | "maxTurns">,
  prompt: string,
  mcpConfigPath: string,
  skillsDir: string,
): { command: string; args: string[] } {
  if (cfg.cli !== "claude") throw new Error(`unsupported agent CLI: ${cfg.cli}`);
  return {
    command: "claude",
    args: [
      "-p",
      prompt,
      "--model",
      cfg.model,
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--allowedTools",
      allowedTools(skillsDir),
      "--max-turns",
      String(cfg.maxTurns),
      "--output-format",
      "json",
    ],
  };
}

/** The last parseable {"outcome": …} JSON object in the transcript — the skill
 *  contract says it MUST be the final line; scan backwards to be tolerant of a
 *  trailing newline or a wrapper. null = the contract was violated (a failure). */
export function parseSummary(text: string): SessionSummary | null {
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    const start = line.indexOf('{"outcome"');
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(start)) as SessionSummary;
      if (typeof parsed.outcome === "string") return parsed;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Tokens the session consumed. `input` sums fresh + cache-created + cache-read
 *  input tokens (what the plan/API actually processed); `output` is generated. */
export type SessionTokens = { input: number; output: number };

export type SessionResult = {
  exitCode: number;
  summary: SessionSummary | null;
  rawResult: string;
  /** Kept for --json consumers; never shown in human output (it reads as a
   *  bill, but on subscription auth it's only API-equivalent accounting). */
  costUsd?: number;
  tokens?: SessionTokens;
  durationMs: number;
};

/** Sum the envelope's usage block into displayable in/out totals. */
export function parseUsage(usage: unknown): SessionTokens | undefined {
  const u = usage as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object") return undefined;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const input = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  const output = n("output_tokens");
  return input > 0 || output > 0 ? { input, output } : undefined;
}

/** Human token count: 45231 → "45.2k". */
export function fmtTokens(t: SessionTokens): string {
  const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x));
  return `${k(t.input)} in / ${k(t.output)} out`;
}

/**
 * Spawn the headless session. The MCP config is written to a session-scoped
 * tmp dir (it carries the API key) and removed afterwards.
 */
export async function runSession(
  cfg: AgentConfig,
  order: WorkOrder,
  opts: { timeoutMs?: number } = {},
): Promise<SessionResult> {
  const dir = mkdtempSync(join(tmpdir(), "engager-agent-"));
  const mcpConfigPath = join(dir, "mcp.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        engager: {
          type: "http",
          url: cfg.mcpUrl,
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        },
      },
    }),
    { mode: 0o600 },
  );

  const started = Date.now();
  try {
    const { command, args } = buildCliArgs(
      cfg,
      buildPrompt(order),
      mcpConfigPath,
      skillsRoot(cfg.cli),
    );
    const out = await run(command, args, opts.timeoutMs ?? 30 * 60_000);
    // --output-format json → one JSON envelope on stdout with the transcript
    // result string; fall back to raw stdout if the envelope is unparseable.
    let rawResult = out.stdout;
    let costUsd: number | undefined;
    let tokens: SessionTokens | undefined;
    try {
      const envelope = JSON.parse(out.stdout) as {
        result?: string;
        total_cost_usd?: number;
        usage?: unknown;
      };
      if (typeof envelope.result === "string") rawResult = envelope.result;
      costUsd = envelope.total_cost_usd;
      tokens = parseUsage(envelope.usage);
    } catch {
      /* raw stdout */
    }
    return {
      exitCode: out.code,
      summary: parseSummary(rawResult),
      rawResult,
      costUsd,
      ...(tokens ? { tokens } : {}),
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`session timed out after ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
