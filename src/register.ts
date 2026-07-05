import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

/**
 * Idempotent registration of the hosted Engager MCP into the user's Claude
 * surfaces. Never blind: each target is detect → compare → skip if identical /
 * confirm before add or update. Desktop config writes are backed up + atomic,
 * and only the `mcpServers.engager` entry is ever touched.
 *
 * The pure planners (parseClaudeMcpGet / planDesktopMerge) are unit-tested;
 * the interactive layer just executes their plans.
 */

export const MCP_NAME = "engager";

// ---------- Claude Code (via the claude CLI) ----------

export type CodeState = { registered: boolean; url?: string };

/** What `claude mcp get engager` told us. Absence is signalled by a non-zero
 *  exit OR the "No MCP server named" message — don't trust exit codes alone. */
export function parseClaudeMcpGet(stdout: string, exitCode: number): CodeState {
  if (exitCode !== 0 || /No MCP server named/i.test(stdout)) return { registered: false };
  const url =
    /\bURL:\s*(\S+)/i.exec(stdout)?.[1] ?? /\b(https?:\/\/\S+)/i.exec(stdout)?.[1];
  return { registered: true, ...(url ? { url } : {}) };
}

export type Exec = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function detectClaudeCode(exec: Exec = realExec): CodeState | null {
  const version = exec("claude", ["--version"]);
  if (version.status !== 0) return null; // claude CLI not installed → target absent
  const r = exec("claude", ["mcp", "get", MCP_NAME]);
  return parseClaudeMcpGet(r.stdout + r.stderr, r.status ?? 1);
}

export function applyClaudeCode(
  mcpUrl: string,
  apiKey: string,
  replace: boolean,
  exec: Exec = realExec,
): { ok: boolean; note: string } {
  if (replace) exec("claude", ["mcp", "remove", "-s", "user", MCP_NAME]);
  const r = exec("claude", [
    "mcp",
    "add",
    "-s",
    "user",
    "-t",
    "http",
    MCP_NAME,
    mcpUrl,
    "-H",
    `Authorization: Bearer ${apiKey}`,
  ]);
  return r.status === 0
    ? { ok: true, note: `registered "${MCP_NAME}" for Claude Code (user scope)` }
    : { ok: false, note: `claude mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
}

// ---------- Claude Desktop (config-file merge) ----------

type DesktopEntry = { command: string; args: string[]; env?: Record<string, string> };
export type DesktopConfig = { mcpServers?: Record<string, DesktopEntry> } & Record<
  string,
  unknown
>;

/** The stdio bridge entry Desktop needs (it can't take remote HTTP servers
 *  programmatically) — same proven shape as a hand-written mcp-remote entry. */
export function desktopEntry(mcpUrl: string, apiKey: string): DesktopEntry {
  return {
    command: "npx",
    args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${apiKey}`],
  };
}

export type DesktopPlan = { action: "skip" | "add" | "update"; next: DesktopConfig };

/** Pure merge plan: touches ONLY mcpServers.engager, preserves everything else. */
export function planDesktopMerge(
  config: DesktopConfig,
  mcpUrl: string,
  apiKey: string,
): DesktopPlan {
  const entry = desktopEntry(mcpUrl, apiKey);
  const existing = config.mcpServers?.[MCP_NAME];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { action: "skip", next: config };
  }
  return {
    action: existing ? "update" : "add",
    next: { ...config, mcpServers: { ...(config.mcpServers ?? {}), [MCP_NAME]: entry } },
  };
}

/** Summarize the existing entry's target for a confirm prompt WITHOUT the key. */
export function describeDesktopEntry(entry: DesktopEntry | undefined): string {
  if (!entry) return "none";
  const url = entry.args.find((a) => /^https?:\/\//.test(a));
  return url ?? `${entry.command} ${entry.args[0] ?? ""}`.trim();
}

export function desktopConfigPath(): string | null {
  if (process.platform !== "darwin") return null; // Desktop merge is macOS-only for now
  return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

/** Backup (timestamped) + atomic write. Throws on unparseable existing config —
 *  never overwrite a file we couldn't faithfully re-serialize. */
export function applyDesktopPlan(path: string, plan: DesktopPlan): { backup: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak-${stamp}`;
  copyFileSync(path, backup);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan.next, null, 2) + "\n");
  renameSync(tmp, path);
  return { backup };
}

// ---------- Interactive flow (wizard step + `engager-agent register`) ----------

/**
 * Offer registration into every detected Claude surface. Each target is an
 * individual opt-in; identical existing registrations are skipped with a note.
 */
export async function offerRegistration(mcpUrl: string, apiKey: string): Promise<void> {
  // Claude Code
  const code = detectClaudeCode();
  if (!code) {
    p.log.warn("claude CLI not found — skipping Claude Code registration.");
  } else if (code.registered && code.url === mcpUrl) {
    p.log.info(`Claude Code: "${MCP_NAME}" already points at ${mcpUrl} — nothing to do.`);
  } else {
    const label = code.registered
      ? `Claude Code has "${MCP_NAME}" → ${code.url ?? "unknown URL"}. Replace with ${mcpUrl}?`
      : `Register the Engager MCP in Claude Code (${mcpUrl})?`;
    const yes = await p.confirm({ message: label, initialValue: true });
    if (!p.isCancel(yes) && yes) {
      const r = applyClaudeCode(mcpUrl, apiKey, code.registered);
      if (r.ok) p.log.success(r.note);
      else p.log.error(r.note);
    }
  }

  // Claude Desktop
  const configPath = desktopConfigPath();
  if (!configPath || !existsSync(configPath)) {
    p.log.info("Claude Desktop config not found — skipping (add it in Settings → Connectors).");
    return;
  }
  let config: DesktopConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as DesktopConfig;
  } catch {
    p.log.warn("Claude Desktop config is not valid JSON — refusing to touch it.");
    return;
  }
  const plan = planDesktopMerge(config, mcpUrl, apiKey);
  if (plan.action === "skip") {
    p.log.info(`Claude Desktop: "${MCP_NAME}" already configured identically — nothing to do.`);
    return;
  }
  const existing = describeDesktopEntry(config.mcpServers?.[MCP_NAME]);
  const label =
    plan.action === "update"
      ? `Claude Desktop has "${MCP_NAME}" → ${existing}. Replace with ${mcpUrl}?`
      : `Register the Engager MCP in Claude Desktop (via an mcp-remote bridge)?`;
  const yes = await p.confirm({ message: label, initialValue: true });
  if (p.isCancel(yes) || !yes) return;
  const { backup } = applyDesktopPlan(configPath, plan);
  p.log.success(
    `Claude Desktop config updated (backup: ${backup}). Restart Claude Desktop to pick it up.`,
  );
}
