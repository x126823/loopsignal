import type { DecisionOutcome, Outcome, OwnerOutcome, ReviewResolveOutcome } from "@/modules/lifecycle";

/**
 * Results are shown with a notice taken from a fixed vocabulary. The URL carries only a key, never free text, so a link
 * cannot make the page display arbitrary content.
 */
export type NoticeTone = "success" | "info" | "warning" | "danger";
export const NOTICES = {
  applied: { tone: "success", text: "Done. The change was recorded." },
  approved: { tone: "success", text: "Approved. The change was recorded." },
  rejected: { tone: "info", text: "Rejected. The request was closed." },
  queued: { tone: "info", text: "Recorded as a suggestion. A person with the right role must decide." },
  review: { tone: "warning", text: "That could not be applied automatically and was sent to the review queue." },
  noop: { tone: "info", text: "Nothing to change: the item was already in that state." },
  stale: { tone: "warning", text: "This item changed while you were looking at it. Review the latest state and try again." },
  forbidden: { tone: "danger", text: "You do not have permission to do that." },
  illegal: { tone: "warning", text: "That change is not allowed from the item's current state." },
  invalid: { tone: "danger", text: "That request was not valid." },
  not_found: { tone: "danger", text: "That item or request could not be found." },
  not_pending: { tone: "warning", text: "That request has already been decided or is no longer open." },
  out_of_order: { tone: "warning", text: "That would be recorded before the item's latest event. Please try again." },
  thread_open: { tone: "warning", text: "Another item is already open on this conversation, so this one cannot be reopened." },
  owner_assigned: { tone: "success", text: "Owner updated." },
  owner_noop: { tone: "info", text: "That person already owns this item." },
  owner_not_member: { tone: "danger", text: "Only members of the organization can own an item." },
  review_resolved: { tone: "success", text: "Review task resolved." },
  review_dismissed: { tone: "info", text: "Review task dismissed." },
  review_not_open: { tone: "warning", text: "That review task is no longer open." },
  conflict: { tone: "warning", text: "Someone else changed this at the same moment. Please try again." },
} as const satisfies Record<string, { tone: NoticeTone; text: string }>;

export type NoticeKey = keyof typeof NOTICES;
export const isNoticeKey = (v: unknown): v is NoticeKey => typeof v === "string" && Object.hasOwn(NOTICES, v);

/** Read ?notice= from search params. Unknown or repeated values are ignored. */
export function parseNotice(raw: string | string[] | undefined): { key: NoticeKey; tone: NoticeTone; text: string } | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return isNoticeKey(v) ? { key: v, ...NOTICES[v] } : null;
}

export function noticeForOutcome(o: Outcome): NoticeKey {
  switch (o.outcome) {
    case "APPLIED": return "applied";
    case "APPROVAL_REQUIRED": return "queued";
    case "NEEDS_REVIEW": return "review";
    case "NOOP": return "noop";
    case "REJECTED":
      return o.reason === "STALE_VERSION" ? "stale" : o.reason === "OUT_OF_ORDER" ? "out_of_order" : o.reason === "THREAD_HAS_OPEN_ITEM" ? "thread_open"
        : o.reason === "NOT_FOUND" || o.reason === "MESSAGE_NOT_FOUND" ? "not_found" : o.reason === "NOT_PENDING" ? "not_pending" : "illegal";
  }
}

export function noticeForDecision(o: DecisionOutcome): NoticeKey {
  if (o.outcome === "REJECTED") return o.reason === "NOT_FOUND" ? "not_found" : o.reason === "NOT_PENDING" ? "not_pending" : "illegal";
  if (o.transition && o.transition.outcome !== "APPLIED") return noticeForOutcome(o.transition);
  return o.status === "APPROVED" ? "approved" : "rejected";
}

export function noticeForOwner(o: OwnerOutcome): NoticeKey {
  if (o.outcome === "ASSIGNED") return "owner_assigned";
  if (o.outcome === "NOOP") return "owner_noop";
  return o.reason === "NOT_A_MEMBER" ? "owner_not_member" : "not_found";
}

export function noticeForReview(o: ReviewResolveOutcome): NoticeKey {
  if (o.outcome === "RESOLVED") return "review_resolved";
  if (o.outcome === "DISMISSED") return "review_dismissed";
  return o.reason === "NOT_OPEN" ? "review_not_open" : "not_found";
}
