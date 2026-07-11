import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnknownFlag,
  sanitizeLogText,
  stopCommand,
  type StopCommandDeps,
} from "./commands.js";

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

describe("stop command", () => {
  it("stops an installed service and still signals a live foreground lock owner", () => {
    const output = vi.fn();
    const kill = vi.fn(() => true) as unknown as typeof process.kill;
    const owner = {
      pid: 4242,
      token: "owner-token",
      runnerId: "runner-test",
      startedAt: 1,
      processIdentity: "trusted-start-time",
    };
    const deps: StopCommandDeps = {
      serviceState: () => ({ supported: true, installed: true, entryExists: true, loaded: false }),
      stopService: () => ({ ok: true, note: "service stopped" }),
      loadConfig: () => null,
      readOwner: () => owner,
      ownerLive: () => true,
      kill,
      output,
    };
    stopCommand(deps);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(output).toHaveBeenCalledWith("service stopped");
  });

  it("refuses to signal a PID-only stale lock owner", () => {
    const output = vi.fn();
    const kill = vi.fn(() => true) as unknown as typeof process.kill;
    const deps: StopCommandDeps = {
      serviceState: () => ({ supported: true, installed: false, entryExists: false, loaded: false }),
      stopService: () => ({ ok: true, note: "not used" }),
      loadConfig: () => null,
      readOwner: () => ({
        pid: 4242,
        token: "legacy-token",
        runnerId: "runner-test",
        startedAt: 1,
      }),
      ownerLive: () => true,
      kill,
      output,
    };
    stopCommand(deps);
    expect(kill).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      "runner lock owner has no verifiable process identity; refusing to signal its pid",
    );
    expect(process.exitCode).toBe(1);
  });
});
