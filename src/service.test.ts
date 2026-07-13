import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateDurablePayload,
  installDurablePayload,
  isVerifiedServiceStatus,
  isVolatileRuntimePath,
  renderPlist,
  restoreDurableActivation,
  runtimeRoot,
  serviceEntryPath,
  startService,
  stableBrewPath,
  trustedServicePath,
  serviceVerificationState,
  waitForServiceLoad,
  type StartServiceDeps,
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
    restoreDurableActivation(first);
    expect(existsSync(serviceEntryPath())).toBe(false);
  });
});
