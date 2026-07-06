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
import { findUnknownFlag } from "./commands.js";
import type { CampaignRow, OpsSummary } from "./mcp.js";
import {
  desktopEntry,
  describeDesktopEntry,
  parseClaudeMcpGet,
  planDesktopMerge,
  type DesktopConfig,
} from "./register.js";
import { renderPlist, stableBrewPath } from "./service.js";
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

describe("stableBrewPath", () => {
  // Simulated fs: the opt symlink points at the current keg.
  const KEG = "/opt/homebrew/Cellar/engager-agent/0.4.0/libexec/lib/node_modules/engager-agent/dist/cli.js";
  const OPT = "/opt/homebrew/opt/engager-agent/libexec/lib/node_modules/engager-agent/dist/cli.js";
  const resolveVia = (real: Record<string, string>) => (p: string) => {
    const r = real[p];
    if (!r) throw new Error(`ENOENT: ${p}`);
    return r;
  };

  it("rewrites versioned keg paths to the stable opt symlink (survives brew upgrade)", () => {
    const resolve = resolveVia({ [KEG]: KEG, [OPT]: KEG });
    expect(stableBrewPath(KEG, resolve)).toBe(OPT);
    expect(
      stableBrewPath("/opt/homebrew/Cellar/node/26.4.0/bin/node", resolveVia({
        "/opt/homebrew/Cellar/node/26.4.0/bin/node": "/opt/homebrew/Cellar/node/26.4.0/bin/node",
        "/opt/homebrew/opt/node/bin/node": "/opt/homebrew/Cellar/node/26.4.0/bin/node",
      })),
    ).toBe("/opt/homebrew/opt/node/bin/node");
  });

  it("keeps the keg path when the opt symlink is missing", () => {
    const resolve = resolveVia({ [KEG]: KEG });
    expect(stableBrewPath(KEG, resolve)).toBe(KEG);
  });

  it("keeps the keg path when opt resolves somewhere else", () => {
    const resolve = resolveVia({ [KEG]: KEG, [OPT]: "/somewhere/else" });
    expect(stableBrewPath(KEG, resolve)).toBe(KEG);
  });

  it("passes non-brew paths through untouched", () => {
    const boom = () => {
      throw new Error("must not resolve");
    };
    expect(stableBrewPath("/usr/local/bin/node", boom)).toBe("/usr/local/bin/node");
    expect(stableBrewPath("/Users/x/.npm-global/lib/node_modules/engager-agent/dist/cli.js", boom)).toBe(
      "/Users/x/.npm-global/lib/node_modules/engager-agent/dist/cli.js",
    );
  });
});

describe("findUnknownFlag", () => {
  it("lets every documented flag (and value-flag values) through", () => {
    expect(
      findUnknownFlag(["--once", "--batch", "2", "--campaign", "23", "--interval", "2h", "--service", "--json"]),
    ).toBeUndefined();
    expect(findUnknownFlag(["status", "--json"])).toBeUndefined();
    expect(findUnknownFlag([])).toBeUndefined();
  });

  it("catches typos and unknown flags so they can't fall through to a paid session", () => {
    expect(findUnknownFlag(["--hlep"])).toBe("--hlep");
    expect(findUnknownFlag(["--once", "--bacth", "2"])).toBe("--bacth");
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

describe("buildHeartbeat", () => {
  it("rounds every numeric field — jittered float wake times must never bounce off the server schema", async () => {
    const { buildHeartbeat } = await import("./heartbeat.js");
    const hb = buildHeartbeat(
      {
        mcpUrl: "https://m/mcp",
        apiKey: "k",
        cli: "claude",
        model: "sonnet",
        campaignId: 7,
        intervalMinutes: 60,
        maxTurns: 80,
        dailySessionCap: 24,
        runnerId: "r1",
      },
      "0.3.2",
      {
        state: "sleeping",
        lastCycle: { at: 1751700000123.75, ran: true, ok: true, note: "x" },
        consecutiveFailures: 0,
        sessionsToday: 1,
        nextWakeAt: 1751703600456.4200001, // Date.now() + interval + Math.random() jitter
      },
    );
    for (const k of ["intervalMinutes", "lastCycleAt", "consecutiveFailures", "sessionsToday", "nextWakeAt"] as const) {
      expect(Number.isInteger(hb[k]), `${k} must be an integer`).toBe(true);
    }
  });
});

describe("session tokens", () => {
  it("parseUsage sums input variants and fmtTokens humanizes", async () => {
    const { parseUsage, fmtTokens } = await import("./session.js");
    const t = parseUsage({
      input_tokens: 1200,
      cache_creation_input_tokens: 30000,
      cache_read_input_tokens: 14031,
      output_tokens: 1900,
    });
    expect(t).toEqual({ input: 45231, output: 1900 });
    expect(fmtTokens(t!)).toBe("45.2k in / 1.9k out");
    expect(fmtTokens({ input: 800, output: 42 })).toBe("800 in / 42 out");
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage({})).toBeUndefined(); // all-zero usage → nothing to show
  });
});
