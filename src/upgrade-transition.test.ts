import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireMaintenanceLock } from "./lock.js";
import {
  activateDurablePayload,
  beginServiceTransitionAfterQuiesce,
  installDurablePayload,
  plistPath,
  reconcileServiceUpgradeTransition,
  renderPlist,
  runtimeRoot,
  startService,
  type InstalledPayload,
  type ServiceTransitionRuntimeDeps,
} from "./service.js";
import {
  clearUpgradeTransition,
  fileSnapshot,
  hasUpgradeTransition,
  prepareUpgradeTransition,
  readUpgradeTransition,
  upgradeTransitionPath,
  writeUpgradeTransition,
  type UpgradeTransitionPhase,
} from "./upgrade-transition.js";

let priorHome: string | undefined;
let priorLaunch: string | undefined;
let home: string;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  priorLaunch = process.env.ENGAGER_LAUNCH_AGENTS_DIR;
  home = mkdtempSync(join(tmpdir(), "engager-transition-test-"));
  process.env.ENGAGER_AGENT_HOME = home;
  process.env.ENGAGER_LAUNCH_AGENTS_DIR = join(home, "LaunchAgents");
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
  if (priorLaunch === undefined) delete process.env.ENGAGER_LAUNCH_AGENTS_DIR;
  else process.env.ENGAGER_LAUNCH_AGENTS_DIR = priorLaunch;
});

function payload(version: string, marker: string): InstalledPayload {
  const source = join(home, `${marker}.mjs`);
  writeFileSync(source, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`);
  writeFileSync(join(home, "engine-watchdog.mjs"), `// ${marker}\nprocess.exit(0);\n`);
  writeFileSync(join(home, "LICENSE"), `license ${marker}\n`);
  writeFileSync(join(home, "THIRD_PARTY_NOTICES"), `notices ${marker}\n`);
  writeFileSync(join(home, "THIRD_PARTY_COMPONENTS.json"), `{"marker":"${marker}"}\n`);
  return installDurablePayload(version, source);
}

function linkTarget(installed: InstalledPayload): string {
  return relative(runtimeRoot(), installed.versionDir);
}

const CRASH_PHASES: UpgradeTransitionPhase[] = [
  "prepared",
  "service_stopped",
  "payload_activated",
  "plist_installed",
  "service_bootstrapped",
];

describe("durable upgrade transition", () => {
  it("leaves exact prior files and zero transition authority at the kill boundary immediately after quiesce", () => {
    const prior = payload("0.9.0", "quiesced-prior");
    activateDurablePayload(prior);
    const candidate = payload("0.9.1", "quiesced-candidate");
    const priorTarget = linkTarget(prior);
    const priorPlist = Buffer.from(renderPlist({
      nodePath: "/opt/homebrew/bin/node",
      scriptPath: join(runtimeRoot(), "current", "cli.mjs"),
      logPath: join(home, "service.log"),
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    }));
    mkdirSync(join(home, "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), priorPlist, { mode: 0o600 });

    // Target staging/smoke may already be complete, but bootout is the final
    // pre-journal action. A kill here has not changed either active pointer or
    // plist and carries no ambiguous transition authority.
    expect(existsSync(candidate.versionEntryPath)).toBe(true);
    expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
    expect(readFileSync(plistPath()).equals(priorPlist)).toBe(true);
    expect(hasUpgradeTransition()).toBe(false);

    const persist = vi.fn(writeUpgradeTransition);
    const transition = prepareUpgradeTransition({
      schemaVersion: 1,
      phase: "service_stopped",
      createdAt: 1,
      prior: {
        installed: true,
        loaded: true,
        disabled: false,
        current: { target: priorTarget, payloadSha256: prior.sha256 },
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(priorPlist),
      },
      target: {
        installed: true,
        disabled: false,
        version: candidate.version,
        payloadSha256: candidate.sha256,
        linkTarget: linkTarget(candidate),
        previous: { target: priorTarget, payloadSha256: prior.sha256 },
        plist: fileSnapshot(priorPlist),
      },
    });
    expect(() =>
      beginServiceTransitionAfterQuiesce(transition, {
        stop: () => ({ status: 0, out: "" }),
        onQuiesced: vi.fn(),
        acquireBarrier: () => {
          expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
          expect(readFileSync(plistPath()).equals(priorPlist)).toBe(true);
          expect(hasUpgradeTransition()).toBe(false);
          throw new Error("simulated kill immediately after quiesce");
        },
        persist,
      }),
    ).toThrow("simulated kill immediately after quiesce");
    expect(persist).not.toHaveBeenCalled();
    expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
    expect(readFileSync(plistPath()).equals(priorPlist)).toBe(true);
    expect(hasUpgradeTransition()).toBe(false);

    const launches: string[] = [];
    expect(
      startService({
        platform: "darwin",
        exists: existsSync,
        now: () => 10_000,
        launch: (command) => {
          launches.push(command);
          return { status: 0, out: "" };
        },
        wait: () => ({ ok: true }),
      }),
    ).toMatchObject({ ok: true });
    expect(launches).toEqual(["enable", "bootstrap"]);
    expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
  });

  it("writes a strict private journal and rejects unsafe managed-link targets", () => {
    const installed = payload("0.9.0", "prior");
    const target = linkTarget(installed);
    writeUpgradeTransition({
      schemaVersion: 1,
      phase: "prepared",
      createdAt: 1,
      prior: {
        installed: false,
        loaded: false,
        disabled: false,
        current: { target: null, payloadSha256: null },
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(null),
      },
      target: {
        installed: false,
        disabled: false,
        version: installed.version,
        payloadSha256: installed.sha256,
        linkTarget: target,
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(null),
      },
    });
    expect(lstatSync(upgradeTransitionPath()).mode & 0o777).toBe(0o600);
    expect(readUpgradeTransition()?.target.linkTarget).toBe(target);
    expect(() =>
      writeUpgradeTransition({
        ...readUpgradeTransition()!,
        target: { ...readUpgradeTransition()!.target, linkTarget: "../escape" },
      }),
    ).toThrow(/outside managed versions|Invalid input/);
    clearUpgradeTransition();
    symlinkSync(join(home, "missing-transition"), upgradeTransitionPath());
    expect(hasUpgradeTransition()).toBe(true);
    expect(() => readUpgradeTransition()).toThrow();
  });

  it.each(CRASH_PHASES)(
    "rolls back an interrupted standalone activation from %s and is idempotent",
    (phase) => {
      const prior = payload("0.9.0", "prior");
      activateDurablePayload(prior);
      const candidate = payload("0.9.1", "candidate");
      const priorTarget = linkTarget(prior);
      const candidateTarget = linkTarget(candidate);
      if (["payload_activated", "plist_installed", "service_bootstrapped"].includes(phase)) {
        activateDurablePayload(candidate);
      }
      writeUpgradeTransition({
        schemaVersion: 1,
        phase,
        createdAt: 1,
        prior: {
          installed: false,
          loaded: false,
          disabled: false,
          current: { target: priorTarget, payloadSha256: prior.sha256 },
          previous: { target: null, payloadSha256: null },
          plist: fileSnapshot(null),
        },
        target: {
          installed: false,
          disabled: false,
          version: candidate.version,
          payloadSha256: candidate.sha256,
          linkTarget: candidateTarget,
          previous: { target: priorTarget, payloadSha256: prior.sha256 },
          plist: fileSnapshot(null),
        },
      });
      const release = vi.fn();
      const result = reconcileServiceUpgradeTransition({
        maintenanceToken: "maintenance-token",
        acquireBarrier: () => ({ release }),
      });
      expect(result).toMatchObject({ ok: true, recovered: true });
      expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
      expect(hasUpgradeTransition()).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(
        reconcileServiceUpgradeTransition({
          maintenanceToken: "maintenance-token",
          acquireBarrier: () => ({ release }),
        }),
      ).toMatchObject({ ok: true, recovered: false });
    },
  );

  it.each(CRASH_PHASES)(
    "restores a legacy prior service without relying on handoff support from a crash at %s",
    (phase) => {
      const prior = payload("0.9.0", "prior");
      activateDurablePayload(prior);
      const candidate = payload("0.9.1", "candidate");
      const priorTarget = linkTarget(prior);
      const candidateTarget = linkTarget(candidate);
      const priorPlist = Buffer.from(renderPlist({
        nodePath: "/opt/homebrew/bin/node",
        scriptPath: join(runtimeRoot(), "current", "cli.mjs"),
        logPath: join(home, "service.log"),
        pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
      }));
      const candidatePlist = Buffer.from(priorPlist.toString().replace("service.log", "candidate.log"));
      mkdirSync(join(home, "LaunchAgents"), { recursive: true });
      writeFileSync(plistPath(), phase === "plist_installed" || phase === "service_bootstrapped" ? candidatePlist : priorPlist);
      chmodSync(plistPath(), 0o600);
      if (["payload_activated", "plist_installed", "service_bootstrapped"].includes(phase)) {
        activateDurablePayload(candidate);
      }
      writeUpgradeTransition({
        schemaVersion: 1,
        phase,
        createdAt: 1,
        prior: {
          installed: true,
          loaded: true,
          disabled: false,
          current: { target: priorTarget, payloadSha256: prior.sha256 },
          previous: { target: null, payloadSha256: null },
          plist: fileSnapshot(priorPlist),
        },
        target: {
          installed: true,
          disabled: false,
          version: candidate.version,
          payloadSha256: candidate.sha256,
          linkTarget: candidateTarget,
          previous: { target: priorTarget, payloadSha256: prior.sha256 },
          plist: fileSnapshot(candidatePlist),
        },
      });

      let loaded = phase === "service_bootstrapped";
      let disabled = false;
      const calls: string[] = [];
      const identity = {
        identity: (pid: number) => (pid === process.pid ? "test-process" : null),
        alive: (pid: number) => pid === process.pid,
      };
      const maintenance = acquireMaintenanceLock("recovery", identity);
      const runtime: ServiceTransitionRuntimeDeps = {
        platform: "darwin",
        launch: (command) => {
          calls.push(command);
          if (command === "bootout") loaded = false;
          if (command === "bootstrap") {
            // Kill boundary: running intent is not yet restored, so the
            // durable recovery fence must still be present.
            expect(hasUpgradeTransition()).toBe(true);
            expect(readFileSync(plistPath(), "utf8")).toContain(
              "ENGAGER_AGENT_MAINTENANCE_TOKEN",
            );
            loaded = true;
          }
          if (command === "enable") disabled = false;
          if (command === "disable") disabled = true;
          return { status: 0, out: "" };
        },
        state: () => ({
          supported: true,
          installed: existsSync(plistPath()),
          entryExists: true,
          loaded,
          ...(loaded ? { pid: process.pid } : {}),
        }),
        disabled: () => disabled,
        wait: () => {
          expect(() =>
            acquireMaintenanceLock("concurrent-upgrade", identity),
          ).toThrow(/already (?:owns|active)/i);
          return { ok: true };
        },
        smoke: () => ({ ok: true, note: "legacy prior payload smoke passed" }),
        now: () => 10_000,
      };
      const release = vi.fn();
      let result: ReturnType<typeof reconcileServiceUpgradeTransition>;
      try {
        result = reconcileServiceUpgradeTransition({
          maintenanceToken: maintenance.owner.token,
          acquireBarrier: () => ({ release }),
          runtime,
        });
      } finally {
        maintenance.release();
      }

      expect(result).toMatchObject({ ok: true, recovered: true });
      expect(readlinkSync(join(runtimeRoot(), "current"))).toBe(priorTarget);
      expect(readFileSync(plistPath()).equals(priorPlist)).toBe(true);
      expect(loaded).toBe(true);
      expect(disabled).toBe(false);
      expect(calls).toContain("bootstrap");
      expect(hasUpgradeTransition()).toBe(false);
      expect(readFileSync(plistPath(), "utf8")).not.toContain(
        "ENGAGER_AGENT_MAINTENANCE_TOKEN",
      );
    },
  );

  it("keeps the journal and service stopped when exact recovery cannot be proven", () => {
    const prior = payload("0.9.0", "prior");
    activateDurablePayload(prior);
    const candidate = payload("0.9.1", "candidate");
    writeUpgradeTransition({
      schemaVersion: 1,
      phase: "payload_activated",
      createdAt: 1,
      prior: {
        installed: false,
        loaded: false,
        disabled: false,
        current: { target: linkTarget(prior), payloadSha256: "0".repeat(64) },
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(null),
      },
      target: {
        installed: false,
        disabled: false,
        version: candidate.version,
        payloadSha256: candidate.sha256,
        linkTarget: linkTarget(candidate),
        previous: { target: linkTarget(prior), payloadSha256: prior.sha256 },
        plist: fileSnapshot(null),
      },
    });
    const result = reconcileServiceUpgradeTransition({
      maintenanceToken: "maintenance-token",
      acquireBarrier: () => ({ release: vi.fn() }),
    });
    expect(result.ok).toBe(false);
    expect(hasUpgradeTransition()).toBe(true);
    clearUpgradeTransition();
  });

  it("restores intentionally disabled service intent without enabling or bootstrapping", () => {
    const prior = payload("0.9.0", "prior");
    activateDurablePayload(prior);
    const candidate = payload("0.9.1", "candidate");
    activateDurablePayload(candidate);
    const priorPlist = Buffer.from(renderPlist({
      nodePath: "/opt/homebrew/bin/node",
      scriptPath: join(runtimeRoot(), "current", "cli.mjs"),
      logPath: join(home, "service.log"),
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    }));
    mkdirSync(join(home, "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), priorPlist, { mode: 0o600 });
    writeUpgradeTransition({
      schemaVersion: 1,
      phase: "payload_activated",
      createdAt: 1,
      prior: {
        installed: true,
        loaded: false,
        disabled: true,
        current: { target: linkTarget(prior), payloadSha256: prior.sha256 },
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(priorPlist),
      },
      target: {
        installed: true,
        disabled: true,
        version: candidate.version,
        payloadSha256: candidate.sha256,
        linkTarget: linkTarget(candidate),
        previous: { target: linkTarget(prior), payloadSha256: prior.sha256 },
        plist: fileSnapshot(priorPlist),
      },
    });
    let disabled = true;
    const calls: string[] = [];
    const result = reconcileServiceUpgradeTransition({
      maintenanceToken: "maintenance-token",
      acquireBarrier: () => ({ release: vi.fn() }),
      runtime: {
        platform: "darwin",
        launch: (command) => {
          calls.push(command);
          if (command === "disable") disabled = true;
          return { status: 0, out: "" };
        },
        state: () => ({
          supported: true,
          installed: true,
          entryExists: true,
          loaded: false,
        }),
        disabled: () => disabled,
        wait: () => {
          throw new Error("disabled recovery must not wait for service startup");
        },
        smoke: () => {
          throw new Error("disabled recovery must not start the prior payload");
        },
        now: () => 10_000,
      },
    });
    expect(result).toMatchObject({ ok: true, recovered: true });
    expect(calls).toContain("disable");
    expect(calls).not.toContain("enable");
    expect(calls).not.toContain("bootstrap");
  });

  it("restores a pre-install disabled override when a fresh service install crashes", () => {
    const candidate = payload("0.9.1", "fresh-install-candidate");
    activateDurablePayload(candidate);
    const candidatePlist = Buffer.from(renderPlist({
      nodePath: "/opt/homebrew/bin/node",
      scriptPath: join(runtimeRoot(), "current", "cli.mjs"),
      logPath: join(home, "candidate.log"),
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    }));
    mkdirSync(join(home, "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), candidatePlist, { mode: 0o600 });
    writeUpgradeTransition({
      schemaVersion: 1,
      phase: "plist_installed",
      createdAt: 1,
      prior: {
        installed: false,
        loaded: false,
        disabled: true,
        current: { target: null, payloadSha256: null },
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(null),
      },
      target: {
        installed: true,
        disabled: false,
        version: candidate.version,
        payloadSha256: candidate.sha256,
        linkTarget: linkTarget(candidate),
        previous: { target: null, payloadSha256: null },
        plist: fileSnapshot(candidatePlist),
      },
    });
    let disabled = false;
    const calls: string[] = [];
    const result = reconcileServiceUpgradeTransition({
      maintenanceToken: "maintenance-token",
      acquireBarrier: () => ({ release: vi.fn() }),
      runtime: {
        platform: "darwin",
        launch: (command) => {
          calls.push(command);
          if (command === "disable") disabled = true;
          return { status: 0, out: "" };
        },
        state: () => ({
          supported: true,
          installed: existsSync(plistPath()),
          entryExists: existsSync(join(runtimeRoot(), "current", "cli.mjs")),
          loaded: false,
        }),
        disabled: () => disabled,
        wait: () => {
          throw new Error("absent prior service must not start");
        },
        smoke: () => {
          throw new Error("absent prior payload must not smoke");
        },
        now: () => 10_000,
      },
    });

    expect(result).toMatchObject({ ok: true, recovered: true });
    expect(calls).toEqual(["bootout", "disable"]);
    expect(existsSync(plistPath())).toBe(false);
    expect(existsSync(join(runtimeRoot(), "current"))).toBe(false);
    expect(disabled).toBe(true);
  });

  it.each(["wait throws", "plist scrub fails", "final verification fails"] as const)(
    "stops the bootstrapped prior service and retains recovery when %s",
    (failure) => {
      const prior = payload("0.9.0", `prior-${failure}`);
      activateDurablePayload(prior);
      const candidate = payload("0.9.1", `candidate-${failure}`);
      activateDurablePayload(candidate);
      const priorPlist = Buffer.from(renderPlist({
        nodePath: "/opt/homebrew/bin/node",
        scriptPath: join(runtimeRoot(), "current", "cli.mjs"),
        logPath: join(home, "service.log"),
        pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
      }));
      const candidatePlist = Buffer.from(
        priorPlist.toString().replace("service.log", "candidate.log"),
      );
      mkdirSync(join(home, "LaunchAgents"), { recursive: true });
      writeFileSync(plistPath(), candidatePlist, { mode: 0o600 });
      writeUpgradeTransition({
        schemaVersion: 1,
        phase: "service_bootstrapped",
        createdAt: 1,
        prior: {
          installed: true,
          loaded: true,
          disabled: false,
          current: { target: linkTarget(prior), payloadSha256: prior.sha256 },
          previous: { target: null, payloadSha256: null },
          plist: fileSnapshot(priorPlist),
        },
        target: {
          installed: true,
          disabled: false,
          version: candidate.version,
          payloadSha256: candidate.sha256,
          linkTarget: linkTarget(candidate),
          previous: { target: linkTarget(prior), payloadSha256: prior.sha256 },
          plist: fileSnapshot(candidatePlist),
        },
      });

      let loaded = true;
      let failFinalVerification = false;
      let restoreCalls = 0;
      const calls: string[] = [];
      const runtime: ServiceTransitionRuntimeDeps = {
        platform: "darwin",
        launch: (command) => {
          calls.push(command);
          if (command === "bootout") loaded = false;
          if (command === "bootstrap") loaded = true;
          return { status: 0, out: "" };
        },
        state: () => ({
          supported: true,
          installed: true,
          entryExists: true,
          loaded: failFinalVerification ? false : loaded,
          ...(loaded && !failFinalVerification ? { pid: process.pid } : {}),
        }),
        disabled: () => false,
        wait: () => {
          if (failure === "wait throws") throw new Error("wait crashed");
          if (failure === "final verification fails") failFinalVerification = true;
          return { ok: true };
        },
        smoke: () => ({ ok: true, note: "prior smoke passed" }),
        ...(failure === "plist scrub fails"
          ? {
              restorePlist: (path: string, contents: Buffer | null) => {
                restoreCalls += 1;
                if (restoreCalls > 1) throw new Error("disk scrub failed");
                if (contents) writeFileSync(path, contents, { mode: 0o600 });
              },
            }
          : {}),
        now: () => 10_000,
      };
      const result = reconcileServiceUpgradeTransition({
        maintenanceToken: "maintenance-token",
        acquireBarrier: () => ({ release: vi.fn() }),
        runtime,
      });

      expect(result).toMatchObject({
        ok: false,
        recovered: false,
      });
      expect(result.note).toContain("unverified prior service was stopped");
      expect(calls.filter((call) => call === "bootout").length).toBeGreaterThanOrEqual(2);
      expect(loaded).toBe(false);
      expect(hasUpgradeTransition()).toBe(true);
    },
  );
});
