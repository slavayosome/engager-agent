import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";
import type { CampaignQueue, CampaignRow, IncomingComment } from "./mcp.js";

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
};

export type SessionSummary = {
  outcome: "ok" | "nothing_to_do" | "partial" | "failed" | "blocked";
  campaignId?: number;
  planned?: number;
  submitted?: number;
  dropped?: number;
  replies?: number;
  held?: number;
  reasons?: string[];
};

/** Hourly need: never draft past this hour's posting headroom, never past the
 *  server's recommendation, floor at 0. */
export function computeNeed(queue: CampaignQueue, campaign: CampaignRow): number {
  const hourly = campaign.hourlyCommentCap > 0 ? campaign.hourlyCommentCap : Infinity;
  return Math.max(0, Math.min(queue.recommendedBatchSize, hourly));
}

export function buildPrompt(order: WorkOrder): string {
  const replies =
    order.replyIds.length > 0
      ? `Then draft replies for these pending incoming comments via submit_reply, ids: ${order.replyIds.join(", ")} (sensitivityHold anything hostile/press/legal/profane).`
      : "There are no pending incoming comments — do not look for reply work.";
  return [
    `Run ONE autonomous Engager micro-batch using the engager-batch skill in AUTONOMOUS MODE (follow its references/autonomous.md decision table exactly — no user is present, never ask a question).`,
    `Work order: campaign ${order.campaignId}, batch size ${order.batchSize}. Draft for this campaign only, at most ${order.batchSize} comments.`,
    replies,
    `Finish by printing the autonomous-mode JSON summary as the LAST line of your output.`,
  ].join("\n");
}

/** argv for the agent CLI. Pure — unit-tested; claude is the only adapter in v1. */
export function buildCliArgs(
  cfg: Pick<AgentConfig, "cli" | "model" | "maxTurns">,
  prompt: string,
  mcpConfigPath: string,
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
      // The session needs: the Engager MCP tools, Read (skill files), and node
      // for the skill's deterministic lint (validate-draft.mjs). Nothing else.
      "--allowedTools",
      "mcp__engager__*,Read,Bash(node *)",
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

export type SessionResult = {
  exitCode: number;
  summary: SessionSummary | null;
  rawResult: string;
  costUsd?: number;
  durationMs: number;
};

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
    const { command, args } = buildCliArgs(cfg, buildPrompt(order), mcpConfigPath);
    const out = await run(command, args, opts.timeoutMs ?? 30 * 60_000);
    // --output-format json → one JSON envelope on stdout with the transcript
    // result string; fall back to raw stdout if the envelope is unparseable.
    let rawResult = out.stdout;
    let costUsd: number | undefined;
    try {
      const envelope = JSON.parse(out.stdout) as { result?: string; total_cost_usd?: number };
      if (typeof envelope.result === "string") rawResult = envelope.result;
      costUsd = envelope.total_cost_usd;
    } catch {
      /* raw stdout */
    }
    return {
      exitCode: out.code,
      summary: parseSummary(rawResult),
      rawResult,
      costUsd,
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
