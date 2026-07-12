import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHome, loadConfig } from "./config.js";
import {
  commitVerifiedFileDurably,
  renamePathDurably,
  removePathDurably,
  syncDirectoryDurably,
  syncFileDurably,
} from "./durable.js";
import { MAINTENANCE_TOKEN_ENV } from "./lock.js";
import { pidAlive, readStatus } from "./status.js";
import {
  advanceUpgradeTransition,
  clearUpgradeTransition,
  fileSnapshot,
  fileSnapshotContents,
  isManagedRuntimeTarget,
  prepareUpgradeTransition,
  readUpgradeTransition,
  sha256,
  writeUpgradeTransition,
  type RuntimeLinkSnapshot,
  type UpgradeTransition,
} from "./upgrade-transition.js";
import { AGENT_VERSION } from "./version.js";

export const SERVICE_LABEL = "com.engager.agent";
export const LAUNCHCTL_PATH = "/bin/launchctl";
export const PLUTIL_PATH = "/usr/bin/plutil";
export const LAUNCHCTL_TIMEOUT_MS = 10_000;
export const PLUTIL_TIMEOUT_MS = 5_000;

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
  maintenanceToken?: string;
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
${options.maintenanceToken ? `    <key>${MAINTENANCE_TOKEN_ENV}</key>
    <string>${xmlEscape(options.maintenanceToken)}</string>
` : ""}  </dict>
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
  const which = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8", timeout: 5_000 });
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
  const manifestSources = [
    { name: "cli.mjs", bytes, mode: 0o500 },
    { name: "engine-watchdog.mjs", bytes: watchdogBytes, mode: 0o500 },
    ...assets.map((asset) => ({
      name: asset.name,
      bytes: readFileSync(asset.source),
      mode: 0o400,
    })),
  ];
  const sha256 = payloadManifestDigest(manifestSources);
  const home = agentHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const runtime = runtimeRoot();
  ensureOwnedPrivateDirectory(runtime, "runtime root");
  // Commit the runtime directory entry before any transition can reference a
  // child beneath it. This is required even when mkdir found an existing path:
  // a prior power-loss boundary may not have committed its parent entry.
  syncDirectoryDurably(home);
  const versions = join(runtime, "versions");
  ensureOwnedPrivateDirectory(versions, "runtime versions root");
  // The versions entry must be durable before a staged payload is renamed or
  // a transition journal can name it.
  syncDirectoryDurably(runtime);
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
    const copied = payloadManifestDigest(
      manifestSources.map((file) => ({
        name: file.name,
        bytes: readFileSync(join(staging, file.name)),
        mode: lstatSync(join(staging, file.name)).mode & 0o777,
      })),
    );
    if (copied !== sha256) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error("SERVICE_ENTRY_MISSING: copied runner bundle failed SHA-256 verification");
    }
    for (const file of manifestSources) syncFileDurably(join(staging, file.name));
    syncDirectoryDurably(staging);
    renamePathDurably(staging, target);
  }
  verifyDurablePayload(target, sha256, manifestSources);
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
  assertManagedRuntimeLink(current);
  assertManagedRuntimeLink(previous);
  const snapshot = {
    currentTarget: readSymlink(current),
    previousTarget: readSymlink(previous),
  };
  const target = relative(runtimeRoot(), payload.versionDir);
  if (!target || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) {
    throw new Error("SERVICE_ENTRY_MISSING: durable payload is outside the managed runtime root");
  }
  if (snapshot.currentTarget === target) return snapshot;
  try {
    if (snapshot.currentTarget) atomicSymlink(previous, snapshot.currentTarget);
    else if (pathExists(previous)) removePathDurably(previous);
    atomicSymlink(current, target);
  } catch (error) {
    try {
      restoreDurableActivation(snapshot);
    } catch (restoreError) {
      throw new Error(
        `durable payload activation failed and rollback also failed: ${String(error)}; rollback: ${String(restoreError)}`,
      );
    }
    throw error;
  }
  return snapshot;
}

export function restoreDurableActivation(snapshot: DurableActivation): void {
  restoreSymlink(join(runtimeRoot(), "current"), snapshot.currentTarget);
  restoreSymlink(join(runtimeRoot(), "previous"), snapshot.previousTarget);
}

export function smokeDurablePayload(
  payload: InstalledPayload,
  version: string,
  nodePath: string | null = resolveDurableNode(),
): { ok: boolean; note: string } {
  if (!nodePath) {
    return {
      ok: false,
      note:
        "SERVICE_ENTRY_MISSING: no durable Node 20+ runtime found (temporary, npx, nvm/asdf/mise, and Codex-owned runtimes are refused)",
    };
  }
  const smoke = spawnSync(nodePath, [payload.versionEntryPath, "--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return smoke.status === 0 && smoke.stdout.trim() === version
    ? { ok: true, note: `verified payload ${version}-${payload.sha256.slice(0, 12)}` }
    : {
        ok: false,
        note: "SERVICE_ENTRY_MISSING: durable runner bundle failed its version smoke test",
      };
}

export function activateStandaloneDurablePayload(
  payload: InstalledPayload,
  version: string,
): { ok: boolean; note: string } {
  try {
    const pending = readUpgradeTransition();
    if (pending) {
      return {
        ok: false,
        note: `UPGRADE_RECOVERY_REQUIRED: interrupted transition remains at ${pending.phase}`,
      };
    }
    const current = snapshotRuntimeLink(join(runtimeRoot(), "current"));
    const previous = snapshotRuntimeLink(join(runtimeRoot(), "previous"));
    const linkTarget = relative(runtimeRoot(), payload.versionDir);
    let transition = writeUpgradeTransition({
      schemaVersion: 1,
      phase: "prepared",
      createdAt: Date.now(),
      prior: {
        installed: false,
        loaded: false,
        disabled: false,
        current,
        previous,
        plist: fileSnapshot(null),
      },
      target: {
        installed: false,
        disabled: false,
        version,
        payloadSha256: payload.sha256,
        linkTarget,
        previous: current.target === linkTarget ? previous : current,
        plist: fileSnapshot(null),
      },
    });
    activateDurablePayload(payload);
    transition = advanceUpgradeTransition(transition, "payload_activated");
    verifyTransitionTarget(transition, false);
    clearUpgradeTransition();
    return {
      ok: true,
      note: `activated verified standalone payload ${version}-${payload.sha256.slice(0, 12)}`,
    };
  } catch (error) {
    return {
      ok: false,
      note: `UPGRADE_RECOVERY_REQUIRED: standalone activation was interrupted: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const uid = (): number => process.getuid?.() ?? 501;
const domainTarget = (): string => `gui/${uid()}`;
const serviceTarget = (): string => `${domainTarget()}/${SERVICE_LABEL}`;

function launchctl(...args: string[]): { status: number | null; out: string } {
  return runBoundedServiceCommand(LAUNCHCTL_PATH, args, LAUNCHCTL_TIMEOUT_MS);
}

function plutilLint(path: string): { status: number | null; out: string } {
  return runBoundedServiceCommand(PLUTIL_PATH, ["-lint", path], PLUTIL_TIMEOUT_MS);
}

export function runBoundedServiceCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  spawn: typeof spawnSync = spawnSync,
): { status: number | null; out: string } {
  const result = spawn(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const timeout = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    status: result.status,
    out: timeout
      ? `${executable} timed out after ${timeoutMs}ms`
      : `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error.message) : ""}`,
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

export function serviceDisabledState(): boolean | null {
  if (process.platform !== "darwin") return null;
  const result = launchctl("print-disabled", domainTarget());
  if (result.status !== 0) return null;
  const escaped = SERVICE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"?${escaped}"?\\s*=>\\s*(true|false)`, "i").exec(result.out);
  return match ? match[1]!.toLowerCase() === "true" : false;
}

/** Restore launchd enabled/disabled intent without starting the service. */
export function setServiceDisabled(disabled: boolean): { ok: boolean; note: string } {
  if (process.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  const result = launchctl(disabled ? "disable" : "enable", serviceTarget());
  return result.status === 0
    ? { ok: true, note: `${SERVICE_LABEL} ${disabled ? "disabled" : "enabled"}` }
    : { ok: false, note: `launchctl ${disabled ? "disable" : "enable"} failed: ${result.out.trim().slice(0, 300)}` };
}

export type ServiceTransitionBeginDeps = {
  stop: () => { status: number | null; out: string };
  onQuiesced: () => void;
  acquireBarrier: () => { release(): void };
  persist: (transition: UpgradeTransition) => UpgradeTransition;
};

/** Quiescing an untouched service is the pre-transition safety boundary. The
 * first durable journal write happens only after bootout and the execution
 * barrier are both verified, but before any runtime link or plist mutation. */
export function beginServiceTransitionAfterQuiesce(
  transition: UpgradeTransition,
  deps: ServiceTransitionBeginDeps,
): { transition: UpgradeTransition; barrier: { release(): void } } {
  const stopped = deps.stop();
  const tolerated = /could not find service|no such process/i.test(stopped.out);
  if (stopped.status !== 0 && !tolerated) {
    throw new Error(`launchctl maintenance stop failed: ${stopped.out.trim().slice(0, 300)}`);
  }
  deps.onQuiesced();
  const barrier = deps.acquireBarrier();
  try {
    return {
      transition: deps.persist(transition),
      barrier,
    };
  } catch (error) {
    barrier.release();
    throw error;
  }
}

export function installService(
  version = AGENT_VERSION,
  options: {
    maintenanceToken?: string;
    afterServiceStopped?: () => { release(): void };
    beforeRollbackServiceStart?: () => { release(): void };
    leaveStopped?: boolean;
    priorLoaded?: boolean;
    priorDisabled?: boolean;
    targetDisabled?: boolean;
  } = {},
): { ok: boolean; note: string } {
  if (process.platform !== "darwin") {
    return { ok: false, note: "native background service is macOS-only; use `engager-agent run`" };
  }
  if (
    !options.maintenanceToken ||
    !options.afterServiceStopped ||
    !options.beforeRollbackServiceStart
  ) {
    return {
      ok: false,
      note: "UPGRADE_BLOCKED: service installation requires the maintenance orchestrator and execution-lock handoff",
    };
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
  const smoke = smokeDurablePayload(payload, version, nodePath);
  if (!smoke.ok) return smoke;

  const logDir = join(agentHome(), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  mkdirSync(dirname(plistPath()), { recursive: true });
  const plistOptions = {
    nodePath,
    scriptPath: serviceEntryPath(),
    logPath: join(logDir, "service.log"),
    pathEnv: trustedServicePath(nodePath, config.enginePath),
  };
  const cleanPlist = renderPlist(plistOptions);
  const plist = renderPlist({
    ...plistOptions,
    ...(options.maintenanceToken && !options.leaveStopped
      ? { maintenanceToken: options.maintenanceToken }
      : {}),
  });
  const path = plistPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, plist, { mode: 0o600 });
  const lint = plutilLint(tmp);
  if (lint.status !== 0) {
    rmSync(tmp, { force: true });
    return { ok: false, note: `SERVICE_ENTRY_MISSING: invalid launchd plist: ${lint.out.trim()}` };
  }
  rmSync(tmp, { force: true });
  const storedPriorPlist = existsSync(path) ? readFileSync(path) : null;
  const priorPlist = storedPriorPlist
    ? plistWithoutMaintenanceToken(storedPriorPlist)
    : null;
  if (
    storedPriorPlist &&
    priorPlist &&
    !storedPriorPlist.equals(priorPlist)
  ) {
    // A host crash after rollback commit may leave the one-time handoff token
    // in the durable plist. Repair it before taking the exact prior snapshot.
    restorePlist(path, priorPlist);
  }
  let transition: UpgradeTransition;
  try {
    const pending = readUpgradeTransition();
    if (pending) {
      return {
        ok: false,
        note: `UPGRADE_RECOVERY_REQUIRED: interrupted ${pending.target.version} transition is at ${pending.phase}; reconcile it before service repair`,
      };
    }
    const current = snapshotRuntimeLink(join(runtimeRoot(), "current"));
    const previous = snapshotRuntimeLink(join(runtimeRoot(), "previous"));
    const linkTarget = relative(runtimeRoot(), payload.versionDir);
    const observedState = serviceState();
    const priorDisabled = options.priorDisabled ?? serviceDisabledState();
    if (priorDisabled == null) {
      throw new Error("launchd enabled/disabled intent could not be determined");
    }
    const priorLoaded = options.priorLoaded ?? observedState.loaded;
    const targetDisabled = options.targetDisabled ?? priorDisabled;
    const leaveStopped = options.leaveStopped ?? targetDisabled;
    if (leaveStopped !== targetDisabled) {
      throw new Error("service stop intent does not match target launchd disabled state");
    }
    transition = prepareUpgradeTransition({
      schemaVersion: 1,
      phase: "service_stopped",
      createdAt: Date.now(),
      prior: {
        installed: priorPlist != null,
        loaded: priorLoaded,
        disabled: priorDisabled,
        current,
        previous,
        plist: fileSnapshot(priorPlist),
      },
      target: {
        installed: true,
        disabled: targetDisabled,
        version,
        payloadSha256: payload.sha256,
        linkTarget,
        previous: current.target === linkTarget ? previous : current,
        plist: fileSnapshot(Buffer.from(cleanPlist)),
      },
    });
  } catch (error) {
    rmSync(tmp, { force: true });
    return {
      ok: false,
      note: `UPGRADE_RECOVERY_REQUIRED: could not prepare a safe service transition: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let transitionLock: { release(): void } | null = null;
  let serviceQuiesced = false;
  let transitionPersisted = false;
  try {
    const begun = beginServiceTransitionAfterQuiesce(transition, {
      stop: () => launchctl("bootout", serviceTarget()),
      onQuiesced: () => {
        serviceQuiesced = true;
      },
      acquireBarrier: options.afterServiceStopped,
      persist: writeUpgradeTransition,
    });
    transition = begun.transition;
    transitionLock = begun.barrier;
    transitionPersisted = true;
    activateDurablePayload(payload);
    transition = advanceUpgradeTransition(transition, "payload_activated");
    writeFileSync(tmp, transition.target.disabled ? cleanPlist : plist, {
      mode: 0o600,
    });
    const targetLint = plutilLint(tmp);
    if (targetLint.status !== 0) {
      throw new Error(`target service plist failed lint: ${targetLint.out.trim()}`);
    }
    commitVerifiedFileDurably(tmp, path, 0o600);
    transition = advanceUpgradeTransition(transition, "plist_installed");
    if (transition.target.disabled) {
      const disabled = launchctl("disable", serviceTarget());
      if (disabled.status !== 0) {
        throw new Error(`launchctl disable failed: ${disabled.out.trim().slice(0, 300)}`);
      }
      transitionLock?.release();
      transitionLock = null;
      verifyTransitionTarget(transition, false);
      clearUpgradeTransition();
      return {
        ok: true,
        note: `repaired stopped ${SERVICE_LABEL} with verified payload ${version}-${payload.sha256.slice(0, 12)}`,
      };
    }
    const launchedAt = Date.now();
    const enabled = launchctl("enable", serviceTarget());
    if (enabled.status !== 0) throw new Error(`launchctl enable failed: ${enabled.out.trim().slice(0, 300)}`);
    transitionLock?.release();
    transitionLock = null;
    const boot = launchctl("bootstrap", domainTarget(), path);
    if (boot.status !== 0) {
      const legacy = launchctl("load", "-w", path);
      if (legacy.status !== 0) {
        throw new Error(`launchctl failed: ${boot.out.trim().slice(0, 300)}`);
      }
    }
    transition = advanceUpgradeTransition(transition, "service_bootstrapped");
    const verification = waitForServiceLoad({
      notBefore: launchedAt,
      expectedVersion: version,
    });
    if (!verification.ok) {
      throw new Error(`launchd startup verification failed: ${verification.reason}`);
    }
    if (options.maintenanceToken) {
      // The verified process keeps its inherited one-time token until exit;
      // scrub it from the durable plist before releasing maintenance.
      writeFileSync(tmp, cleanPlist, { mode: 0o600 });
      const cleanLint = plutilLint(tmp);
      if (cleanLint.status !== 0) {
        throw new Error(`launchd maintenance-token scrub failed: ${cleanLint.out.trim()}`);
      }
      commitVerifiedFileDurably(tmp, path, 0o600);
    }
    verifyTransitionTarget(transition, true);
    clearUpgradeTransition();
    return {
      ok: true,
      note: `installed ${SERVICE_LABEL} from verified payload ${version}-${payload.sha256.slice(0, 12)}`,
    };
  } catch (error) {
    transitionLock?.release();
    transitionLock = null;
    if (!transitionPersisted) {
      const restart = serviceQuiesced
        ? restartUntouchedPriorService(
            transition,
            options.maintenanceToken,
            options.beforeRollbackServiceStart,
          )
        : {
            ok: false,
            note: "the service stop was not verified, so no restart was attempted",
          };
      return {
        ok: false,
        note:
          `SERVICE_ENTRY_MISSING: service install stopped before transition commit: ${error instanceof Error ? error.message : String(error)}; ` +
          restart.note,
      };
    }
    const recovery = reconcileServiceUpgradeTransition({
      maintenanceToken: options.maintenanceToken,
      acquireBarrier: options.beforeRollbackServiceStart,
    });
    return {
      ok: false,
      note:
        `SERVICE_ENTRY_MISSING: service install failed: ${error instanceof Error ? error.message : String(error)}; ` +
        (recovery.ok
          ? recovery.note
          : recovery.recovered
            ? `the prior runtime was durably restored but remains stopped: ${recovery.note}`
            : `durable recovery remains pending: ${recovery.note}`),
    };
  } finally {
    transitionLock?.release();
    rmSync(tmp, { force: true });
  }
}

function restartUntouchedPriorService(
  transition: UpgradeTransition,
  maintenanceToken: string,
  acquireBarrier: () => { release(): void },
): { ok: boolean; note: string } {
  if (!transition.prior.installed) {
    return {
      ok: true,
      note: "no prior service existed; the staged target was never activated and no files changed",
    };
  }
  if (transition.prior.disabled) {
    try {
      verifyTransitionPrior(transition, false, true);
      return {
        ok: true,
        note: "the exact prior disabled service remained stopped and unchanged",
      };
    } catch (error) {
      return {
        ok: false,
        note: `the prior disabled service could not be re-verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const priorPlist = fileSnapshotContents(transition.prior.plist);
  const path = plistPath();
  const tmp = `${path}.${process.pid}.pretransition-restart`;
  let barrier: { release(): void } | null = null;
  let bootstrapAttempted = false;
  try {
    if (!priorPlist || !transition.prior.current.target) {
      throw new Error("enabled prior service has no restorable plist or payload");
    }
    barrier = acquireBarrier();
    verifyTransitionPrior(transition, false, true);
    const smoke = smokeRecordedPayload(transition.prior.current);
    if (!smoke.ok) throw new Error(`prior payload smoke test failed: ${smoke.note}`);
    writeFileSync(
      tmp,
      plistWithMaintenanceToken(priorPlist, maintenanceToken),
      { mode: 0o600 },
    );
    const lint = plutilLint(tmp);
    if (lint.status !== 0) {
      throw new Error(`prior restart plist failed lint: ${lint.out.trim()}`);
    }
    commitVerifiedFileDurably(tmp, path, 0o600);
    const enabled = launchctl("enable", serviceTarget());
    if (enabled.status !== 0) {
      throw new Error(`prior service enable failed: ${enabled.out.trim().slice(0, 300)}`);
    }
    const startedAt = Date.now();
    barrier.release();
    barrier = null;
    bootstrapAttempted = true;
    const boot = launchctl("bootstrap", domainTarget(), path);
    if (boot.status !== 0) {
      throw new Error(`prior service bootstrap failed: ${boot.out.trim().slice(0, 300)}`);
    }
    const verification = waitForServiceLoad({ notBefore: startedAt });
    restorePlist(path, priorPlist);
    if (!verification.ok) {
      throw new Error(`prior service verification failed: ${verification.reason}`);
    }
    verifyTransitionPrior(transition, true, true);
    return {
      ok: true,
      note: "the untouched prior service was restarted and re-verified",
    };
  } catch (error) {
    if (bootstrapAttempted) launchctl("bootout", serviceTarget());
    let exactStopped = false;
    let cleanupBarrier: { release(): void } | null = null;
    try {
      cleanupBarrier = acquireBarrier();
      restorePlist(path, priorPlist);
      verifyTransitionPrior(transition, false, true);
      exactStopped = true;
    } catch {
      try {
        writeUpgradeTransition(transition);
      } catch {
        /* The caller reports the original restart failure; status remains fail-closed. */
      }
    } finally {
      cleanupBarrier?.release();
    }
    return {
      ok: false,
      note:
        `the untouched prior service could not be restarted: ${error instanceof Error ? error.message : String(error)}` +
        (exactStopped
          ? "; its exact files and intent remain safely stopped for `engager-agent start`"
          : "; exact cleanup could not be proven, so durable recovery is required"),
    };
  } finally {
    barrier?.release();
    rmSync(tmp, { force: true });
  }
}

export type ServiceTransitionRecoveryResult = {
  ok: boolean;
  recovered: boolean;
  note: string;
};

export type ServiceTransitionRuntimeDeps = {
  platform: NodeJS.Platform;
  launch: (...args: string[]) => { status: number | null; out: string };
  state: () => ServiceState;
  disabled: () => boolean | null;
  wait: typeof waitForServiceLoad;
  smoke: (snapshot: RuntimeLinkSnapshot) => { ok: boolean; note: string };
  restorePlist?: (path: string, contents: Buffer | null) => void;
  now: () => number;
};

const REAL_TRANSITION_RUNTIME: ServiceTransitionRuntimeDeps = {
  platform: process.platform,
  launch: launchctl,
  state: serviceState,
  disabled: serviceDisabledState,
  wait: waitForServiceLoad,
  smoke: smokeRecordedPayload,
  now: Date.now,
};

export function reconcileServiceUpgradeTransition(options: {
  maintenanceToken?: string;
  acquireBarrier?: () => { release(): void };
  runtime?: ServiceTransitionRuntimeDeps;
} = {}): ServiceTransitionRecoveryResult {
  const runtime = options.runtime ?? REAL_TRANSITION_RUNTIME;
  let transition: UpgradeTransition | null;
  try {
    transition = readUpgradeTransition();
  } catch (error) {
    return {
      ok: false,
      recovered: false,
      note: `upgrade transition journal is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!transition) {
    return { ok: true, recovered: false, note: "no interrupted service transition" };
  }
  const touchesService = transition.prior.installed || transition.target.installed;
  if (touchesService && runtime.platform !== "darwin") {
    return {
      ok: false,
      recovered: false,
      note: "an interrupted macOS service transition cannot be reconciled on this platform",
    };
  }
  if (!options.maintenanceToken || !options.acquireBarrier) {
    return {
      ok: false,
      recovered: false,
      note: "recovery requires an exclusive maintenance and execution-lock handoff",
    };
  }
  const path = plistPath();
  const tmp = `${path}.${process.pid}.recovery`;
  const restore = runtime.restorePlist ?? restorePlist;
  let barrier: { release(): void } | null = null;
  let rollbackCommitted = false;
  let priorBootstrapAttempted = false;
  try {
    verifyTransitionPayloadReferences(transition);
    if (touchesService) {
      const stopped = runtime.launch("bootout", serviceTarget());
      const tolerated = /could not find service|no such process/i.test(stopped.out);
      if (stopped.status !== 0 && !tolerated) {
        throw new Error(`launchctl recovery stop failed: ${stopped.out.trim().slice(0, 300)}`);
      }
    }
    barrier = options.acquireBarrier();

    restoreDurableActivation({
      currentTarget: transition.prior.current.target,
      previousTarget: transition.prior.previous.target,
    });
    const priorPlist = fileSnapshotContents(transition.prior.plist);
    restore(path, priorPlist);
    verifyTransitionPrior(transition, false, false, runtime);

    if (transition.prior.installed && !transition.prior.disabled) {
      if (!priorPlist || !transition.prior.current.target) {
        throw new Error("recorded loaded service has no restorable plist or current payload");
      }
      const smoke = runtime.smoke(transition.prior.current);
      if (!smoke.ok) throw new Error(`restored payload smoke test failed: ${smoke.note}`);
      const enabled = runtime.launch("enable", serviceTarget());
      if (enabled.status !== 0) {
        throw new Error(`launchctl recovery enable failed: ${enabled.out.trim().slice(0, 300)}`);
      }
      verifyTransitionPrior(transition, false, true, runtime);
      writeFileSync(
        tmp,
        plistWithMaintenanceToken(priorPlist, options.maintenanceToken),
        { mode: 0o600 },
      );
      const lint = plutilLint(tmp);
      if (lint.status !== 0) {
        throw new Error(`recovery plist failed lint: ${lint.out.trim()}`);
      }
      commitVerifiedFileDurably(tmp, path, 0o600);
      const startedAt = runtime.now();
      barrier.release();
      barrier = null;
      priorBootstrapAttempted = true;
      const boot = runtime.launch("bootstrap", domainTarget(), path);
      if (boot.status !== 0) {
        throw new Error(`launchctl recovery bootstrap failed: ${boot.out.trim().slice(0, 300)}`);
      }
      const verification = runtime.wait({ notBefore: startedAt });
      restore(path, priorPlist);
      if (!verification.ok) {
        throw new Error(`restored service verification failed: ${verification.reason}`);
      }
      verifyTransitionPrior(transition, true, true, runtime);
      // The journal is the only durable evidence that recorded running intent
      // still needs restoration. Keep it through bootstrap, readiness, clean
      // plist scrub, and final loaded/intent verification; a kill at any prior
      // boundary must re-enter deterministic recovery on the next command.
      clearUpgradeTransition();
      rollbackCommitted = true;
    } else {
      if (touchesService) {
        const intent = runtime.launch(
          transition.prior.disabled ? "disable" : "enable",
          serviceTarget(),
        );
        if (intent.status !== 0) {
          throw new Error(
            `launchctl recovery ${transition.prior.disabled ? "disable" : "enable"} failed: ${intent.out.trim().slice(0, 300)}`,
          );
        }
      }
      barrier.release();
      barrier = null;
      verifyTransitionPrior(transition, false, true, runtime);
      clearUpgradeTransition();
      rollbackCommitted = true;
    }
    return {
      ok: true,
      recovered: true,
      note: `restored the verified pre-upgrade ${!transition.prior.installed ? "absent" : transition.prior.disabled ? "stopped" : "running"} service intent from interrupted phase ${transition.phase}`,
    };
  } catch (error) {
    let cleanupNote = "";
    if (priorBootstrapAttempted) {
      const stopped = runtime.launch("bootout", serviceTarget());
      const stopTolerated =
        stopped.status === 0 ||
        /could not find service|no such process/i.test(stopped.out);
      if (!stopTolerated) {
          try {
            writeUpgradeTransition(transition);
            rollbackCommitted = false;
            cleanupNote = `; stopping the unverified prior service failed (${stopped.out.trim().slice(0, 200)}), so the transition fence remains durable`;
          } catch (fenceError) {
            rollbackCommitted = false;
            cleanupNote = `; CRITICAL: stopping the unverified prior service and preserving its transition fence both failed (${stopped.out.trim().slice(0, 160)}; ${fenceError instanceof Error ? fenceError.message : String(fenceError)})`;
          }
      } else {
        try {
          barrier = options.acquireBarrier();
          const clean = fileSnapshotContents(transition.prior.plist);
          restore(path, clean);
          verifyTransitionPrior(transition, false, true, runtime);
          barrier.release();
          barrier = null;
          rollbackCommitted = false;
          cleanupNote = "; the unverified prior service was stopped, its exact clean snapshot re-verified, and the transition fence remains durable";
        } catch (restoreError) {
          barrier?.release();
          barrier = null;
          try {
            writeUpgradeTransition(transition);
            rollbackCommitted = false;
            cleanupNote = `; the unverified prior service was stopped, but exact clean-snapshot verification failed and the transition fence was restored (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`;
          } catch (fenceError) {
            rollbackCommitted = false;
            cleanupNote = `; CRITICAL: the unverified prior service was stopped, but exact clean-snapshot verification and transition-fence restoration both failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}; ${fenceError instanceof Error ? fenceError.message : String(fenceError)})`;
          }
        }
      }
    }
    return {
      ok: false,
      recovered: rollbackCommitted,
      note:
        `${error instanceof Error ? error.message : String(error)}` +
        cleanupNote +
        (rollbackCommitted
          ? "; the exact prior activation and launchd intent remain committed with no unverified service running, so `engager-agent start` can retry safely"
          : ""),
    };
  } finally {
    barrier?.release();
    rmSync(tmp, { force: true });
  }
}

export type UninstallServiceDeps = {
  platform: NodeJS.Platform;
  launch: (...args: string[]) => { status: number | null; out: string };
  plist: () => string;
  exists: (path: string) => boolean;
  remove: (path: string) => void;
};

const REAL_UNINSTALL_DEPS: UninstallServiceDeps = {
  platform: process.platform,
  launch: launchctl,
  plist: plistPath,
  exists: pathExists,
  remove: removePathDurably,
};

/** Low-level launchd primitive. Production callers must hold lifecycle
 * maintenance through uninstallServiceWithMaintenance in upgrade.ts. */
export function uninstallService(
  deps: UninstallServiceDeps = REAL_UNINSTALL_DEPS,
): { ok: boolean; note: string } {
  if (deps.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  const stopped = deps.launch("bootout", serviceTarget());
  const tolerated = /could not find service|no such process/i.test(stopped.out);
  if (stopped.status !== 0 && !tolerated) {
    return { ok: false, note: `launchctl uninstall stop failed: ${stopped.out.trim().slice(0, 300)}` };
  }
  const disabled = deps.launch("disable", serviceTarget());
  if (disabled.status !== 0) {
    return { ok: false, note: `launchctl uninstall disable failed: ${disabled.out.trim().slice(0, 300)}` };
  }
  const path = deps.plist();
  if (deps.exists(path)) deps.remove(path);
  return { ok: true, note: `removed ${SERVICE_LABEL}; configuration and versioned runtime were preserved` };
}

/** Low-level launchd primitive; production callers use stopAgentWithMaintenance. */
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

/** Low-level launchd primitive; production callers use the tokened maintenance
 * wrapper below via startServiceWithMaintenance in upgrade.ts. */
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

/** Start launchd while the lifecycle maintenance lock remains held. The
 * service receives the one-time capability only through its bootstrap plist;
 * the durable plist is scrubbed before this function returns. */
export function startServiceWithMaintenanceToken(
  maintenanceToken: string,
  deps: StartServiceDeps = REAL_START_SERVICE_DEPS,
): { ok: boolean; note: string } {
  if (!maintenanceToken) {
    return { ok: false, note: "UPGRADE_BLOCKED: lifecycle start requires a maintenance handoff" };
  }
  if (deps.platform !== "darwin") return { ok: false, note: "native service is macOS-only" };
  const path = plistPath();
  if (!deps.exists(path) || !deps.exists(serviceEntryPath())) {
    return { ok: false, note: "SERVICE_ENTRY_MISSING: run `engager-agent service install --repair`" };
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.start-handoff`;
  let clean: Buffer;
  try {
    clean = plistWithoutMaintenanceToken(readFileSync(path));
    writeFileSync(tmp, plistWithMaintenanceToken(clean, maintenanceToken), {
      mode: 0o600,
      flag: "wx",
    });
    const lint = plutilLint(tmp);
    if (lint.status !== 0) {
      throw new Error(`launchd maintenance handoff plist failed lint: ${lint.out.trim()}`);
    }
    commitVerifiedFileDurably(tmp, path, 0o600);
  } catch (error) {
    rmSync(tmp, { force: true });
    return {
      ok: false,
      note: `UPGRADE_BLOCKED: could not install the one-time service handoff: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let result: { ok: boolean; note: string };
  try {
    result = startService(deps);
  } catch (error) {
    result = {
      ok: false,
      note: `launchd start failed during maintenance handoff: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    writeFileSync(tmp, clean, { mode: 0o600, flag: "wx" });
    const lint = plutilLint(tmp);
    if (lint.status !== 0) {
      throw new Error(`clean plist failed lint: ${lint.out.trim()}`);
    }
    commitVerifiedFileDurably(tmp, path, 0o600);
  } catch (error) {
    const stopped = deps.launch("bootout", serviceTarget());
    const stoppedSafely =
      stopped.status === 0 || /could not find service|no such process/i.test(stopped.out);
    return {
      ok: false,
      note:
        `UPGRADE_BLOCKED: service handoff token could not be scrubbed: ${error instanceof Error ? error.message : String(error)}; ` +
        (stoppedSafely
          ? "the service was stopped before maintenance release"
          : `WARNING: service stop failed: ${stopped.out.trim().slice(0, 200)}`),
    };
  } finally {
    rmSync(tmp, { force: true });
  }
  return result;
}

function atomicSymlink(path: string, target: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(target, tmp, "dir");
  renameSync(tmp, path);
  syncDirectoryDurably(dirname(path));
}

function restoreSymlink(path: string, target: string | null): void {
  if (target) atomicSymlink(path, target);
  else if (pathExists(path)) removePathDurably(path);
}

function restorePlist(path: string, contents: Buffer | null): void {
  if (!contents) {
    if (pathExists(path)) removePathDurably(path);
    return;
  }
  const tmp = `${path}.${process.pid}.rollback`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  commitVerifiedFileDurably(tmp, path, 0o600);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function ensureOwnedPrivateDirectory(path: string, label: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`SERVICE_ENTRY_MISSING: ${label} must be a real directory`);
    }
    if (!ownedByCurrentUser(stat.uid)) {
      throw new Error(`SERVICE_ENTRY_MISSING: ${label} is not owned by the current user`);
    }
    chmodSync(path, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  const verified = lstatSync(path);
  if (
    !verified.isDirectory() ||
    verified.isSymbolicLink() ||
    !ownedByCurrentUser(verified.uid) ||
    (verified.mode & 0o777) !== 0o700
  ) {
    throw new Error(`SERVICE_ENTRY_MISSING: ${label} failed private-directory verification`);
  }
}

export function shouldRestartPriorService(input: {
  leaveStopped: boolean;
  hadPriorPlist: boolean;
  hadPriorActivation: boolean;
  serviceStoppedForMaintenance: boolean;
}): boolean {
  return Boolean(
    !input.leaveStopped &&
      input.hadPriorPlist &&
      (input.hadPriorActivation || input.serviceStoppedForMaintenance),
  );
}

export function plistWithMaintenanceToken(contents: Buffer, token: string): string {
  const xml = contents.toString("utf8");
  if (xml.includes(`<key>${MAINTENANCE_TOKEN_ENV}</key>`)) {
    throw new Error("prior plist unexpectedly retained a maintenance token");
  }
  const marker = "  <key>EnvironmentVariables</key>\n  <dict>\n";
  if (!xml.includes(marker)) {
    throw new Error("prior plist has no recognized environment dictionary for safe token handoff");
  }
  return xml.replace(
    marker,
    `${marker}    <key>${MAINTENANCE_TOKEN_ENV}</key>\n    <string>${xmlEscape(token)}</string>\n`,
  );
}

export function plistWithoutMaintenanceToken(contents: Buffer): Buffer {
  const xml = contents.toString("utf8");
  const key = `<key>${MAINTENANCE_TOKEN_ENV}</key>`;
  if (!xml.includes(key)) return contents;
  const pattern = new RegExp(
    `^[\\t ]*<key>${MAINTENANCE_TOKEN_ENV}</key>\\r?\\n[\\t ]*<string>[^<]*</string>\\r?\\n`,
    "gm",
  );
  const matches = xml.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error("service plist contains an ambiguous maintenance-token entry");
  }
  return Buffer.from(xml.replace(pattern, ""));
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

function snapshotRuntimeLink(path: string): RuntimeLinkSnapshot {
  assertManagedRuntimeLink(path);
  const target = readSymlink(path);
  return target == null
    ? { target: null, payloadSha256: null }
    : { target, payloadSha256: payloadHashForTarget(target) };
}

function payloadHashForTarget(target: string): string {
  if (!isManagedRuntimeTarget(target)) {
    throw new Error(`runtime target ${target} is outside managed versions`);
  }
  const directory = join(runtimeRoot(), target);
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    !ownedByCurrentUser(stat.uid)
  ) {
    throw new Error(`runtime payload ${target} is not a private directory`);
  }
  const files = [
    { name: "cli.mjs", mode: 0o500 },
    { name: "engine-watchdog.mjs", mode: 0o500 },
    { name: "LICENSE", mode: 0o400 },
    { name: "THIRD_PARTY_NOTICES", mode: 0o400 },
    { name: "THIRD_PARTY_COMPONENTS.json", mode: 0o400 },
  ];
  if (
    JSON.stringify(readdirSync(directory).sort()) !==
    JSON.stringify(files.map((file) => file.name).sort())
  ) {
    throw new Error(`runtime payload ${target} file set is not exact`);
  }
  return payloadManifestDigest(
    files.map((file) => {
      const path = join(directory, file.name);
      const fileStat = lstatSync(path);
      if (
        !fileStat.isFile() ||
        (fileStat.mode & 0o777) !== file.mode ||
        !ownedByCurrentUser(fileStat.uid)
      ) {
        throw new Error(`runtime payload ${target}/${file.name} mode is unsafe`);
      }
      return { ...file, bytes: readFileSync(path) };
    }),
  );
}

function smokeRecordedPayload(
  snapshot: RuntimeLinkSnapshot,
): { ok: boolean; note: string } {
  if (snapshot.target == null || snapshot.payloadSha256 == null) {
    return { ok: false, note: "recorded prior payload is absent" };
  }
  const hash = payloadHashForTarget(snapshot.target);
  if (hash !== snapshot.payloadSha256) {
    return { ok: false, note: "recorded prior payload hash changed" };
  }
  const directoryName = basename(snapshot.target);
  const match = /^(.+)-[a-f0-9]{16}$/.exec(directoryName);
  if (!match?.[1]) {
    return { ok: false, note: "recorded prior payload version directory is malformed" };
  }
  const version = match[1];
  return smokeDurablePayload(
    {
      version,
      sha256: snapshot.payloadSha256,
      versionDir: join(runtimeRoot(), snapshot.target),
      versionEntryPath: join(runtimeRoot(), snapshot.target, "cli.mjs"),
    },
    version,
  );
}

function verifyLinkReference(snapshot: RuntimeLinkSnapshot): void {
  if (snapshot.target == null || snapshot.payloadSha256 == null) return;
  if (payloadHashForTarget(snapshot.target) !== snapshot.payloadSha256) {
    throw new Error(`runtime payload ${snapshot.target} no longer matches its recorded hash`);
  }
}

function verifyRuntimeLink(path: string, snapshot: RuntimeLinkSnapshot): void {
  assertManagedRuntimeLink(path);
  if (readSymlink(path) !== snapshot.target) {
    throw new Error(`${basename(path)} runtime link does not match the transition journal`);
  }
  verifyLinkReference(snapshot);
}

function verifyPlistSnapshot(snapshot: UpgradeTransition["prior"]["plist"]): void {
  const expected = fileSnapshotContents(snapshot);
  const path = plistPath();
  if (expected == null) {
    if (existsSync(path)) throw new Error("service plist exists but the transition recorded none");
    return;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    !ownedByCurrentUser(stat.uid)
  ) {
    throw new Error("service plist is not a private 0600 regular file");
  }
  const actual = readFileSync(path);
  if (sha256(actual) !== snapshot.sha256 || !actual.equals(expected)) {
    throw new Error("service plist does not match the transition journal");
  }
}

function verifyTransitionPayloadReferences(transition: UpgradeTransition): void {
  verifyLinkReference(transition.prior.current);
  verifyLinkReference(transition.prior.previous);
  verifyLinkReference(transition.target.previous);
  if (payloadHashForTarget(transition.target.linkTarget) !== transition.target.payloadSha256) {
    throw new Error("target runtime payload no longer matches the transition journal");
  }
  fileSnapshotContents(transition.prior.plist);
  fileSnapshotContents(transition.target.plist);
}

function verifyTransitionPrior(
  transition: UpgradeTransition,
  expectedLoaded: boolean,
  verifyIntent: boolean = true,
  runtime: Pick<ServiceTransitionRuntimeDeps, "state" | "disabled"> = REAL_TRANSITION_RUNTIME,
): void {
  verifyRuntimeLink(join(runtimeRoot(), "current"), transition.prior.current);
  verifyRuntimeLink(join(runtimeRoot(), "previous"), transition.prior.previous);
  verifyPlistSnapshot(transition.prior.plist);
  if (runtime.state().loaded !== expectedLoaded) {
    throw new Error(`restored service did not reach recorded ${expectedLoaded ? "loaded" : "stopped"} state`);
  }
  if (
    verifyIntent &&
    (transition.prior.installed || transition.target.installed) &&
    runtime.disabled() !== transition.prior.disabled
  ) {
    throw new Error("restored launchd enabled/disabled intent does not match the transition journal");
  }
}

function verifyTransitionTarget(
  transition: UpgradeTransition,
  expectedLoaded: boolean,
): void {
  verifyRuntimeLink(join(runtimeRoot(), "current"), {
    target: transition.target.linkTarget,
    payloadSha256: transition.target.payloadSha256,
  });
  verifyRuntimeLink(join(runtimeRoot(), "previous"), transition.target.previous);
  verifyPlistSnapshot(transition.target.plist);
  if (serviceState().loaded !== expectedLoaded) {
    throw new Error(`upgraded service did not reach ${expectedLoaded ? "loaded" : "stopped"} state`);
  }
  if (
    transition.target.installed &&
    serviceDisabledState() !== transition.target.disabled
  ) {
    throw new Error("upgraded launchd enabled/disabled intent does not match the transition journal");
  }
}

function assertManagedRuntimeLink(path: string): void {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new Error(`SERVICE_ENTRY_MISSING: refusing to replace non-symlink runtime path ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function verifyDurablePayload(
  target: string,
  expectedSha256: string,
  expectedFiles: Array<{ name: string; bytes: Buffer; mode: number }>,
): void {
  const targetStat = lstatSync(target);
  if (
    !targetStat.isDirectory() ||
    (targetStat.mode & 0o777) !== 0o700 ||
    !ownedByCurrentUser(targetStat.uid)
  ) {
    throw new Error("SERVICE_ENTRY_MISSING: durable runner payload directory is unsafe");
  }
  const expectedNames = expectedFiles.map((file) => file.name).sort();
  const actualNames = readdirSync(target).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("SERVICE_ENTRY_MISSING: durable runner payload file set is not exact");
  }
  const actualFiles = expectedFiles.map((file) => {
    const installed = join(target, file.name);
    const stat = lstatSync(installed);
    const bytes = readFileSync(installed);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== file.mode ||
      !ownedByCurrentUser(stat.uid) ||
      !bytes.equals(file.bytes)
    ) {
      throw new Error(`SERVICE_ENTRY_MISSING: payload file ${file.name} failed exact verification`);
    }
    return { name: file.name, bytes, mode: stat.mode & 0o777 };
  });
  if (payloadManifestDigest(actualFiles) !== expectedSha256) {
    throw new Error("SERVICE_ENTRY_MISSING: durable runner manifest failed SHA-256 verification");
  }
}

function payloadManifestDigest(
  files: Array<{ name: string; bytes: Buffer; mode: number }>,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.mode.toString(8));
    hash.update("\0");
    hash.update(createHash("sha256").update(file.bytes).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}
