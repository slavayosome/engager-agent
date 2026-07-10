import { describe, expect, it } from "vitest";
import { assertRunnerToolSurface, RUNNER_V1_TOOL_NAMES } from "./mcp.js";

describe("runner MCP credential surface", () => {
  it("accepts exactly the server's runner-v1 bridge regardless of order", () => {
    expect(() =>
      assertRunnerToolSurface([...RUNNER_V1_TOOL_NAMES].reverse()),
    ).not.toThrow();
  });

  it("rejects interactive and incomplete surfaces while normalizing duplicates", () => {
    expect(() =>
      assertRunnerToolSurface([...RUNNER_V1_TOOL_NAMES, "update_campaign"]),
    ).toThrow(/dedicated Engager runner profile/);
    expect(() =>
      assertRunnerToolSurface(RUNNER_V1_TOOL_NAMES.slice(1) as string[]),
    ).toThrow(/dedicated Engager runner profile/);
    expect(() =>
      assertRunnerToolSurface([
        ...RUNNER_V1_TOOL_NAMES,
        RUNNER_V1_TOOL_NAMES[0],
      ]),
    ).not.toThrow();
  });
});
