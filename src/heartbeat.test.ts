import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { buildHeartbeat } from "./heartbeat.js";

const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "runner-secret",
  credentialProfile: "runner",
  runnerId: "runner-heartbeat-test",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

describe("runner heartbeat state mapping", () => {
  it.each(["upgrade-required", "quota-blocked"] as const)(
    "maps local-only %s to the wire-compatible idle state",
    (state) => {
      expect(
        buildHeartbeat(config, "0.9.0", {
          state,
          consecutiveFailures: 0,
          sessionsToday: 2,
        }).state,
      ).toBe("idle-remote");
    },
  );
});
