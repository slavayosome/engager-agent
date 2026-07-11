import {
  RUNNER_CONTRACT_MAJOR,
  RUNNER_CONTRACT_MINOR,
  RUNNER_V1_TOOL_NAMES,
  RUNNER_V2_TOOL_NAMES,
  RunnerDirectiveResponseSchema,
  RunnerDraftItemSchema,
  RunnerReplyItemSchema,
  RunnerTriageItemSchema,
  type RunnerDirectiveResponse,
  type RunnerWorkContextResponse,
  type RunnerWorkOrder,
} from "@engager/runner-contract";
import { z } from "zod";
import { sanitizeTerminalText } from "./errors.js";

export const RUNNER_SUPPORTED_VERSION = Object.freeze({
  major: RUNNER_CONTRACT_MAJOR,
  minor: RUNNER_CONTRACT_MINOR,
});

export type RunnerProtocol = "v1" | "2.1";
export type RunnerSurface = "v1-or-bootstrap" | "v2";

const V1TriageSchema = z
  .object({
    toTriage: z.number().int().nonnegative(),
    topByReach: z.number().int().nonnegative(),
    random: z.number().int().nonnegative(),
  })
  .strict();

export const RunnerV1WorkOrderSchema = z
  .object({
    mode: z.enum(["draft", "rank"]),
    commentsToDraft: z.number().int().nonnegative(),
    candidatesToRank: z.number().int().nonnegative(),
    requestedDrafts: z.number().int().nonnegative(),
    pendingReplies: z.number().int().nonnegative(),
    triage: V1TriageSchema,
    windowEndsAt: z.number().int().nonnegative(),
  })
  .strict();
export type RunnerV1WorkOrder = z.infer<typeof RunnerV1WorkOrderSchema>;

export const RunnerV1DirectiveSchema = z
  .object({
    directive: z.enum(["run", "idle", "stop"]),
    reason: z.string().min(1),
    workOrder: RunnerV1WorkOrderSchema.nullable(),
    intervalMinutes: z.number().int().positive().nullable().optional(),
    intervalMinutesBase: z.number().int().positive().nullable().optional(),
    // The compatibility server still includes its persisted heartbeat row. It
    // is deliberately ignored by the executor but named here so parsing stays
    // strict rather than accepting arbitrary forward fields.
    runner: z.unknown().optional(),
  })
  .strict();
export type RunnerV1Directive = z.infer<typeof RunnerV1DirectiveSchema>;

export type NegotiatedDirective =
  | { protocol: "v1"; directive: RunnerV1Directive }
  | { protocol: "2.1"; directive: RunnerDirectiveResponse };

export function parseNegotiatedDirective(value: unknown): NegotiatedDirective {
  const v2 = RunnerDirectiveResponseSchema.safeParse(value);
  if (v2.success) {
    return {
      protocol: "2.1",
      directive: { ...v2.data, reason: sanitizeTerminalText(v2.data.reason) },
    };
  }
  const directive = RunnerV1DirectiveSchema.parse(value);
  return {
    protocol: "v1",
    directive: { ...directive, reason: sanitizeTerminalText(directive.reason) },
  };
}

export function classifyRunnerSurface(names: readonly string[]): RunnerSurface {
  const actual = [...new Set(names)].sort();
  const v2 = [...RUNNER_V2_TOOL_NAMES].sort();
  if (sameStrings(actual, v2)) return "v2";
  const v1 = [...RUNNER_V1_TOOL_NAMES].sort();
  if (sameStrings(actual, v1)) return "v1-or-bootstrap";
  throw new Error(
    `runner credential tool surface mismatch (received ${actual.join(", ") || "no tools"})`,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ProposalNote = z.string().trim().min(1).max(400).optional();

export const TriageProposalSchema = z
  .object({
    lane: z.literal("triage"),
    items: z.array(RunnerTriageItemSchema).min(1),
    note: ProposalNote,
  })
  .strict();

const ToollessDraftItemSchema = RunnerDraftItemSchema.superRefine((item, ctx) => {
  if (item.webSearched === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["webSearched"],
      message: "tool-less runner output cannot claim web research",
    });
  }
  if ((item.sources?.length ?? 0) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sources"],
      message: "tool-less runner output cannot attach external sources",
    });
  }
});

const DraftProposalFields = {
  items: z.array(ToollessDraftItemSchema).min(1),
  note: ProposalNote,
} as const;

export const DraftProposalSchema = z
  .object({ lane: z.literal("draft"), ...DraftProposalFields })
  .strict();
export const DiscoverDraftProposalSchema = z
  .object({ lane: z.literal("discover_draft"), ...DraftProposalFields })
  .strict();
export const ReplyProposalSchema = z
  .object({
    lane: z.literal("reply"),
    items: z.array(RunnerReplyItemSchema).min(1),
    note: ProposalNote,
  })
  .strict();

export const AgentProposalSchema = z.discriminatedUnion("lane", [
  TriageProposalSchema,
  DraftProposalSchema,
  DiscoverDraftProposalSchema,
  ReplyProposalSchema,
]);
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export function parseAgentProposal(value: unknown, expectedLane: RunnerWorkOrder["lane"]): AgentProposal {
  const proposal = AgentProposalSchema.parse(value);
  if (proposal.lane !== expectedLane) {
    throw new Error(`engine returned lane ${proposal.lane}; expected ${expectedLane}`);
  }
  return proposal;
}

export function workOrderItemIds(order: RunnerWorkOrder): number[] {
  return order.lane === "reply"
    ? [...order.input.incomingCommentIds]
    : [...order.input.candidateIds];
}

export function contextUnprocessedIds(context: RunnerWorkContextResponse): number[] {
  const value = context.receiptState.unprocessedFrozenIds;
  if (!Array.isArray(value)) return [...context.requestedItemIds];
  const ids = value.filter(
    (item): item is number => typeof item === "number" && Number.isSafeInteger(item) && item > 0,
  );
  const frozen = new Set(context.frozenItemIds);
  return ids.filter((id) => frozen.has(id));
}

export function proposalItemId(proposal: AgentProposal, item: AgentProposal["items"][number]): number {
  return proposal.lane === "reply"
    ? (item as z.infer<typeof RunnerReplyItemSchema>).incomingCommentId
    : (item as { candidateId: number }).candidateId;
}
