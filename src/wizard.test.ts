import { describe, expect, it } from "vitest";
import type { AgentEngine, EngineName } from "./engine.js";
import type { ExecutionOutcome } from "./executor.js";
import { detectSetupEngines, isAcceptedSetupProof } from "./wizard.js";

function outcome(status: "completed" | "partial" | "failed"): ExecutionOutcome {
  return {
    ran: true,
    ok: status !== "failed",
    note: status,
    workOrderId: "11111111-1111-4111-8111-111111111111",
    lane: "triage",
    workPurpose: "setup_proof",
    completion: {
      contractVersion: 2,
      workOrderId: "11111111-1111-4111-8111-111111111111",
      lane: "triage",
      status,
      completedAt: 1,
      result:
        status === "completed"
          ? { accepted: 1, rejected: 0, alreadyExists: 0, failed: 0, unfinished: 0 }
          : status === "partial"
            ? { accepted: 1, rejected: 0, alreadyExists: 0, failed: 0, unfinished: 1 }
            : { accepted: 0, rejected: 0, alreadyExists: 0, failed: 0, unfinished: 1 },
    },
  };
}

describe("setup proof arming gate", () => {
  it("arms only on an exact completed setup-proof receipt", () => {
    expect(isAcceptedSetupProof(outcome("completed"))).toBe(true);
    expect(isAcceptedSetupProof(outcome("partial"))).toBe(false);
    expect(isAcceptedSetupProof(outcome("failed"))).toBe(false);
    expect(isAcceptedSetupProof({ ...outcome("completed"), workPurpose: "production" })).toBe(false);
  });
});

describe("setup provider config isolation", () => {
  it("keeps invalid environment and persisted overrides for an unselected provider isolated", async () => {
    const calls: Array<{ engine: EngineName; configDir?: string }> = [];
    const factory = (
      engine: EngineName,
      _executablePath?: string,
      configDir?: string,
    ): AgentEngine => {
      calls.push({ engine, ...(configDir ? { configDir } : {}) });
      return {
        name: engine,
        detect: async () => ({
          name: engine,
          installed: true,
          supported: true,
          authenticated: true,
          version: "test",
          executablePath: `/usr/local/bin/${engine}`,
        }),
        run: async () => {
          throw new Error("not used");
        },
      };
    };

    const result = await detectSetupEngines(
      undefined,
      {
        CLAUDE_CONFIG_DIR: "/Users/test/selected-claude",
        CODEX_HOME: "relative/broken-codex-home",
      },
      factory,
    );

    expect(calls).toEqual([
      { engine: "claude", configDir: "/Users/test/selected-claude" },
    ]);
    expect(result.engineConfigDirs).toEqual({
      claude: "/Users/test/selected-claude",
    });
    expect(result.detections).toEqual([
      expect.objectContaining({ name: "claude", supported: true }),
      expect.objectContaining({
        name: "codex",
        supported: false,
        detail: expect.stringContaining("CODEX_HOME must be an absolute path"),
      }),
    ]);

    calls.length = 0;
    const persisted = await detectSetupEngines(
      { engine: "codex", engineConfigDir: "relative/stale-codex-home" },
      { CLAUDE_CONFIG_DIR: "/Users/test/selected-claude" },
      factory,
    );
    expect(calls).toEqual([
      { engine: "claude", configDir: "/Users/test/selected-claude" },
    ]);
    expect(persisted.detections).toEqual([
      expect.objectContaining({ name: "claude", supported: true }),
      expect.objectContaining({
        name: "codex",
        supported: false,
        detail: expect.stringContaining("persisted CODEX_HOME must be an absolute path"),
      }),
    ]);
  });

  it("normalizes one provider probe rejection without aborting the other provider", async () => {
    const factory = (engine: EngineName): AgentEngine => ({
      name: engine,
      detect: async () => {
        if (engine === "codex") throw new Error("probe subprocess crashed");
        return {
          name: engine,
          installed: true,
          supported: true,
          authenticated: true,
          version: "test",
          executablePath: `/usr/local/bin/${engine}`,
        };
      },
      run: async () => {
        throw new Error("not used");
      },
    });

    const result = await detectSetupEngines(undefined, {}, factory);
    expect(result.detections).toEqual([
      expect.objectContaining({ name: "claude", supported: true }),
      expect.objectContaining({
        name: "codex",
        supported: false,
        detail: "codex probe failed: probe subprocess crashed",
      }),
    ]);
  });
});
