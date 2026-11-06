import type { DecisionOutcome as CorrelationOutcome } from "@/modules/correlation";
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
  correlation_confirmed: { tone: "success", text: "Attached. The conversation now belongs to that item." },
  correlation_rejected: { tone: "info", text: "Kept separate. The message will be tracked as its own item." },
  correlation_split: { tone: "info", text: "Detached. The message will be tracked as its own item." },
  correlation_decided: { tone: "warning", text: "That question was already decided." },
  correlation_target_closed: { tone: "warning", text: "That item is closed, so nothing can be attached to it. You can still keep the message separate." },
  correlation_split_blocked: { tone: "warning", text: "This conversation already moved the item forward, so it cannot be detached. Use the item's own decisions instead." },
  correlation_not_confirmed: { tone: "warning", text: "Only an attached conversation can be detached." },
  follow_up_failed: { tone: "warning", text: "Your decision was saved, but the follow-up could not be queued yet. Use \"Retry follow-up\" on the review page." },
  follow_up_retried: { tone: "success", text: "Follow-up queued." },
  decision_required: { tone: "warning", text: "A cross-channel question is closed by deciding it: attach it or keep it separate." },
  notifications_read: { tone: "success", text: "Marked as read." },
  preferences_saved: { tone: "success", text: "Your notification settings were saved." },
  gmail_connected: { tone: "success", text: "Mailbox connected. The first sync is queued." },
  gmail_reconnected: { tone: "success", text: "Mailbox reconnected. Syncing resumes where it left off." },
  gmail_disconnected: { tone: "info", text: "Mailbox disconnected. Access was revoked and the stored credentials were deleted. Messages already collected are kept." },
  gmail_denied: { tone: "warning", text: "Google did not grant access, so nothing was connected." },
  gmail_state: { tone: "danger", text: "That connection attempt could not be verified or has expired. Please start again." },
  gmail_scope: { tone: "danger", text: "Google did not grant read access to the mailbox, so nothing was connected." },
  gmail_no_refresh: { tone: "danger", text: "Google did not issue lasting access. Remove LoopSignal from the Google account's connected apps and try again." },
  gmail_failed: { tone: "danger", text: "The mailbox could not be connected. Please try again." },
  gmail_disabled: { tone: "warning", text: "The Gmail integration is turned off." },
  chat_claim_started: { tone: "info", text: "Request created. Add the LoopSignal Chat app to the space, post the code shown below in it, then press Verify." },
  chat_invalid_space: { tone: "danger", text: "That is not a Chat space name or link." },
  chat_already_bound: { tone: "warning", text: "That space is already connected." },
  chat_disabled: { tone: "warning", text: "The Google Chat integration is turned off." },
  chat_bound: { tone: "success", text: "Space connected. Its messages will be read from now on." },
  chat_code_not_seen: { tone: "warning", text: "The code was not found in that space yet. Post it there (the app must be a member), then verify again." },
  chat_app_not_in_space: { tone: "warning", text: "LoopSignal's Chat app cannot read that space. Add the app to the space and make sure your Workspace admin approved it, then verify again." },
  chat_claim_expired: { tone: "warning", text: "That request expired. Start a new one." },
  chat_claim_gone: { tone: "warning", text: "That request is no longer open." },
  chat_removed: { tone: "info", text: "Space disconnected. Messages already collected are kept." },
  chat_person_linked: { tone: "success", text: "Linked. Their future Chat messages count as your team's." },
  chat_person_unlinked: { tone: "info", text: "Unlinked." },
  chat_person_invalid: { tone: "danger", text: "That person or user could not be linked." },
  retention_saved: { tone: "success", text: "Retention windows saved. They apply at the next daily pass." },
  retention_invalid: { tone: "danger", text: "Those windows are not allowed. Raw payloads need at least 7 days, message bodies at least 90, and a raw payload cannot be kept longer than the body it copies." },
  sync_queued: { tone: "success", text: "Sync queued." },
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
  return o.reason === "NOT_OPEN" ? "review_not_open" : o.reason === "DECISION_REQUIRED" ? "decision_required" : "not_found";
}

export function noticeForCorrelation(o: CorrelationOutcome): NoticeKey {
  switch (o.outcome) {
    case "CONFIRMED": return "correlation_confirmed";
    case "REJECTED": return "correlation_rejected";
    case "SPLIT": return "correlation_split";
    case "REFUSED":
      return o.reason === "ALREADY_DECIDED" ? "correlation_decided" : o.reason === "TARGET_CLOSED" ? "correlation_target_closed"
        : o.reason === "THREAD_HAS_HISTORY" ? "correlation_split_blocked" : o.reason === "NOT_CONFIRMED" ? "correlation_not_confirmed" : "not_found";
  }
}
