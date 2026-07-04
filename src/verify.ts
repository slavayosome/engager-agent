import type { CampaignQueue } from "./mcp.js";
import type { SessionSummary } from "./session.js";

/**
 * Hardening layer 3: server state is the source of truth for success — the
 * runner never trusts the session transcript. A session that claims `ok` while
 * the queue didn't grow is treated as FAILED (and retried narrowed once).
 */

export type QueueSnapshot = { queued: number };

export function snapshot(q: CampaignQueue): QueueSnapshot {
  return { queued: q.pendingScheduled + q.proposedAwaitingApproval };
}

export type Verdict =
  | { ok: true; note: string }
  | { ok: false; note: string; retryNarrowed: boolean };

export function verifySession(
  pre: QueueSnapshot,
  post: QueueSnapshot,
  summary: SessionSummary | null,
  exitCode: number,
): Verdict {
  const delta = post.queued - pre.queued;

  if (summary == null) {
    return {
      ok: false,
      note: `session ended without the mandatory JSON summary (exit ${exitCode}) — contract violation`,
      retryNarrowed: true,
    };
  }
  if (summary.outcome === "blocked") {
    // Kill switch / pause / connection down: retrying won't help this hour.
    return { ok: false, note: `blocked: ${reasons(summary)}`, retryNarrowed: false };
  }
  if (summary.outcome === "failed") {
    return { ok: false, note: `session reported failure: ${reasons(summary)}`, retryNarrowed: true };
  }
  if (summary.outcome === "nothing_to_do") {
    return { ok: true, note: "nothing to do (clean skip)" };
  }

  const claimed = summary.submitted ?? 0;
  if (claimed > 0 && delta <= 0) {
    // alreadyExisted resubmits can legitimately produce a 0 delta, but in an
    // hourly loop a whole batch of them means the session drafted nothing new
    // while claiming success — exactly the silent failure this check exists for.
    return {
      ok: false,
      note: `claimed ${claimed} submitted but the queue grew by ${delta} — treating as failed`,
      retryNarrowed: true,
    };
  }
  if (claimed === 0 && (summary.replies ?? 0) === 0) {
    return {
      ok: summary.outcome === "partial" || summary.outcome === "ok",
      note: `no work landed (${summary.outcome}): ${reasons(summary)}`,
      retryNarrowed: false,
    } as Verdict;
  }
  return {
    ok: true,
    note: `verified: queue +${delta}, submitted ${claimed}, replies ${summary.replies ?? 0}${
      summary.outcome === "partial" ? ` (partial: ${reasons(summary)})` : ""
    }`,
  };
}

function reasons(s: SessionSummary): string {
  return s.reasons?.length ? s.reasons.join("; ") : "no reasons given";
}
