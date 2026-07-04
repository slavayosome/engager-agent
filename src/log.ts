import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentHome } from "./config.js";

/** Console + daily file log (~/.engager/logs/YYYY-MM-DD.log). */
export function log(message: string): void {
  const now = new Date();
  const line = `[${now.toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const dir = join(agentHome(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${now.toISOString().slice(0, 10)}.log`), line + "\n");
  } catch {
    /* file logging is best-effort */
  }
}
