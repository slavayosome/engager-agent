import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnknownFlag,
  resumeCommand,
  sanitizeLogText,
  shouldEnterServiceLifecycle,
  statusCommand,
  stopCommand,
  type StopCommandDeps,
  type ResumeCommandDeps,
} from "./commands.js";
import { maintenanceLockPath, runnerLockPath } from "./lock.js";

let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-commands-test-"));
});
afterEach(() => {
  process.exitCode = undefined;
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

describe("sanitized log tail", () => {
  it("preserves line boundaries while stripping credentials and terminal controls", () => {
    const safe = sanitizeLogText(
      "first\napiKey=secret-value-123\nthird\u001b[31m\u009b32m\u202e",
    );
    expect(safe.split("\n")).toEqual(["first", "apiKey=[REDACTED]", "third"]);
    for (const line of safe.split("\n")) {
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
    }
  });
});

describe("CLI flag registry", () => {
  it("recognizes the setup-proof project value without treating its UUID as a flag", () => {
    expect(
      findUnknownFlag([
        "setup",
        "--setup-proof-org",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).toBeUndefined();
  });
});

describe("service lifecycle routing", () => {
  it("enters maintenance for a journaled transition even when the plist is temporarily absent", () => {
    expect(shouldEnterServiceLifecycle(false, true)).toBe(true);
    expect(shouldEnterServiceLifecycle(true, false)).toBe(true);
    expect(shouldEnterServiceLifecycle(false, false)).toBe(false);
  });
});

describe("resume command", () => {
  it("does not clear markers or status when lifecycle maintenance refuses", () => {
    const apply = vi.fn();
    const clearHalt = vi.fn();
    const clearPause = vi.fn();
    const readStatus = vi.fn();
    const writeStatus = vi.fn(() => true);
    const output = vi.fn();
    const deps: ResumeCommandDeps = {
      resume: (callback) => {
        apply.mockImplementation(callback);
        return { ok: false, note: "UPGRADE_BLOCKED: unsafe execution lock" };
      },
      clearHalt,
      clearPause,
      readStatus,
      writeStatus,
      now: () => 123,
      output,
    };

    resumeCommand(deps);
    expect(apply).not.toHaveBeenCalled();
    expect(clearHalt).not.toHaveBeenCalled();
    expect(clearPause).not.toHaveBeenCalled();
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("mutates local resume state only when invoked inside the orchestrator", () => {
    const clearHalt = vi.fn();
    const clearPause = vi.fn();
    const writeStatus = vi.fn(() => true);
    const status = {
      schemaVersion: 2 as const,
      pid: 1,
      version: "0.9.0",
      runnerId: "resume-test",
      engine: "claude" as const,
      state: "paused-local" as const,
      startedAt: 1,
      updatedAt: 1,
      consecutiveFailures: 0,
      sessionsToday: 0,
      sessionDay: "2026-07-12",
    };
    const deps: ResumeCommandDeps = {
      resume: (callback) => {
        callback();
        return { ok: true, note: "resumed under maintenance" };
      },
      clearHalt,
      clearPause,
      readStatus: () => status,
      writeStatus,
      now: () => 123,
      output: vi.fn(),
    };
    resumeCommand(deps);
    expect(clearHalt).toHaveBeenCalledOnce();
    expect(clearPause).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        quotaState: {
          status: "available",
          reasonCode: "manual_resume",
          observedAt: 123,
        },
      }),
    );
  });
});

describe("status lock diagnostics", () => {
  it("inspects both locks without configuration and never serializes capabilities", () => {
    const secret = "status-lock-capability-secret";
    mkdirSync(runnerLockPath("global"), { recursive: true, mode: 0o700 });
    writeFileSync(join(runnerLockPath("global"), "owner.json"), `not-json ${secret}\n`, {
      mode: 0o600,
    });
    mkdirSync(maintenanceLockPath(), { recursive: true, mode: 0o700 });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      statusCommand(true);
      const rendered = output.mock.calls.map(([value]) => String(value)).join("");
      expect(rendered).not.toContain(secret);
      expect(JSON.parse(rendered)).toMatchObject({
        locks: {
          execution: { state: "invalid" },
          maintenance: { state: "invalid" },
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.mockRestore();
    }
  });
});

describe("stop command", () => {
  it("delegates the complete stop lifecycle to the maintenance orchestrator", () => {
    const output = vi.fn();
    const deps: StopCommandDeps = {
      stop: () => ({ ok: true, note: "service stopped; verified owner signaled; execution is quiescent" }),
      output,
    };
    stopCommand(deps);
    expect(output).toHaveBeenCalledWith(
      "service stopped; verified owner signaled; execution is quiescent",
    );
  });

  it("surfaces a fail-closed lifecycle refusal", () => {
    const output = vi.fn();
    const deps: StopCommandDeps = {
      stop: () => ({
        ok: false,
        note: "UPGRADE_BLOCKED: execution lock ownership is unsafe; nothing was signaled or removed",
      }),
      output,
    };
    stopCommand(deps);
    expect(output).toHaveBeenCalledWith(
      "UPGRADE_BLOCKED: execution lock ownership is unsafe; nothing was signaled or removed",
    );
    expect(process.exitCode).toBe(1);
  });
});
