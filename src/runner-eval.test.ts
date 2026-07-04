/**
 * Deterministic eval for the engager-agent runner's "never fails silently"
 * machinery (hardening layers 1 + 3): work-order construction, the mandatory
 * summary contract, server-state verification, the narrowed retry, and the
 * clean-skip path. A scripted fake MCP + scripted session results stand in for
 * the network and the LLM — every branch here is a behavior the autonomous
 * loop MUST keep as the skill/runner evolve.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AgentConfig } from "./config.js";
import { runCycle, type CycleDeps } from "./loop.js";
import type { CampaignQueue, CampaignRow, EngagerMcp } from "./mcp.js";
import type { SessionResult, WorkOrder } from "./session.js";

const CFG: AgentConfig = {
  ...CONFIG_DEFAULTS,
  mcpUrl: "https://fake/mcp",
  apiKey: "k",
  campaignId: 7,
};

type FakeState = {
  campaign: Partial<CampaignRow>;
  queued: number[];        // successive snapshots served by campaignQueue
  recommended: number;
  poolSufficient: boolean;
  replies: number[];
  discoverCalls: number;
  orders: WorkOrder[];     // captured session work orders
  sessions: SessionResult[]; // scripted session results, consumed in order
};

function fakeDeps(state: FakeState): CycleDeps {
  let queueReads = 0;
  const mcp = {
    listCampaigns: async () => [
      {
        id: 7,
        name: "c",
        status: "active",
        draftingMode: "agent",
        hourlyCommentCap: 3,
        ...state.campaign,
      },
    ],
    campaignQueue: async (): Promise<CampaignQueue> => {
      const queued = state.queued[Math.min(queueReads++, state.queued.length - 1)]!;
      return {
        campaignId: 7,
        campaignName: "c",
        draftingMode: "agent",
        pendingScheduled: queued,
        proposedAwaitingApproval: 0,
        dailyCapacity: 8,
        runwayDays: queued / 8,
        recommendedBatchSize: state.recommended,
        needsRefill: state.recommended > 0,
        candidatePool: {
          size: state.poolSufficient ? 500 : 3,
          target: 420,
          agingOutSoon: 0,
          sufficient: state.poolSufficient,
        },
      };
    },
    listIncoming: async () => state.replies.map((id) => ({ id, campaignId: 7, commenterName: "x", text: "t", receivedAt: 0, status: "new" })),
    discover: async () => {
      state.discoverCalls += 1;
      return {};
    },
    close: async () => {},
  } as unknown as EngagerMcp;

  return {
    connect: async () => mcp,
    session: async (_cfg, order) => {
      state.orders.push(order);
      const next = state.sessions.shift();
      if (!next) throw new Error("eval: unexpected extra session");
      return next;
    },
    sync: async () => ({ version: "2.7.0", updated: [], verified: 5 }),
  };
}

const session = (o: Partial<SessionResult>): SessionResult => ({
  exitCode: 0,
  summary: null,
  rawResult: "",
  durationMs: 1000,
  ...o,
});

beforeEach(() => {
  // Keep skillsRoot() away from the real ~/.claude in case a path resolves.
  process.env.ENGAGER_AGENT_SKILLS_ROOT = mkdtempSync(join(tmpdir(), "eval-skills-"));
});

describe("agent-runner eval — the autonomous cycle contract", () => {
  it("no headroom + no replies → clean skip, ZERO sessions spawned", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [24],
      recommended: 0,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out).toMatchObject({ ran: false, ok: true });
    expect(state.orders).toHaveLength(0); // deterministic work happens without the LLM
  });

  it("headroom → ONE session with a fully-resolved hourly work order (clamped to hourly cap)", async () => {
    const state: FakeState = {
      campaign: { hourlyCommentCap: 3 },
      queued: [10, 13],
      recommended: 42,
      poolSufficient: true,
      replies: [11, 12],
      discoverCalls: 0,
      orders: [],
      sessions: [
        session({
          summary: { outcome: "ok", submitted: 3, replies: 2, reasons: [] },
        }),
      ],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(state.orders).toEqual([{ campaignId: 7, batchSize: 3, replyIds: [11, 12] }]);
  });

  it("thin pool → a no-LLM discover top-up runs before the session", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [0, 3],
      recommended: 5,
      poolSufficient: false,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 3, reasons: [] } })],
    };
    await runCycle(CFG, {}, fakeDeps(state));
    expect(state.discoverCalls).toBe(1);
  });

  it("claimed success with no queue growth → FAILED, retried once narrowed to batch 1", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10, 11], // pre, post (no growth!), post-retry (+1)
      recommended: 5,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [
        session({ summary: { outcome: "ok", submitted: 3, reasons: [] } }), // lies
        session({ summary: { outcome: "ok", submitted: 1, reasons: [] } }), // narrowed, lands
      ],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(state.orders.map((o) => o.batchSize)).toEqual([3, 1]);
    expect(state.orders[1]!.replyIds).toEqual([]); // the retry is comments-only
  });

  it("session ends WITHOUT the mandatory JSON summary → contract violation → retry", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 12, 12],
      recommended: 5,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [
        session({ rawResult: "did great work, all done!" }), // no summary line
        session({ summary: { outcome: "failed", submitted: 0, reasons: ["still broken"] } }),
      ],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(false); // narrowed retry also failed → the cycle fails LOUDLY
    expect(state.orders).toHaveLength(2);
  });

  it("blocked (kill switch) → fails the cycle WITHOUT burning a retry session", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10],
      recommended: 5,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "blocked", reasons: ["kill switch on"] } })],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(false);
    expect(state.orders).toHaveLength(1); // no pointless retry against a kill switch
  });

  it("server-led campaign → refuses to run at all (strict split, runner side)", async () => {
    const state: FakeState = {
      campaign: { draftingMode: "server" },
      queued: [10],
      recommended: 0,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(false);
    expect(out.note).toContain("server-led");
    expect(out.fatal).toBe(true); // permanent condition → the loop halts, not retries
    expect(state.orders).toHaveLength(0);
  });

  it("campaign not found → FATAL (deleted campaigns halt the loop, not the failure budget)", async () => {
    const state: FakeState = {
      campaign: { id: 999 }, // listCampaigns returns a different id than CFG.campaignId
      queued: [10],
      recommended: 0,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(false);
    expect(out.fatal).toBe(true);
    expect(out.note).toContain("not found");
    expect(state.orders).toHaveLength(0);
  });
});
