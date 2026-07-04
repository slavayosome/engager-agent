import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { EngagerMcp } from "./mcp.js";

/**
 * Self-install / refresh a server-served skill into the agent CLI's skill dir
 * (~/.claude/skills/<name>/ for claude), sha256-verified per file. A stale
 * local skill is the top silent-failure source for autonomous runs, so the
 * loop re-verifies hashes at every start and refreshes drift automatically.
 */

export function skillsRoot(cli: "claude"): string {
  void cli; // one adapter today; codex would map to its own skills dir
  return process.env.ENGAGER_AGENT_SKILLS_ROOT ?? join(homedir(), ".claude", "skills");
}

export type SkillSyncResult = {
  version: string;
  updated: string[];
  verified: number;
};

export async function syncSkill(
  mcp: EngagerMcp,
  name: string,
  root: string,
): Promise<SkillSyncResult> {
  const manifest = await mcp.skillManifest(name);
  if (!manifest) throw new Error(`skill "${name}" is not served by this MCP server`);

  const base = join(root, name);
  const updated: string[] = [];
  for (const f of manifest.files) {
    // The manifest is server-controlled input — never let a path escape the skill dir.
    const rel = normalize(f.path);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`skill "${name}" manifest contains an unsafe path: ${f.path}`);
    }
    const dest = join(base, rel);
    const current = existsSync(dest) ? readFileSync(dest) : null;
    if (current && sha256(current) === f.sha256) continue;
    const content = await mcp.skillFile(name, f.path);
    if (sha256(Buffer.from(content, "utf8")) !== f.sha256) {
      throw new Error(
        `skill "${name}" file ${f.path}: content hash does not match the manifest — refusing to install`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    updated.push(f.path);
  }
  return { version: manifest.version, updated, verified: manifest.files.length };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
