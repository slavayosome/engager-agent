import { describe, expect, it } from "vitest";
import { RUNNER_ERROR_CATALOG, RUNNER_ERROR_CODES, RunnerFault, formatRunnerFault, sanitizeTerminalText } from "./errors.js";

describe("terminal-safe runner errors", () => {
  it("keeps the stable CLI catalog exhaustive and directly keyed by the exported codes", () => {
    expect(Object.keys(RUNNER_ERROR_CATALOG)).toEqual([...RUNNER_ERROR_CODES]);
    for (const code of RUNNER_ERROR_CODES) {
      expect(RUNNER_ERROR_CATALOG[code].summary).toBeTruthy();
      expect(RUNNER_ERROR_CATALOG[code].defaultRecovery).toBeTruthy();
    }
  });
  it("flattens ANSI, OSC, forged lines, bidi, and invisible controls", () => {
    const hostile = "first\n[FAKE] second\u001b[31m red\u001b[0m\u001b]0;owned\u0007\u009b31mblue\u009d0;owned\u009c\u202e\u200b";
    const safe = sanitizeTerminalText(hostile);
    expect(safe).toBe("first [FAKE] second redblue");
    expect(safe).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e\u200b]/);
  });

  it("sanitizes every customer-visible RunnerFault field", () => {
    const formatted = formatRunnerFault(
      new RunnerFault("INTERNAL_ERROR", "bad\nline\u001b[31m", {
        impact: "impact\u001b]0;owned\u0007",
        recovery: "fix\rnow",
        reference: "ref\u202e",
      }),
    );
    expect(formatted.split("\n")).toHaveLength(4);
    expect(formatted).not.toContain("\u001b");
    expect(formatted).not.toContain("\u202e");
  });
});
