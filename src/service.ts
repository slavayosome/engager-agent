import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHome, loadConfig } from "./config.js";
import { pidAlive, readStatus } from "./status.js";
import { AGENT_VERSION } from "./version.js";

export const SERVICE_LABEL = "com.engager.agent";

export function plistPath(): string {
  const root = process.env.ENGAGER_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
  return join(root, `${SERVICE_LABEL}.plist`);
}

export function runtimeRoot(): string {
  return join(agentHome(), "runtime");
}

export function serviceEntryPath(): string {
  return join(runtimeRoot(), "current", "cli.mjs");
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(options: {
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
    <string>${xmlEscape(options.nodePath)}</string>
    <string>${xmlEscape(options.scriptPath)}</string>
    <string>run</string>
    <string>--service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(options.pathEnv)}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
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
  <string>${xmlEscape(options.logPath)}</string>
  <key>StandardErrPath</key>
  <string>${xmlEscape(options.logPath)}</string>
</dict>
</plist>
`;
}

export function stableBrewPath(
  path: string,
  resolve: (value: string) => string = (value) => value,
): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(path);
  if (!match) return path;
  const candidate = `${match[1]}/opt/${match[2]}/${match[3]}`;
  try {
    if (resolve(candidate) === resolve(path)) return candidate;
  } catch {
    /* retain the original only when the stable opt path cannot be proven */
  }
  return candidate;
}

export function isVolatileRuntimePath(path: string): boolean {
  return /(?:^|\/)(?:_npx|\.hermes|Caches?|tmp|\.cache)(?:\/|$)|\/(?:\.nvm\/versions|\.asdf\/installs|\.local\/share\/mise\/installs)\//i.test(
    path,
  );
}

export function resolveDurableNode(): string | null {
  const which = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" });
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    which.status === 0 ? which.stdout.trim() : "",
    process.execPath,
  ].filter(Boolean);
  for (const raw of [...new Set(candidates)]) {
    const candidate = stableBrewPath(raw);
    if (isVolatileRuntimePath(candidate) || !existsSync(candidate)) continue;
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (isVolatileRuntimePath(resolved)) continue;
    const version = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const major = Number(/^v?(\d+)/.exec((version.stdout || version.stderr).trim())?.[1]);
    if (version.status === 0 && major >= 20) return candidate;
  }
  return null;
}

export function resolveSourceBundle(): string {
  const self = fileURLToPath(import.meta.url);
  if (basename(self) === "engager-agent.mjs") return self;
  return join(dirname(dirname(self)), "bundle", "engager-agent.mjs");
}

export type InstalledPayload = {
  version: string;
  sha256: string;
  versionDir: string;
  versionEntryPath: string;
};

export type DurableActivation = {
  currentTarget: string | null;
  previousTarget: string | null;
};

export function installDurablePayload(
  version = AGENT_VERSION,
  sourceBundle = resolveSourceBundle(),
): InstalledPayload {
  if (!existsSync(sourceBundle)) {
    throw new Error(`SERVICE_ENTRY_MISSING: built runner bundle not found at ${sourceBundle}`);
  }
  const bytes = readFileSync(sourceBundle);
  const sourceDirectory = dirname(sourceBundle);
  const watchdogSource = join(sourceDirectory, "engine-watchdog.mjs");
  if (!existsSync(watchdogSource)) {
    throw new Error("SERVICE_ENTRY_MISSING: audited engine watchdog is missing");
  }
  const watchdogBytes = readFileSync(watchdogSource);
  const assetCandidates = [sourceDirectory, dirname(sourceDirectory)];
  const assets = ["LICENSE", "THIRD_PARTY_NOTICES", "THIRD_PARTY_COMPONENTS.json"].map((name) => {
    const source = assetCandidates.map((directory) => join(directory, name)).find(existsSync);
    if (!source) throw new Error(`SERVICE_ENTRY_MISSING: audited payload asset ${name} is missing`);
    return { name, source };
  });
  const sha256 = createHash("sha256").update(bytes).update(watchdogBytes).digest("hex");
  const versions = join(runtimeRoot(), "versions");
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  chmodSync(runtimeRoot(), 0o700);
  chmodSync(versions, 0o700);
  const name = `${version}-${sha256.slice(0, 16)}`;
  const target = join(versions, name);
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(versions, ".staging-"));
    const stagedEntry = join(staging, "cli.mjs");
    const stagedWatchdog = join(staging, "engine-watchdog.mjs");
    copyFileSync(sourceBundle, stagedEntry);
    copyFileSync(watchdogSource, stagedWatchdog);
    chmodSync(stagedEntry, 0o500);
    chmodSync(stagedWatchdog, 0o500);
    for (const asset of assets) {
      const targetAsset = join(staging, asset.name);
      copyFileSync(asset.source, targetAsset);
      chmodSync(targetAsset, 0o400);
    }
    const copied = createHash("sha256")
      .update(readFileSync(stagedEntry))
      .update(readFileSync(stagedWatchdog))
      .digest("hex");
    if (copied !== sha256) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error("SERVICE_ENTRY_MISSING: copied runner bundle failed SHA-256 verification");
    }
    renameSync(staging, target);
  }
  return {
    version,
    sha256,
    versionDir: target,
    versionEntryPath: join(target, "cli.mjs"),
  };
}

/** Switch the lexical current/previous links only after the versioned payload
 * has passed its smoke test. The returned snapshot makes every later service
 * installation step reversible. */
export function activateDurablePayload(payload: InstalledPayload): DurableActivation {
  const current = join(runtimeRoot(), "current");
  const previous = join(runtimeRoot(), "previous");
  const snapshot = {
    currentTarget: readSymlink(current),
    previousTarget: readSymlink(previous),
  };
  if (snapshot.currentTarget) atomicSymlink(previous, snapshot.currentTarget);
  else rmSync(previous, { recursive: true, force: true });
  atomicSymlink(current, relative(runtimeRoot(), payload.versionDir));
  return snapshot;
}

export function restoreDurableActivation(snapshot: DurableActivation): void {
  restoreSymlink(join(runtimeRoot(), "current"), snapshot.currentTarget);
  restoreSymlink(join(runtimeRoot(), "previous"), snapshot.previousTarget);
}

const uid = (): number => process.getuid?.() ?? 501;
const domainTarget = (): string => `gui/${uid()}`;
const serviceTarget = (): string => `${domainTarget()}/${SERVICE_LABEL}`;

function launchctl(...args: string[]): { status: number | null; out: string } {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    status: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export type ServiceState = {
  supported: boolean;
  installed: boolean;
  entryExists: boolean;
  loaded: boolean;
  pid?: number;
};

export function serviceState(): ServiceState {
  const installed = existsSync(plistPath());
  const entryExists = existsSync(serviceEntryPath());
  if (process.platform !== "darwin") {
    return { supported: false, installed, entryExists, loaded: false };
  }
  const result = launchctl("print", serviceTarget());
  if (result.status !== 0) return { supported: true, installed, entryExists, loaded: false };
  const pid = /\bpid\s*=\s*(\d+)/.exec(result.out)?.[1];
  const numericPid = pid ? Number(pid) : undefined;
  return {
    supported: true,
    installed,
    entryExists,
    loaded: numericPid != null && pidAlive(numericPid),
    ...(numericPid != null ? { pid: numericPid } : {}),
  };
}

export function installService(version = AGENT_VERSION): { ok: boolean; note: string } {
  if (process.platform !== "darwin") {
    return { ok: false, note: "native background service is macOS-only; use `engager-agent run`" };
  }
  const nodePath = resolveDurableNode();
  if (!nodePath) {
    return {
      ok: false,
      note:
        "SERVICE_ENTRY_MISSING: no durable Node 20+ runtime found (temporary, npx, nvm/asdf/mise, and Codex-owned runtimes are refused)",
    };
  }
  const config = loadConfig();
  if (!config) {
    return {
      ok: false,
      note: "RUNNER_NOT_CONFIGURED: run `engager-agent setup` before installing the background service",
    };
  }
  let payload: InstalledPayload;
  try {
    payload = installDurablePayload(version);
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) };
  }
  const smoke = spawnSync(nodePath, [payload.versionEntryPath, "--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (smoke.status !== 0 || smoke.stdout.trim() !== version) {
    return { ok: false, note: "SERVICE_ENTRY_MISSING: durable runner bundle failed its version smoke test" };
  }

  const logDir = join(agentHome(), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  mkdirSync(dirname(plistPath()), { recursive: true });
  const plist = renderPlist({
    nodePath,
    scriptPath: serviceEntryPath(),
    logPath: join(logDir, "service.log"),
    pathEnv: trustedServicePath(nodePath, config.enginePath),
  });
  const path = plistPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, plist, { mode: 0o600 });
  const lint = spawnSync("plutil", ["-lint", tmp], { encoding: "utf8" });
  if (lint.status !== 0) {
    rmSync(tmp, { force: true });
    return { ok: false, note: `SERVICE_ENTRY_MISSING: invalid launchd plist: ${lint.stderr.trim()}` };
  }
  const priorPlist = existsSync(path) ? readFileSync(path) : null;
  const activation = activateDurablePayload(payload);
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    const launchedAt = Date.now();
    const enabled = launchctl("enable", serviceTarget());
    if (enabled.status !== 0) throw new Error(`launchctl enable failed: ${enabled.out.trim().slice(0, 300)}`);
    launchctl("bootout", serviceTarget());
    const boot = launchctl("bootstrap", domainTarget(), path);
    if (boot.status !== 0) {
      const legacy = launchctl("load", "-w", path);
      if (legacy.status !== 0) {
        throw new Error(`launchctl failed: ${boot.out.trim().slice(0, 300)}`);
      }
    }
    const verification = waitForServiceLoad({
      notBefore: launchedAt,
      expectedVersion: version,
    });
    if (!verification.ok) {
      throw new Error(`launchd startup verification failed: ${verification.reason}`);
    }
    return {
      ok: true,
      note: `installed ${SERVICE_LABEL} from verified payload ${version}-${payload.sha256.slice(0, 12)}`,
    };
  } catch (error) {
    launchctl("bootout", serviceTarget());
    restoreDurableActivation(activation);
    restorePlist(path, priorPlist);
    let restoreFailure = "";
    if (priorPlist && activation.currentTarget) {
      launchctl("enable", serviceTarget());
      const restored = launchctl("bootstrap", domainTarget(), path);
      if (restored.status !== 0) restoreFailure = `; prior service restore also failed: ${restored.out.trim().slice(0, 200)}`;
    }
    return {
      ok: false,
      note: `SERVICE_ENTRY_MISSING: service install rolled back: ${error instanceof Error ? error.message : String(error)}${restoreFailure}`,
    };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function uninstallService(): { ok: boolean; note: string } {
  if (process.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  const stopped = launchctl("bootout", serviceTarget());
  const tolerated = /could not find service|no such process/i.test(stopped.out);
  if (stopped.status !== 0 && !tolerated) {
    return { ok: false, note: `launchctl uninstall stop failed: ${stopped.out.trim().slice(0, 300)}` };
  }
  rmSync(plistPath(), { force: true });
  return { ok: true, note: `removed ${SERVICE_LABEL}; configuration and versioned runtime were preserved` };
}

export function stopService(): { ok: boolean; note: string } {
  if (process.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  const bootout = launchctl("bootout", serviceTarget());
  const disable = launchctl("disable", serviceTarget());
  const tolerated = /could not find service|no such process/i.test(bootout.out);
  return bootout.status === 0 || tolerated
    ? { ok: disable.status === 0, note: `${SERVICE_LABEL} stopped and disabled` }
    : { ok: false, note: `launchctl stop failed: ${bootout.out.trim().slice(0, 300)}` };
}

export type StartServiceDeps = {
  platform: NodeJS.Platform;
  exists: typeof existsSync;
  now: () => number;
  launch: (...args: string[]) => { status: number | null; out: string };
  wait: typeof waitForServiceLoad;
};

const REAL_START_SERVICE_DEPS: StartServiceDeps = {
  platform: process.platform,
  exists: existsSync,
  now: Date.now,
  launch: launchctl,
  wait: waitForServiceLoad,
};

export function startService(
  deps: StartServiceDeps = REAL_START_SERVICE_DEPS,
): { ok: boolean; note: string } {
  if (deps.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  if (!deps.exists(plistPath()) || !deps.exists(serviceEntryPath())) {
    return { ok: false, note: "SERVICE_ENTRY_MISSING: run `engager-agent service install --repair`" };
  }
  const launchedAt = deps.now();
  const enabled = deps.launch("enable", serviceTarget());
  if (enabled.status !== 0) {
    return { ok: false, note: `launchctl enable failed: ${enabled.out.trim().slice(0, 300)}` };
  }
  const boot = deps.launch("bootstrap", domainTarget(), plistPath());
  const launched = boot.status === 0 ? boot : deps.launch("kickstart", "-k", serviceTarget());
  if (launched.status !== 0) {
    return { ok: false, note: `launchctl start failed: ${launched.out.trim().slice(0, 300)}` };
  }
  const verification = deps.wait({ notBefore: launchedAt });
  if (verification.ok) {
    return {
      ok: true,
      note: `${SERVICE_LABEL} started with current server control and engine readiness verified`,
    };
  }
  const stopped = deps.launch("bootout", serviceTarget());
  const stopNote =
    stopped.status === 0 || /could not find service|no such process/i.test(stopped.out)
      ? "the unverified service was stopped"
      : `WARNING: unverified service stop failed: ${stopped.out.trim().slice(0, 200)}`;
  return {
    ok: false,
    note: `${SERVICE_LABEL} startup verification failed: ${verification.reason}; ${stopNote}`,
  };
}

export function kickstartService(): void {
  if (process.platform === "darwin") launchctl("kickstart", "-k", serviceTarget());
}

function atomicSymlink(path: string, target: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(target, tmp, "dir");
  renameSync(tmp, path);
}

function restoreSymlink(path: string, target: string | null): void {
  if (target) atomicSymlink(path, target);
  else rmSync(path, { recursive: true, force: true });
}

function restorePlist(path: string, contents: Buffer | null): void {
  if (!contents) {
    rmSync(path, { force: true });
    return;
  }
  const tmp = `${path}.${process.pid}.rollback`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export type ServiceVerificationOptions = {
  notBefore: number;
  expectedVersion?: string;
};

export type ServiceVerificationState =
  | { state: "pending" }
  | { state: "verified" }
  | { state: "terminal"; reason: string };

export type ServiceWaitResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ServiceWaitDeps = {
  now: () => number;
  service: () => ServiceState;
  status: typeof readStatus;
  pause: (milliseconds: number) => void;
};

const REAL_SERVICE_WAIT_DEPS: ServiceWaitDeps = {
  now: Date.now,
  service: serviceState,
  status: readStatus,
  pause: (milliseconds) => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, milliseconds);
  },
};

export function waitForServiceLoad(
  options: ServiceVerificationOptions,
  timeoutMs = 45_000,
  deps: ServiceWaitDeps = REAL_SERVICE_WAIT_DEPS,
): ServiceWaitResult {
  const deadline = deps.now() + timeoutMs;
  do {
    const verification = serviceVerificationState(
      deps.service(),
      deps.status(),
      options,
    );
    if (verification.state === "verified") return { ok: true };
    if (verification.state === "terminal") {
      return { ok: false, reason: verification.reason };
    }
    deps.pause(150);
  } while (deps.now() < deadline);
  return {
    ok: false,
    reason: "timed out waiting for current protocol control and engine readiness",
  };
}

export function isVerifiedServiceStatus(
  service: ServiceState,
  status: ReturnType<typeof readStatus>,
  options: ServiceVerificationOptions = { notBefore: 0 },
): boolean {
  return serviceVerificationState(service, status, options).state === "verified";
}

export function serviceVerificationState(
  service: ServiceState,
  status: ReturnType<typeof readStatus>,
  options: ServiceVerificationOptions = { notBefore: 0 },
): ServiceVerificationState {
  const current = Boolean(
    service.loaded &&
      service.pid != null &&
      status?.pid === service.pid &&
      status.startedAt >= options.notBefore &&
      (options.expectedVersion == null || status.version === options.expectedVersion) &&
      pidAlive(service.pid),
  );
  if (!current || !status) return { state: "pending" };
  const protocolVerified =
    status.protocol === "2.1" &&
    status.protocolVerifiedAt != null &&
    status.protocolVerifiedAt >= status.startedAt;
  const engineVerified =
    status.engineReadyAt != null &&
    status.engineReadyAt >= status.startedAt &&
    status.engineReadyAt >= options.notBefore;
  const startupVerified =
    status.startupVerifiedAt != null &&
    status.startupVerifiedAt >= status.startedAt &&
    status.startupVerifiedAt >= options.notBefore;
  if (
    protocolVerified &&
    engineVerified &&
    startupVerified &&
    status.state !== "halted" &&
    status.state !== "upgrade-required"
  ) {
    return { state: "verified" };
  }
  const reasonCode = status.quotaState?.reasonCode;
  if (
    protocolVerified &&
    !engineVerified &&
    typeof reasonCode === "string" &&
    TERMINAL_ENGINE_READINESS_REASONS.has(reasonCode)
  ) {
    return {
      state: "terminal",
      reason: engineReadinessFailureReason(reasonCode),
    };
  }
  return { state: "pending" };
}

const TERMINAL_ENGINE_READINESS_REASONS = new Set([
  "engine_not_found",
  "engine_unsupported_version",
  "engine_auth_required",
  "engine_auth_probe_unknown",
  "engine_probe_failed",
]);

function engineReadinessFailureReason(reasonCode: string): string {
  const detail: Record<string, string> = {
    engine_not_found: "the configured engine executable was not found",
    engine_unsupported_version: "the configured engine version or capability surface is unsupported",
    engine_auth_required: "the configured engine is not authenticated",
    engine_auth_probe_unknown: "the configured engine authentication state could not be verified",
    engine_probe_failed: "the configured engine readiness probe failed",
  };
  return `${detail[reasonCode] ?? "the configured engine is not ready"} (${reasonCode}); run \`engager-agent doctor\``;
}

export function trustedServicePath(nodePath: string, enginePath: string): string {
  return [...new Set([
    dirname(nodePath),
    dirname(enginePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ])].join(":");
}

function readSymlink(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}
