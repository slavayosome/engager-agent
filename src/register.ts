import { homedir } from "node:os";
import { join } from "node:path";

/** Read-only compatibility surface used solely to discover an existing
 * interactive Engager endpoint. Runner credentials must never be written into
 * Claude/Codex configuration or process arguments. */
export const MCP_NAME = "engager";

type DesktopEntry = { command: string; args: string[]; env?: Record<string, string> };
export type DesktopConfig = { mcpServers?: Record<string, DesktopEntry> } & Record<
  string,
  unknown
>;

export function desktopConfigPath(): string | null {
  if (process.platform !== "darwin") return null;
  return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}
