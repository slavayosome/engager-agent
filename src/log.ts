import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";
import { sanitizeTerminalText } from "./errors.js";

/** Console + daily file log (~/.engager/logs/YYYY-MM-DD.log). */
export function log(message: string): void {
  const now = new Date();
  const line = `[${now.toISOString()}] ${sanitizeTerminalText(message)}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const dir = join(agentHome(), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, `${now.toISOString().slice(0, 10)}.log`);
    appendFileSync(path, line + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    /* file logging is best-effort */
  }
}
