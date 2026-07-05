import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, configPath, loadConfig, saveConfig } from "./config.js";
import type { CampaignQueue, CampaignRow } from "./mcp.js";
import { buildCliArgs, buildPrompt, computeNeed, parseSummary } from "./session.js";
import { syncSkill } from "./skills.js";
import { snapshot, verifySession } from "./verify.js";

afterEach(() => {
  delete process.env.ENGAGER_AGENT_HOME;
});

const QUEUE: CampaignQueue = {
  campaignId: 7,
  campaignName: "c",
  draftingMode: "agent",
  pendingScheduled: 12,
  proposedAwaitingApproval: 3,
  dailyCapacity: 8,
  runwayDays: 1.5,
  recommendedBatchSize: 42,
  needsRefill: true,
  candidatePool: { size: 61, target: 420, agingOutSoon: 2, sufficient: false },
};
const CAMPAIGN: CampaignRow = {
  id: 7,
  name: "c",
  status: "active",
  draftingMode: "agent",
  hourlyCommentCap: 3,
};

describe("computeNeed — one wake-window of sizing", () => {
  it("clamps the server recommendation to the hourly cap (default hourly cadence)", () => {
    expect(computeNeed(QUEUE, CAMPAIGN)).toBe(3);
  });
  it("takes the recommendation when it is smaller", () => {
    expect(computeNeed({ ...QUEUE, recommendedBatchSize: 2 }, CAMPAIGN)).toBe(2);
  });
  it("zero recommendation → 0 (server-led campaigns always report 0)", () => {
    expect(computeNeed({ ...QUEUE, recommendedBatchSize: 0 }, CAMPAIGN)).toBe(0);
  });
  it("hourlyCommentCap 0 = uncapped → the recommendation as-is", () => {
    expect(computeNeed(QUEUE, { ...CAMPAIGN, hourlyCommentCap: 0 })).toBe(42);
  });
  it("a longer cadence widens the window: 3h × cap 3 = 9", () => {
    expect(computeNeed(QUEUE, CAMPAIGN, 180)).toBe(9);
  });
  it("cadence window still clamps to the recommendation", () => {
    expect(computeNeed({ ...QUEUE, recommendedBatchSize: 5 }, CAMPAIGN, 180)).toBe(5);
  });
  it("sub-hour cadences never shrink below one hour of work", () => {
    expect(computeNeed(QUEUE, CAMPAIGN, 30)).toBe(3);
  });
});

describe("buildCliArgs — claude adapter", () => {
  it("builds the locked-down headless invocation", () => {
    const { command, args } = buildCliArgs(
      { cli: "claude", model: "sonnet", maxTurns: 80 },
      "PROMPT",
      "/tmp/mcp.json",
      "/home/u/.claude/skills",
    );
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "PROMPT",
      "--model",
      "sonnet",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__engager__*,Read,WebSearch,WebFetch," +
        "Bash(node scripts/validate-draft.mjs*)," +
        "Bash(node ./scripts/validate-draft.mjs*)," +
        "Bash(node /home/u/.claude/skills/engager-batch/scripts/validate-draft.mjs*)",
      "--max-turns",
      "80",
      "--output-format",
      "json",
    ]);
  });

  it("web search is sanctioned, arbitrary node is not", () => {
    const { args } = buildCliArgs(
      { cli: "claude", model: "sonnet", maxTurns: 80 },
      "P",
      "/tmp/mcp.json",
      "/s",
    );
    const tools = args[args.indexOf("--allowedTools") + 1]!;
    expect(tools).toContain("WebSearch");
    expect(tools).toContain("WebFetch");
    expect(tools).not.toContain("Bash(node *)"); // the old blanket escape hatch
  });
  it("work order is fully resolved in the prompt (no open-ended judgment)", () => {
    const prompt = buildPrompt({ campaignId: 7, batchSize: 3, replyIds: [11, 12] });
    expect(prompt).toContain("campaign 7");
    expect(prompt).toContain("batch size 3");
    expect(prompt).toContain("ids: 11, 12");
    expect(prompt).toContain("AUTONOMOUS MODE");
    const noReplies = buildPrompt({ campaignId: 7, batchSize: 3, replyIds: [] });
    expect(noReplies).toContain("do not look for reply work");
  });
});

describe("parseSummary — the mandatory last-line JSON contract", () => {
  it("parses the summary from the last line", () => {
    const s = parseSummary(
      'drafting…\nall done\n{"outcome":"ok","submitted":3,"planned":3,"dropped":0,"reasons":[]}',
    );
    expect(s?.outcome).toBe("ok");
    expect(s?.submitted).toBe(3);
  });
  it("tolerates a prefix on the final line and picks the LAST summary", () => {
    const s = parseSummary(
      '{"outcome":"failed"}\nnoise {"outcome":"partial","submitted":1,"reasons":["post 4: slop"]}',
    );
    expect(s?.outcome).toBe("partial");
  });
  it("no summary → null (a contract violation the verifier fails)", () => {
    expect(parseSummary("I finished everything, great success!")).toBeNull();
  });
});

describe("verifySession — server state is the source of truth", () => {
  const pre = { queued: 10 };
  it("claimed submissions with no queue growth → FAILED + narrowed retry", () => {
    const v = verifySession(pre, { queued: 10 }, { outcome: "ok", submitted: 3 }, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.retryNarrowed).toBe(true);
  });
  it("queue grew to match → ok", () => {
    const v = verifySession(pre, { queued: 13 }, { outcome: "ok", submitted: 3, replies: 0 }, 0);
    expect(v.ok).toBe(true);
  });
  it("missing summary → FAILED (contract violation), retryable", () => {
    const v = verifySession(pre, { queued: 13 }, null, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.retryNarrowed).toBe(true);
  });
  it("blocked (kill switch etc.) → FAILED but NOT retried this hour", () => {
    const v = verifySession(pre, { queued: 10 }, { outcome: "blocked", reasons: ["kill switch"] }, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.retryNarrowed).toBe(false);
  });
  it("nothing_to_do → clean ok", () => {
    expect(verifySession(pre, { queued: 10 }, { outcome: "nothing_to_do" }, 0).ok).toBe(true);
  });
  it("snapshot counts scheduled + awaiting-approval", () => {
    expect(snapshot(QUEUE)).toEqual({ queued: 15 });
  });
});

describe("config — persisted at ENGAGER_AGENT_HOME with 0600", () => {
  it("round-trips and enforces the mode", () => {
    process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-agent-test-"));
    expect(loadConfig()).toBeNull();
    saveConfig({ ...CONFIG_DEFAULTS, mcpUrl: "https://x/mcp", apiKey: "k", campaignId: 7 });
    const cfg = loadConfig();
    expect(cfg).toMatchObject({ mcpUrl: "https://x/mcp", campaignId: 7, model: "sonnet" });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

describe("syncSkill — sha256-verified self-install", () => {
  function fakeMcp(files: Record<string, string>, tamper = false) {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    return {
      skillManifest: async () => ({
        name: "engager-batch",
        version: "2.7.0",
        files: Object.entries(files).map(([path, content]) => ({ path, sha256: sha(content) })),
      }),
      skillFile: async (_n: string, path: string) =>
        tamper ? files[path]! + "TAMPERED" : files[path]!,
    } as unknown as import("./mcp.js").EngagerMcp;
  }

  it("installs fresh files, then verifies-without-refetch when hashes match", async () => {
    const root = mkdtempSync(join(tmpdir(), "engager-skills-"));
    const files = { "SKILL.md": "# skill", "references/autonomous.md": "# auto" };
    const first = await syncSkill(fakeMcp(files), "engager-batch", root);
    expect(first.updated.sort()).toEqual(["SKILL.md", "references/autonomous.md"]);
    expect(readFileSync(join(root, "engager-batch/SKILL.md"), "utf8")).toBe("# skill");

    const second = await syncSkill(fakeMcp(files), "engager-batch", root);
    expect(second.updated).toEqual([]); // hash-verified, nothing refetched
  });

  it("refuses content that does not match the manifest hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "engager-skills-"));
    await expect(
      syncSkill(fakeMcp({ "SKILL.md": "# skill" }, true), "engager-batch", root),
    ).rejects.toThrow(/hash does not match/);
  });

  it("rejects path traversal in a hostile manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "engager-skills-"));
    const evil = {
      skillManifest: async () => ({
        name: "engager-batch",
        version: "x",
        files: [{ path: "../../evil.md", sha256: "0" }],
      }),
      skillFile: async () => "evil",
    } as unknown as import("./mcp.js").EngagerMcp;
    await expect(syncSkill(evil, "engager-batch", root)).rejects.toThrow(/unsafe path/);
  });
});
