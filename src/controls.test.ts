import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fallbackDirective } from "./heartbeat.js";
import {
  clearHalt,
  parseDuration,
  readHalt,
  readPause,
  writeHalt,
  writePause,
} from "./markers.js";
import type { CampaignRow, OpsSummary } from "./mcp.js";
import {
  desktopEntry,
  describeDesktopEntry,
  parseClaudeMcpGet,
  planDesktopMerge,
  type DesktopConfig,
} from "./register.js";
import { renderPlist } from "./service.js";
import { readStatus, writeStatus, type RunnerStatus } from "./status.js";

beforeEach(() => {
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-agent-test-"));
});

const URL_ = "https://mcp.example.com/mcp";
const KEY = "eng_testkey";

describe("parseClaudeMcpGet", () => {
  it("absent on the 'No MCP server named' message even with exit 0", () => {
    expect(parseClaudeMcpGet('No MCP server named "engager".', 0)).toEqual({ registered: false });
  });

  it("absent on non-zero exit regardless of output", () => {
    expect(parseClaudeMcpGet("some output", 1)).toEqual({ registered: false });
  });

  it("present + URL extracted from the URL: field", () => {
    const out = `engager:\n  Scope: User\n  Type: http\n  URL: ${URL_}\n`;
    expect(parseClaudeMcpGet(out, 0)).toEqual({ registered: true, url: URL_ });
  });

  it("falls back to any https URL in the output", () => {
    expect(parseClaudeMcpGet(`engager (http): ${URL_} — connected`, 0)).toEqual({
      registered: true,
      url: URL_,
    });
  });
});

describe("planDesktopMerge", () => {
  const other = { command: "npx", args: ["-y", "other-server"] };
  const base: DesktopConfig = {
    mcpServers: { other },
    preferences: { keepMe: true },
  };

  it("add when engager is absent; everything else preserved", () => {
    const plan = planDesktopMerge(base, URL_, KEY);
    expect(plan.action).toBe("add");
    expect(plan.next.mcpServers?.other).toEqual(other);
    expect(plan.next.preferences).toEqual({ keepMe: true });
    expect(plan.next.mcpServers?.engager).toEqual(desktopEntry(URL_, KEY));
  });

  it("skip when the existing entry is identical", () => {
    const withEngager: DesktopConfig = {
      ...base,
      mcpServers: { ...base.mcpServers, engager: desktopEntry(URL_, KEY) },
    };
    expect(planDesktopMerge(withEngager, URL_, KEY).action).toBe("skip");
  });

  it("update when the URL differs (e.g. dev vs prod), touching only the engager entry", () => {
    const withDev: DesktopConfig = {
      ...base,
      mcpServers: { ...base.mcpServers, engager: desktopEntry("https://dev.example.com/mcp", KEY) },
    };
    const plan = planDesktopMerge(withDev, URL_, KEY);
    expect(plan.action).toBe("update");
    expect(plan.next.mcpServers?.engager).toEqual(desktopEntry(URL_, KEY));
    expect(plan.next.mcpServers?.other).toEqual(other);
  });

  it("update on key rotation (same URL, different key)", () => {
    const withOldKey: DesktopConfig = {
      mcpServers: { engager: desktopEntry(URL_, "eng_oldkey") },
    };
    expect(planDesktopMerge(withOldKey, URL_, KEY).action).toBe("update");
  });

  it("describeDesktopEntry names the URL, never the key", () => {
    const desc = describeDesktopEntry(desktopEntry(URL_, KEY));
    expect(desc).toBe(URL_);
    expect(desc).not.toContain(KEY);
  });
});

describe("renderPlist", () => {
  it("encodes the KeepAlive contract: restart crashes, never successful exits", () => {
    const plist = renderPlist({
      nodePath: "/usr/local/bin/node",
      scriptPath: "/x/dist/cli.js",
      logPath: "/x/logs/service.log",
      pathEnv: "/usr/local/bin:/usr/bin",
    });
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain("<string>--service</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain("<key>PATH</key>");
  });

  it("xml-escapes paths", () => {
    const plist = renderPlist({
      nodePath: "/a&b/node",
      scriptPath: "/x/cli.js",
      logPath: "/x/log",
      pathEnv: "/a&b/bin",
    });
    expect(plist).toContain("/a&amp;b/node");
    expect(plist).not.toContain("/a&b/node");
  });
});

describe("markers", () => {
  it("halt round-trips and clears", () => {
    expect(readHalt()).toBeNull();
    writeHalt("3 consecutive failed cycles", 3);
    expect(readHalt()?.reason).toBe("3 consecutive failed cycles");
    expect(readHalt()?.consecutiveFailures).toBe(3);
    clearHalt();
    expect(readHalt()).toBeNull();
  });

  it("pause without until holds; with until it auto-expires (and clears the file)", () => {
    writePause();
    expect(readPause()).not.toBeNull();
    writePause(Date.now() + 60_000);
    expect(readPause()).not.toBeNull();
    writePause(Date.now() - 1);
    expect(readPause()).toBeNull(); // expired → cleared
    expect(readPause()).toBeNull();
  });

  it("parseDuration handles m/h/d and rejects junk", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("90 min")).toBe(90 * 60_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });
});

describe("status file", () => {
  it("writes atomically and round-trips", () => {
    const status: RunnerStatus = {
      pid: process.pid,
      version: "0.2.0",
      campaignId: 7,
      model: "sonnet",
      state: "sleeping",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      consecutiveFailures: 0,
      sessionsToday: 2,
    };
    writeStatus(status);
    const read = readStatus();
    expect(read?.campaignId).toBe(7);
    expect(read?.state).toBe("sleeping");
    // no torn .tmp left behind
    const home = process.env.ENGAGER_AGENT_HOME!;
    expect(() => readFileSync(join(home, "status.json.tmp"))).toThrow();
  });
});

describe("fallbackDirective (older servers without report_runner_status)", () => {
  const now = 1_000_000;
  const campaign = (over: Partial<CampaignRow> = {}): CampaignRow => ({
    id: 7,
    name: "c",
    status: "active",
    draftingMode: "agent",
    hourlyCommentCap: 2,
    ...over,
  });
  const ops = (over: Partial<OpsSummary> = {}): OpsSummary => ({
    killSwitch: false,
    pausedReason: null,
    pausedUntil: null,
    ...over,
  });

  it("mirrors the server semantics: stop > idle > run", () => {
    expect(fallbackDirective(undefined, ops(), now).directive).toBe("stop");
    expect(fallbackDirective(campaign({ status: "archived" }), ops(), now).directive).toBe("stop");
    expect(fallbackDirective(campaign({ draftingMode: "server" }), ops(), now).directive).toBe(
      "stop",
    );
    expect(fallbackDirective(campaign(), ops({ killSwitch: true }), now).directive).toBe("idle");
    expect(
      fallbackDirective(campaign(), ops({ pausedUntil: now + 1, pausedReason: "x" }), now)
        .directive,
    ).toBe("idle");
    expect(fallbackDirective(campaign({ status: "paused" }), ops(), now).directive).toBe("idle");
    expect(fallbackDirective(campaign(), ops({ pausedUntil: now - 1 }), now).directive).toBe("run");
    expect(fallbackDirective(campaign(), null, now).directive).toBe("run");
  });
});
