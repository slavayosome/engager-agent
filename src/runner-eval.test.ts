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
import type { CampaignQueue, CampaignRow, EngagerMcp, ServerWorkOrder } from "./mcp.js";
import type { SessionResult, WorkOrder } from "./session.js";

const CFG: AgentConfig = {
  ...CONFIG_DEFAULTS,
  mcpUrl: "https://fake/mcp",
  apiKey: "k",
  credentialProfile: "runner",
  runnerId: "eval-runner",
  campaignId: 7,
};

type FakeState = {
  campaign: Partial<CampaignRow>;
  queued: number[];        // successive snapshots served by campaignQueue
  /** Optional monotonic messagesTotal per queue read (newer servers). */
  totals?: number[];
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
      const read = queueReads++;
      const queued = state.queued[Math.min(read, state.queued.length - 1)]!;
      const total = state.totals?.[Math.min(read, state.totals.length - 1)];
      return {
        campaignId: 7,
        campaignName: "c",
        draftingMode: "agent",
        pendingScheduled: queued,
        proposedAwaitingApproval: 0,
        ...(total != null ? { messagesTotal: total } : {}),
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

/** A DISCOVER campaign's rank work order (commentsToDraft always 0). */
const rankOrder = (o: Partial<ServerWorkOrder>): ServerWorkOrder => ({
  mode: "rank",
  commentsToDraft: 0,
  candidatesToRank: 0,
  requestedDrafts: 0,
  pendingReplies: 0,
  windowEndsAt: 0,
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

  it("concurrent publisher drain can't fail an honest session (monotonic messagesTotal)", async () => {
    // The live repro: batch 1 submitted for real, but the paced publisher
    // posted one mid-session — queue SIZE read +0 while messagesTotal read +1.
    const state: FakeState = {
      campaign: {},
      queued: [10, 10],   // size unchanged: +1 submitted, −1 posted
      totals: [50, 51],   // the monotonic truth: one new message landed
      recommended: 1,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 1 } })],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(out.note).toContain("+1");
  });

  it("a lying session is still caught when messagesTotal doesn't grow", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 11],   // size even grew (some other writer) …
      totals: [50, 50],   // … but THIS session created nothing
      recommended: 1,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [
        session({ summary: { outcome: "ok", submitted: 1 } }),
        session({ summary: { outcome: "ok", submitted: 1 } }), // narrowed retry
      ],
    };
    const out = await runCycle(CFG, {}, fakeDeps(state));
    expect(out.ok).toBe(false);
    expect(out.note).toContain("grew by 0");
  });

  it("server work order overrides the local hourly-clamp sizing", async () => {
    const state: FakeState = {
      campaign: { hourlyCommentCap: 3 }, // local fallback would say 3
      queued: [10, 15],
      recommended: 42,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 5, reasons: [] } })],
    };
    const out = await runCycle(CFG, { serverBatch: 5 }, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(state.orders).toEqual([{ campaignId: 7, batchSize: 5, replyIds: [] }]);
  });

  it("server work order 0 + no replies → clean skip, ZERO sessions", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10],
      recommended: 42, // local sizing would have drafted — the server's 0 wins
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [],
    };
    const out = await runCycle(CFG, { serverBatch: 0 }, fakeDeps(state));
    expect(out).toMatchObject({ ran: false, ok: true });
    expect(out.note).toContain("server work order");
    expect(state.orders).toHaveLength(0);
    expect(state.discoverCalls).toBe(0); // no top-up for a filled window
  });

  it("draft wake with batch 0 but a triage deficit → RUNS to refresh the pool (not a skip)", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10], // triage writes verdicts on the pool — it never grows the queue
      recommended: 0,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 0, reasons: [] } })],
    };
    const serverOrder: ServerWorkOrder = {
      mode: "draft",
      commentsToDraft: 0, // draft window full — pre-curation runners would SKIP here
      pendingReplies: 0,
      windowEndsAt: 0,
      triage: { toTriage: 50, topByReach: 35, random: 15 },
    };
    const out = await runCycle(CFG, { serverOrder }, fakeDeps(state));
    expect(out.ran).toBe(true); // NOT nothing_to_do — the triage deficit is a wake reason
    expect(state.orders).toEqual([
      { campaignId: 7, batchSize: 0, replyIds: [], triageToRefresh: 50 },
    ]);
    expect(state.discoverCalls).toBe(0); // triage-only wake needs no raw-pool top-up
  });

  it("server work order 0 + pending replies → reply-only session (batch 0)", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10],
      recommended: 42,
      poolSufficient: true,
      replies: [21, 22],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 0, replies: 2, reasons: [] } })],
    };
    const out = await runCycle(CFG, { serverBatch: 0 }, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(state.orders).toEqual([{ campaignId: 7, batchSize: 0, replyIds: [21, 22] }]);
  });

  it("batchOverride (--batch) beats the server work order", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 12],
      recommended: 42,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 2, reasons: [] } })],
    };
    await runCycle(CFG, { batchOverride: 2, serverBatch: 9 }, fakeDeps(state));
    expect(state.orders.map((o) => o.batchSize)).toEqual([2]);
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

  // ── Discover "rank" work orders (the scout wake) ──────────────────────────
  it("rank wake with unranked candidates → ONE scout session, rank order, no draft top-up", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10], // ranking writes scores on the pool — it never grows the queue
      recommended: 0,
      poolSufficient: false, // even a thin pool: a rank wake never triggers the draft top-up
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", ranked: 30, submitted: 0, reasons: [] } })],
    };
    const out = await runCycle(CFG, { serverOrder: rankOrder({ candidatesToRank: 30 }) }, fakeDeps(state));
    expect(out.ok).toBe(true);
    expect(out.note).toContain("ranked 30");
    expect(state.orders).toEqual([
      { campaignId: 7, batchSize: 0, replyIds: [], mode: "rank", candidatesToRank: 30, requestedDrafts: 0 },
    ]);
    expect(state.discoverCalls).toBe(0); // the scout scores the pool as it stands
  });

  it("rank wake with a fully-ranked pool + no requests/replies → clean skip, ZERO sessions", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [24],
      recommended: 42, // an old CLI would size a draft here — the rank order forbids it
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [],
    };
    const out = await runCycle(
      CFG,
      { serverOrder: rankOrder({ candidatesToRank: 0, requestedDrafts: 0 }) },
      fakeDeps(state),
    );
    expect(out).toMatchObject({ ran: false, ok: true });
    expect(out.note).toContain("rank wake");
    expect(state.orders).toHaveLength(0);
  });

  it("rank wake with explicit requested drafts → drafts them, verified by queue growth", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 12], // the 2 requested drafts landed as proposed messages
      recommended: 0,
      poolSufficient: true,
      replies: [],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 2, ranked: 5, reasons: [] } })],
    };
    const out = await runCycle(
      CFG,
      { serverOrder: rankOrder({ candidatesToRank: 5, requestedDrafts: 2 }) },
      fakeDeps(state),
    );
    expect(out.ok).toBe(true);
    expect(state.orders).toEqual([
      { campaignId: 7, batchSize: 2, replyIds: [], mode: "rank", candidatesToRank: 5, requestedDrafts: 2 },
    ]);
    expect(out.note).toContain("submitted 2");
  });

  it("rank wake with only pending replies → reply-only scout session (batch 0)", async () => {
    const state: FakeState = {
      campaign: {},
      queued: [10, 10],
      recommended: 0,
      poolSufficient: true,
      replies: [31, 32],
      discoverCalls: 0,
      orders: [],
      sessions: [session({ summary: { outcome: "ok", submitted: 0, replies: 2, reasons: [] } })],
    };
    const out = await runCycle(
      CFG,
      { serverOrder: rankOrder({ candidatesToRank: 0, requestedDrafts: 0 }) },
      fakeDeps(state),
    );
    expect(out.ok).toBe(true);
    expect(state.orders).toEqual([
      { campaignId: 7, batchSize: 0, replyIds: [31, 32], mode: "rank", candidatesToRank: 0, requestedDrafts: 0 },
    ]);
  });
});
