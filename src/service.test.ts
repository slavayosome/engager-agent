import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateDurablePayload,
  installDurablePayload,
  isVerifiedServiceStatus,
  isVolatileRuntimePath,
  LAUNCHCTL_PATH,
  PLUTIL_PATH,
  plistWithoutMaintenanceToken,
  plistWithMaintenanceToken,
  renderPlist,
  runBoundedServiceCommand,
  restoreDurableActivation,
  runtimeRoot,
  serviceEntryPath,
  shouldRestartPriorService,
  startService,
  stableBrewPath,
  trustedServicePath,
  uninstallService,
  serviceVerificationState,
  waitForServiceLoad,
  type StartServiceDeps,
  type UninstallServiceDeps,
} from "./service.js";
import type { RunnerStatus } from "./status.js";

let priorHome: string | undefined;
let priorLaunch: string | undefined;
let home: string;
beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  priorLaunch = process.env.ENGAGER_LAUNCH_AGENTS_DIR;
  home = mkdtempSync(join(tmpdir(), "engager-service-test-"));
  process.env.ENGAGER_AGENT_HOME = home;
  process.env.ENGAGER_LAUNCH_AGENTS_DIR = join(home, "LaunchAgents");
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
  if (priorLaunch === undefined) delete process.env.ENGAGER_LAUNCH_AGENTS_DIR;
  else process.env.ENGAGER_LAUNCH_AGENTS_DIR = priorLaunch;
});

describe("durable service payload", () => {
  it("bounds launchctl/plutil subprocesses and surfaces timeout as failure", () => {
    expect(LAUNCHCTL_PATH).toBe("/bin/launchctl");
    expect(PLUTIL_PATH).toBe("/usr/bin/plutil");
    const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawn = vi.fn(() => ({
      status: null,
      signal: "SIGTERM",
      output: [],
      pid: 1,
      stdout: "",
      stderr: "",
      error: timedOut,
    })) as unknown as typeof import("node:child_process").spawnSync;
    expect(runBoundedServiceCommand("launchctl", ["print", "x"], 1234, spawn)).toEqual({
      status: null,
      out: "launchctl timed out after 1234ms",
    });
    expect(spawn).toHaveBeenCalledWith(
      "launchctl",
      ["print", "x"],
      expect.objectContaining({ timeout: 1234 }),
    );
  });

  it("uninstall bootouts, disables, and durably removes the plist in order", () => {
    const calls: string[] = [];
    const deps: UninstallServiceDeps = {
      platform: "darwin",
      launch: (command) => {
        calls.push(command);
        return { status: 0, out: "" };
      },
      plist: () => "/tmp/test.plist",
      exists: () => true,
      remove: () => calls.push("remove"),
    };
    expect(uninstallService(deps).ok).toBe(true);
    expect(calls).toEqual(["bootout", "disable", "remove"]);

    calls.length = 0;
    expect(
      uninstallService({
        ...deps,
        launch: (command) => {
          calls.push(command);
          return command === "disable"
            ? { status: 1, out: "timeout" }
            : { status: 0, out: "" };
        },
      }).ok,
    ).toBe(false);
    expect(calls).toEqual(["bootout", "disable"]);
  });

  it("accepts current durable negotiation plus engine readiness without waiting for cognition", () => {
    const status: RunnerStatus = {
      schemaVersion: 2,
      pid: process.pid,
      version: "0.9.0",
      runnerId: "runner-test",
      engine: "claude",
      protocol: "2.1",
      protocolVerifiedAt: 1_100,
      engineReadyAt: 1_100,
      startupVerifiedAt: 1_100,
      state: "preflight",
      startedAt: 1_000,
      updatedAt: 1_100,
      consecutiveFailures: 0,
      sessionsToday: 0,
      sessionDay: "2026-07-12",
    };
    const service = {
      supported: true,
      installed: true,
      entryExists: true,
      loaded: true,
      pid: process.pid,
    };
    expect(
      isVerifiedServiceStatus(service, status, {
        notBefore: 900,
        expectedVersion: "0.9.0",
      }),
    ).toBe(true);
    expect(
      isVerifiedServiceStatus(service, { ...status, startupVerifiedAt: undefined }, { notBefore: 900 }),
    ).toBe(false);
    expect(
      isVerifiedServiceStatus(
        service,
        {
          ...status,
          engineReadyAt: undefined,
          quotaState: {
            status: "unavailable",
            reasonCode: "engine_auth_required",
          },
        },
        { notBefore: 900 },
      ),
    ).toBe(false);
    expect(isVerifiedServiceStatus(service, status, { notBefore: 1_101 })).toBe(false);
    expect(
      isVerifiedServiceStatus(service, status, {
        notBefore: 900,
        expectedVersion: "0.9.1",
      }),
    ).toBe(false);
  });

  it("boots out a service that fails its startup milestone", () => {
    const calls: string[][] = [];
    const deps: StartServiceDeps = {
      platform: "darwin",
      exists: () => true,
      now: () => 10_000,
      launch: (...args) => {
        calls.push(args);
        return { status: 0, out: "" };
      },
      wait: () => ({
        ok: false,
        reason: "the configured engine is not authenticated (engine_auth_required)",
      }),
    };
    const result = startService(deps);
    expect(result.ok).toBe(false);
    expect(result.note).toContain("engine_auth_required");
    expect(result.note).toContain("unverified service was stopped");
    expect(calls.some(([command]) => command === "bootout")).toBe(true);
  });

  it("fails service verification immediately with the current process engine-readiness reason", () => {
    const terminalStatus: RunnerStatus = {
      schemaVersion: 2,
      pid: process.pid,
      version: "0.9.0",
      runnerId: "runner-test",
      engine: "claude",
      protocol: "2.1",
      protocolVerifiedAt: 1_100,
      state: "preflight",
      stateReason: "current server negotiation verified; engine is not ready",
      startedAt: 1_000,
      updatedAt: 1_100,
      consecutiveFailures: 0,
      sessionsToday: 0,
      sessionDay: "2026-07-12",
      quotaState: {
        status: "unavailable",
        reasonCode: "engine_auth_required",
        observedAt: 1_100,
      },
    };
    const currentService = {
      supported: true,
      installed: true,
      entryExists: true,
      loaded: true,
      pid: process.pid,
    };
    let pauses = 0;
    const result = waitForServiceLoad(
      { notBefore: 900, expectedVersion: "0.9.0" },
      45_000,
      {
        now: () => 1_100,
        service: () => currentService,
        status: () => terminalStatus,
        pause: () => {
          pauses += 1;
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("engine_auth_required"),
    });
    expect(pauses).toBe(0);
    expect(
      serviceVerificationState(
        currentService,
        { ...terminalStatus, pid: process.pid + 100_000 },
        { notBefore: 900, expectedVersion: "0.9.0" },
      ),
    ).toEqual({ state: "pending" });
  });

  it("renders a versioned run command with a restrictive umask", () => {
    const plist = renderPlist({
      nodePath: "/opt/homebrew/bin/node",
      scriptPath: "/Users/test/.engager/runtime/current/cli.mjs",
      logPath: "/Users/test/.engager/logs/service.log",
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--service</string>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).not.toMatch(/_npx|\.hermes|Bearer|apiKey/i);
    const tokenedRollback = plistWithMaintenanceToken(
      Buffer.from(plist),
      "maintenance-token-123",
    );
    expect(tokenedRollback).toContain("ENGAGER_AGENT_MAINTENANCE_TOKEN");
    expect(tokenedRollback).toContain("maintenance-token-123");
    expect(plist).not.toContain("maintenance-token-123");
    expect(
      plistWithoutMaintenanceToken(Buffer.from(tokenedRollback)).toString(),
    ).toBe(plist);
    expect(() =>
      plistWithoutMaintenanceToken(
        Buffer.from(tokenedRollback.replace("</dict>", `${tokenedRollback}</dict>`)),
      ),
    ).toThrow(/ambiguous maintenance-token/i);
  });

  it("preserves a previously stopped service across rollback", () => {
    expect(
      shouldRestartPriorService({
        leaveStopped: true,
        hadPriorPlist: true,
        hadPriorActivation: true,
        serviceStoppedForMaintenance: false,
      }),
    ).toBe(false);
    expect(
      shouldRestartPriorService({
        leaveStopped: false,
        hadPriorPlist: true,
        hadPriorActivation: true,
        serviceStoppedForMaintenance: true,
      }),
    ).toBe(true);
  });

  it("refuses transient package-manager, Codex-owned, cache, and version-manager runtimes", () => {
    for (const path of [
      "/Users/a/.npm/_npx/123/node",
      "/Users/a/.hermes/node/bin/node",
      "/private/tmp/node",
      "/Users/a/Library/Caches/node",
      "/Users/a/.nvm/versions/node/v22/bin/node",
      "/Users/a/.asdf/installs/nodejs/22/bin/node",
      "/Users/a/.local/share/mise/installs/node/22/bin/node",
    ]) {
      expect(isVolatileRuntimePath(path), path).toBe(true);
    }
    expect(isVolatileRuntimePath("/opt/homebrew/bin/node")).toBe(false);
  });

  it("normalizes Homebrew Cellar entries to the stable opt path", () => {
    expect(stableBrewPath("/opt/homebrew/Cellar/node/22.1.0/bin/node")).toBe(
      "/opt/homebrew/opt/node/bin/node",
    );
  });

  it("persists only pinned executable directories and trusted system PATH entries", () => {
    const path = trustedServicePath(
      "/opt/homebrew/bin/node",
      "/Applications/Claude.app/Contents/MacOS/claude",
    );
    expect(path.split(":")).toEqual([
      "/opt/homebrew/bin",
      "/Applications/Claude.app/Contents/MacOS",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
    expect(path).not.toMatch(/\.local|_npx|\.hermes|Caches/);
  });

  it("stages, hashes, permissions, atomically activates, and rolls back a standalone bundle", () => {
    const source = join(home, "source.mjs");
    writeFileSync(source, '#!/usr/bin/env node\nconsole.log("0.9.0")\n');
    writeFileSync(join(home, "engine-watchdog.mjs"), "process.exit(0);\n");
    writeFileSync(join(home, "LICENSE"), "test license\n");
    writeFileSync(join(home, "THIRD_PARTY_NOTICES"), "test third-party notices\n");
    writeFileSync(join(home, "THIRD_PARTY_COMPONENTS.json"), '{"components":[]}\n');
    const installed = installDurablePayload("0.9.0", source);
    expect(existsSync(installed.versionEntryPath)).toBe(true);
    expect(existsSync(serviceEntryPath())).toBe(false);
    const first = activateDurablePayload(installed);
    expect(first.currentTarget).toBeNull();
    expect(existsSync(serviceEntryPath())).toBe(true);
    expect(lstatSync(join(runtimeRoot(), "current")).isSymbolicLink()).toBe(true);
    expect(statSync(serviceEntryPath()).mode & 0o777).toBe(0o500);
    expect(statSync(join(installed.versionDir, "engine-watchdog.mjs")).mode & 0o777).toBe(0o500);
    expect(readFileSync(serviceEntryPath(), "utf8")).toContain('console.log("0.9.0")');
    expect(readFileSync(join(installed.versionDir, "THIRD_PARTY_NOTICES"), "utf8")).toContain(
      "third-party",
    );
    expect(installDurablePayload("0.9.0", source)).toEqual(installed);
    const repeated = activateDurablePayload(installed);
    expect(repeated.currentTarget).toContain("versions/0.9.0-");
    expect(repeated.previousTarget).toBeNull();
    expect(readFileSync(serviceEntryPath(), "utf8")).toContain('console.log("0.9.0")');
    restoreDurableActivation(first);
    expect(existsSync(serviceEntryPath())).toBe(false);
  });

  it("rejects changed modes and extra files in an existing versioned payload", () => {
    const source = join(home, "strict-source.mjs");
    writeFileSync(source, '#!/usr/bin/env node\nconsole.log("0.9.0")\n');
    writeFileSync(join(home, "engine-watchdog.mjs"), "process.exit(0);\n");
    writeFileSync(join(home, "LICENSE"), "test license\n");
    writeFileSync(join(home, "THIRD_PARTY_NOTICES"), "test notices\n");
    writeFileSync(join(home, "THIRD_PARTY_COMPONENTS.json"), '{"components":[]}\n');
    const installed = installDurablePayload("0.9.0", source);

    chmodSync(join(installed.versionDir, "LICENSE"), 0o600);
    expect(() => installDurablePayload("0.9.0", source)).toThrow(/exact verification/);
    chmodSync(join(installed.versionDir, "LICENSE"), 0o400);
    writeFileSync(join(installed.versionDir, "unexpected.txt"), "extra\n");
    expect(() => installDurablePayload("0.9.0", source)).toThrow(/file set is not exact/);
  });

  it("rejects symlinked runtime and versions roots before staging payload bytes", () => {
    const source = join(home, "symlink-source.mjs");
    writeFileSync(source, '#!/usr/bin/env node\nconsole.log("0.9.0")\n');
    writeFileSync(join(home, "engine-watchdog.mjs"), "process.exit(0);\n");
    writeFileSync(join(home, "LICENSE"), "test license\n");
    writeFileSync(join(home, "THIRD_PARTY_NOTICES"), "test notices\n");
    writeFileSync(join(home, "THIRD_PARTY_COMPONENTS.json"), '{"components":[]}\n');

    const externalRuntime = mkdtempSync(join(tmpdir(), "engager-external-runtime-"));
    symlinkSync(externalRuntime, runtimeRoot(), "dir");
    expect(() => installDurablePayload("0.9.0", source)).toThrow(/runtime root must be a real directory/);
    expect(existsSync(join(externalRuntime, "versions"))).toBe(false);

    process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-service-versions-test-"));
    const runtime = runtimeRoot();
    mkdirSync(runtime, { mode: 0o700 });
    const externalVersions = mkdtempSync(join(tmpdir(), "engager-external-versions-"));
    symlinkSync(externalVersions, join(runtime, "versions"), "dir");
    expect(() => installDurablePayload("0.9.0", source)).toThrow(
      /runtime versions root must be a real directory/,
    );
    expect(readdirSync(externalVersions)).toEqual([]);
  });

  it("requires owned private real runtime directories before staging", () => {
    const source = join(home, "private-root-source.mjs");
    writeFileSync(source, '#!/usr/bin/env node\nconsole.log("0.9.0")\n');
    writeFileSync(join(home, "engine-watchdog.mjs"), "process.exit(0);\n");
    writeFileSync(join(home, "LICENSE"), "test license\n");
    writeFileSync(join(home, "THIRD_PARTY_NOTICES"), "test notices\n");
    writeFileSync(join(home, "THIRD_PARTY_COMPONENTS.json"), '{"components":[]}\n');
    mkdirSync(runtimeRoot(), { mode: 0o777 });

    installDurablePayload("0.9.0", source);
    expect(lstatSync(runtimeRoot()).isSymbolicLink()).toBe(false);
    expect(lstatSync(runtimeRoot()).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(runtimeRoot(), "versions")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(runtimeRoot(), "versions")).mode & 0o777).toBe(0o700);
  });
});
