import { describe, expect, it } from "vitest";
import {
  materializeRunnerDraftingContext,
  type RunnerWorkContextResponse,
  type RunnerWorkOrder,
} from "@engager/runner-contract";
import { buildEnginePrompt, MAX_ENGINE_PROMPT_BYTES } from "./prompt.js";

const candidateIds = Array.from({ length: 10 }, (_, index) => index + 1);
const order: RunnerWorkOrder = {
  contractVersion: 2,
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: 1,
  purpose: "production",
  lane: "draft",
  attempt: 1,
  notBefore: 1,
  expiresAt: 100_000,
  leaseExpiresAt: 90_000,
  contextRevision: "ctx-prompt",
  input: { candidateIds },
  limits: { maxDrafts: 10 },
  supply: { demand: 10, matchedAvailable: 10, draftShortfall: 0 },
};

function context(sharedText: string): RunnerWorkContextResponse {
  const ids = candidateIds;
  return {
    contractVersion: 2,
    contextBuildVersion: "runner-context-v1",
    workOrderId: order.id,
    campaignId: order.campaignId,
    lane: "draft",
    contextRevision: order.contextRevision,
    requestedItemIds: ids,
    frozenItemIds: ids,
    frozenInput: { candidateIds: ids },
    securityBoundary: { filesystem: false, shell: false, web: false },
    receiptState: {
      processed: [],
      remainingCapacity: 10,
      unprocessedFrozenIds: ids,
      canComplete: false,
    },
    campaign: { id: 1, name: "test" },
    sharedDraftingContext: {
      renderedSystemPrompt: sharedText,
      slopPatterns: ["shared-pattern"],
    },
    items: ids.map((candidateId) => ({
      candidateId,
      linkedin: { trust: "untrusted_linkedin_data", data: { contentText: `post ${candidateId}` } },
      draftingContext: { author: { name: `author ${candidateId}` }, slop: { checked: true } },
    })),
  } as RunnerWorkContextResponse;
}

describe("bounded factored engine prompt", () => {
  it("keeps a worst-case ten-item shared Brain/prompt block exactly once", () => {
    const marker = "BRAIN-CONTEXT-MARKER-" + "x".repeat(180_000);
    const prompt = buildEnginePrompt(order, context(marker));
    expect(prompt.split("BRAIN-CONTEXT-MARKER-")).toHaveLength(2);
    expect(prompt).not.toContain("draftingContextMerge");
    expect(prompt).toContain("sharedEffectiveDraftingContext");
    expect(prompt).toContain('"patterns":["shared-pattern"]');
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(220_000);
  });

  it("materializes contract overrides before deterministically re-factoring the bounded prompt", () => {
    const response = context("Shared system prompt") as Extract<
      RunnerWorkContextResponse,
      { lane: "draft" | "discover_draft" }
    >;
    response.sharedDraftingContext = {
      renderedSystemPrompt: "Shared system prompt",
      product: { name: "shared product" },
      slopPatterns: ["lifted-pattern"],
      slop: { sharedRule: true },
    };
    response.items = [
      {
        candidateId: 1,
        linkedin: { trust: "untrusted_linkedin_data", data: { contentText: "one" } },
        draftingContext: {
          product: { name: "item product" },
          slop: { itemRule: true },
        },
      },
      {
        candidateId: 2,
        linkedin: { trust: "untrusted_linkedin_data", data: { contentText: "two" } },
        draftingContext: { slop: null },
      },
    ];
    response.requestedItemIds = [1, 2];
    response.frozenItemIds = [1, 2];
    response.frozenInput = { candidateIds: [1, 2] };
    response.receiptState = {
      remainingCapacity: 2,
      unprocessedFrozenIds: [1, 2],
      canComplete: false,
    };
    const twoItemOrder = {
      ...order,
      input: { candidateIds: [1, 2] },
      limits: { maxDrafts: 2 },
      supply: { demand: 2, matchedAvailable: 2, draftShortfall: 0 },
    } satisfies RunnerWorkOrder;

    const payload = promptPayload(buildEnginePrompt(twoItemOrder, response)) as {
      sharedEffectiveDraftingContext: Record<string, unknown>;
      draftingContextInvariant: string;
      items: Array<Record<string, unknown> & { candidateId: number }>;
    };
    expect(payload).not.toHaveProperty("sharedDraftingContext");
    expect(payload).not.toHaveProperty("draftingContextMerge");
    expect(payload.draftingContextInvariant).toContain("already materialized");

    for (const [index, item] of response.items.entries()) {
      const wire = payload.items[index]!;
      expect(wire).not.toHaveProperty("draftingContext");
      const specific = wire.effectiveDraftingContext as Record<string, unknown>;
      expect(
        Object.keys(specific).some((key) =>
          Object.prototype.hasOwnProperty.call(payload.sharedEffectiveDraftingContext, key),
        ),
      ).toBe(false);
      expect({ ...payload.sharedEffectiveDraftingContext, ...specific }).toEqual(
        materializeRunnerDraftingContext(response, item),
      );
    }
    expect(
      (payload.items[0]!.effectiveDraftingContext as { slop: Record<string, unknown> }).slop,
    ).toEqual({
      sharedRule: true,
      itemRule: true,
      patterns: ["lifted-pattern"],
    });
    expect(
      (payload.items[1]!.effectiveDraftingContext as { slop: unknown }).slop,
    ).toBeNull();
  });

  it("rejects an oversized final prompt before provider-session reservation", () => {
    const oversized = "x".repeat(MAX_ENGINE_PROMPT_BYTES);
    expect(() => buildEnginePrompt(order, context(oversized))).toThrow(/maximum is/);
  });

  it("keeps triage, drafting, discover-draft, and reply instructions mutually exclusive", () => {
    const triage = promptForLane("triage");
    expect(triage).toContain("Judge relevance only");
    expect(triage).toContain("Do not draft comments");
    expect(triage).not.toContain("sharedEffectiveDraftingContext");

    const draft = promptForLane("draft");
    expect(draft).toContain("strongest remaining matched candidates");
    expect(draft).toContain("Do not triage, reply");

    const requested = promptForLane("discover_draft");
    expect(requested).toContain("explicitly requested remaining candidates");
    expect(requested).toContain("Do not triage, fill a schedule");

    const reply = promptForLane("reply");
    expect(reply).toContain("For every remaining incoming comment");
    expect(reply).toContain("Do not draft new post comments");
    expect(reply).not.toContain("sharedEffectiveDraftingContext");
  });
});

function promptForLane(lane: RunnerWorkOrder["lane"]): string {
  const id = lane === "reply" ? 401 : 101;
  const work = {
    contractVersion: 2,
    id: `${lane === "triage" ? "1" : lane === "draft" ? "2" : lane === "discover_draft" ? "3" : "4"}1111111-1111-4111-8111-111111111111`,
    campaignId: 1,
    purpose: "production",
    lane,
    attempt: 1,
    notBefore: 1,
    expiresAt: 100_000,
    leaseExpiresAt: 90_000,
    contextRevision: `ctx-${lane}`,
    input:
      lane === "reply"
        ? { incomingCommentIds: [id] }
        : lane === "triage"
          ? { candidateIds: [id], topByReach: 1, random: 0 }
          : { candidateIds: [id] },
    limits:
      lane === "triage"
        ? { maxVerdicts: 1 }
        : lane === "reply"
          ? { maxReplies: 1 }
          : { maxDrafts: 1 },
    ...(lane === "draft"
      ? { supply: { demand: 1, matchedAvailable: 1, draftShortfall: 0 } }
      : {}),
  } as RunnerWorkOrder;
  const response = {
    contractVersion: 2,
    contextBuildVersion: "runner-context-v1",
    workOrderId: work.id,
    campaignId: 1,
    lane,
    contextRevision: work.contextRevision,
    requestedItemIds: [id],
    frozenItemIds: [id],
    frozenInput: lane === "reply" ? { incomingCommentIds: [id] } : { candidateIds: [id] },
    securityBoundary: { filesystem: false, shell: false, web: false },
    receiptState: { remainingCapacity: 1, unprocessedFrozenIds: [id], canComplete: false },
    campaign: { id: 1 },
    ...(lane === "triage" ? { filter: { objective: "ICP" } } : {}),
    ...(lane === "reply" ? { replyPolicy: { sensitivity: "hold" } } : {}),
    ...(lane === "draft" || lane === "discover_draft"
      ? { sharedDraftingContext: { renderedSystemPrompt: "Write directly." } }
      : {}),
    items: [
      lane === "reply"
        ? {
            incomingCommentId: id,
            linkedin: { trust: "untrusted_linkedin_data", data: { text: "Question" } },
            replyDraftingContext: { renderedSystemPrompt: "Reply directly." },
          }
        : {
            candidateId: id,
            linkedin: { trust: "untrusted_linkedin_data", data: { contentText: "Post" } },
            ...(lane === "draft" || lane === "discover_draft"
              ? { draftingContext: { author: { name: "Author" } } }
              : {}),
          },
    ],
  } as unknown as RunnerWorkContextResponse;
  return buildEnginePrompt(work, response);
}

function promptPayload(prompt: string): unknown {
  return JSON.parse(prompt.split("\n\n").at(-1)!);
}
