import type { AgentEngine, EngineName } from "../engine.js";
import { ClaudeEngine } from "./claude.js";
import { CodexEngine } from "./codex.js";

const ENGINES = new Map<string, AgentEngine>();

export function engineFor(
  name: EngineName,
  executablePath?: string,
  configDir?: string,
): AgentEngine {
  const key = JSON.stringify([name, executablePath ?? null, configDir ?? null]);
  const existing = ENGINES.get(key);
  if (existing) return existing;
  const engine =
    name === "codex"
      ? new CodexEngine(executablePath, configDir)
      : new ClaudeEngine(executablePath, configDir);
  ENGINES.set(key, engine);
  return engine;
}

export { ClaudeEngine, CodexEngine };
