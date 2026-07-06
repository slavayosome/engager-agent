import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHome } from "./config.js";

/**
 * macOS launchd LaunchAgent for the always-on runner. The KeepAlive contract is
 * the crux: `SuccessfulExit: false` restarts CRASHES (non-zero exits) but leaves
 * deliberate halts (exit 0 + ~/.engager/halted.json) down — so the loop's
 * "never fail silently" invariant survives service mode. `engager-agent stop`
 * must go through bootout+disable; a plain SIGTERM would just be restarted.
 */

export const SERVICE_LABEL = "com.engager.agent";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pure plist render (unit-tested). PATH is captured from the installing shell
 *  so the headless sessions can find `claude` and `npx` under launchd's
 *  minimal environment. */
export function renderPlist(opts: {
  nodePath: string;
  scriptPath: string;
  logPath: string;
  pathEnv: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.scriptPath)}</string>
    <string>--service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(opts.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Homebrew keg paths are versioned (…/Cellar/<formula>/<version>/…) and the old
 * keg is deleted by `brew upgrade` — a plist that points into a keg kills the
 * running service mid-session and leaves autostart pointing at nothing on the
 * next upgrade. Rewrite to the stable `opt/<formula>` symlink whenever it
 * resolves to the same file; non-brew paths pass through untouched.
 */
export function stableBrewPath(
  p: string,
  resolve: (path: string) => string = realpathSync,
): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(p);
  if (!m) return p;
  const candidate = `${m[1]}/opt/${m[2]}/${m[3]}`;
  try {
    if (resolve(candidate) === resolve(p)) return candidate;
  } catch {
    /* opt symlink missing or dangling — keep the keg path */
  }
  return p;
}

/** The real cli.js entry — through the npm bin symlink if that's how we ran. */
export function resolveEntryScript(): string {
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return realpathSync(argv1);
    } catch {
      /* fall through */
    }
  }
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

const uid = (): number => process.getuid?.() ?? 501;
const domainTarget = (): string => `gui/${uid()}`;
const serviceTarget = (): string => `${domainTarget()}/${SERVICE_LABEL}`;

function launchctl(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export type ServiceState = {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  pid?: number;
};

export function serviceState(): ServiceState {
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false };
  }
  const installed = existsSync(plistPath());
  const r = launchctl("print", serviceTarget());
  if (r.status !== 0) return { supported: true, installed, loaded: false };
  const pid = /\bpid\s*=\s*(\d+)/.exec(r.out)?.[1];
  return { supported: true, installed, loaded: true, ...(pid ? { pid: Number(pid) } : {}) };
}

export function installService(): { ok: boolean; note: string } {
  if (process.platform !== "darwin") {
    return { ok: false, note: "autostart is macOS-only for now (launchd)" };
  }
  const logDir = join(agentHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const plist = renderPlist({
    nodePath: stableBrewPath(process.execPath),
    scriptPath: stableBrewPath(resolveEntryScript()),
    logPath: join(logDir, "service.log"),
    pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  });
  writeFileSync(plistPath(), plist);
  // Re-load cleanly: enable (in case a previous `stop` disabled it), drop any
  // stale registration, then bootstrap; `load -w` is the pre-10.13 fallback.
  launchctl("enable", serviceTarget());
  launchctl("bootout", serviceTarget());
  const boot = launchctl("bootstrap", domainTarget(), plistPath());
  if (boot.status !== 0) {
    const legacy = launchctl("load", "-w", plistPath());
    if (legacy.status !== 0) {
      return { ok: false, note: `launchctl bootstrap failed: ${boot.out.trim().slice(0, 200)}` };
    }
  }
  return { ok: true, note: `installed + started ${SERVICE_LABEL} (runs at login, restarts on crash)` };
}

export function uninstallService(): { ok: boolean; note: string } {
  if (process.platform !== "darwin") {
    return { ok: false, note: "autostart is macOS-only for now (launchd)" };
  }
  launchctl("bootout", serviceTarget());
  rmSync(plistPath(), { force: true });
  return { ok: true, note: `removed ${SERVICE_LABEL}` };
}

/** Stop across logins: unload AND disable (KeepAlive can't fight a disable). */
export function stopService(): { ok: boolean; note: string } {
  launchctl("bootout", serviceTarget());
  launchctl("disable", serviceTarget());
  return { ok: true, note: `${SERVICE_LABEL} stopped and disabled (start again with: engager-agent start)` };
}

export function startService(): { ok: boolean; note: string } {
  if (!existsSync(plistPath())) {
    return { ok: false, note: "service not installed — run: engager-agent service install" };
  }
  launchctl("enable", serviceTarget());
  const boot = launchctl("bootstrap", domainTarget(), plistPath());
  if (boot.status !== 0) launchctl("kickstart", serviceTarget());
  return { ok: true, note: `${SERVICE_LABEL} started` };
}

export function kickstartService(): void {
  launchctl("kickstart", serviceTarget());
}
