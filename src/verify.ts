import type { CampaignQueue } from "./mcp.js";
import type { SessionSummary } from "./session.js";

/**
 * Hardening layer 3: server state is the source of truth for success — the
 * runner never trusts the session transcript. A session that claims `ok` while
 * the queue didn't grow is treated as FAILED (and retried narrowed once).
 */

export type QueueSnapshot = {
  queued: number;
  /** Monotonic all-messages counter (newer servers) — drain-proof. */
  total?: number;
};

export function snapshot(q: CampaignQueue): QueueSnapshot {
  return {
    queued: q.pendingScheduled + q.proposedAwaitingApproval,
    ...(typeof q.messagesTotal === "number" ? { total: q.messagesTotal } : {}),
  };
}

/**
 * The growth the session actually caused. Prefer the MONOTONIC counter: queue
 * SIZE shrinks whenever the paced publisher posts mid-session, which failed
 * honest batch-1 sessions ("claimed 1 but the queue grew by 0" — reproduced
 * live: a post at 09:51 inside a 09:48–09:52 dry run). messagesTotal only ever
 * grows, so its delta is immune to concurrent drains while still catching
 * sessions that claim work they never landed.
 */
function growth(pre: QueueSnapshot, post: QueueSnapshot): number {
  if (pre.total != null && post.total != null) return post.total - pre.total;
  return post.queued - pre.queued;
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
  const delta = growth(pre, post);

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
  const ranked = summary.ranked ?? 0;
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
    // A discover SCOUT wake: ranking writes scores onto the candidate pool, it
    // never grows the message queue — so queue delta can't verify it. There is
    // nothing to draft, so this is legitimate work, not a silent no-op. (The
    // server rejects malformed rankings at intake, so the claimed count is
    // trustworthy enough; queue-growth verification only applies to drafts.)
    if (ranked > 0) {
      return { ok: true, note: `verified: ranked ${ranked} candidate${ranked === 1 ? "" : "s"}` };
    }
    return {
      ok: summary.outcome === "partial" || summary.outcome === "ok",
      note: `no work landed (${summary.outcome}): ${reasons(summary)}`,
      retryNarrowed: false,
    } as Verdict;
  }
  return {
    ok: true,
    note: `verified: queue +${delta}, submitted ${claimed}, replies ${summary.replies ?? 0}${
      ranked > 0 ? `, ranked ${ranked}` : ""
    }${summary.outcome === "partial" ? ` (partial: ${reasons(summary)})` : ""}`,
  };
}

function reasons(s: SessionSummary): string {
  return s.reasons?.length ? s.reasons.join("; ") : "no reasons given";
}
