import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Runner configuration, persisted at ~/.engager/agent.json (0600 — it holds the
 * API key). ENGAGER_AGENT_HOME overrides the directory (tests point it at a
 * tmpdir; a user could run several profiles).
 */
export type AgentConfig = {
  /** Hosted MCP endpoint, e.g. https://mcp.example.com/mcp */
  mcpUrl: string;
  /** Per-org API key (scopes: feed:read + messages:write). */
  apiKey: string;
  /** Agent CLI that runs the drafting sessions. v1 ships claude only. */
  cli: "claude";
  /** Model passed to the CLI (sonnet | opus | haiku for claude). */
  model: string;
  /** The agent-led campaign this runner drives. */
  campaignId: number;
  /** Wake interval. 60 = hourly micro-batches (the design default). */
  intervalMinutes: number;
  /** --max-turns guard for each headless session. */
  maxTurns: number;
  /** Hard daily ceiling on LLM sessions (cost guard; preflight skips are free). */
  dailySessionCap: number;
  /** Stable per-machine id for server-side heartbeats (generated once). */
  runnerId?: string;
};

export const CONFIG_DEFAULTS = {
  cli: "claude" as const,
  model: "sonnet",
  intervalMinutes: 60,
  maxTurns: 80,
  dailySessionCap: 24,
};

export function agentHome(): string {
  return process.env.ENGAGER_AGENT_HOME ?? join(homedir(), ".engager");
}

export function configPath(): string {
  return join(agentHome(), "agent.json");
}

export function loadConfig(): AgentConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AgentConfig>;
  if (!raw.mcpUrl || !raw.apiKey || raw.campaignId == null) return null;
  return { ...CONFIG_DEFAULTS, campaignId: raw.campaignId, ...raw } as AgentConfig;
}

export function saveConfig(cfg: AgentConfig): void {
  mkdirSync(agentHome(), { recursive: true });
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600); // writeFileSync mode is ignored when the file pre-exists
}

/** Backfill + persist a stable runnerId for configs written before heartbeats. */
export function ensureRunnerId(cfg: AgentConfig): AgentConfig {
  if (cfg.runnerId) return cfg;
  const next = {
    ...cfg,
    runnerId: `${hostname().split(".")[0] || "runner"}-${randomBytes(3).toString("hex")}`,
  };
  saveConfig(next);
  return next;
}
