import type { ItemState } from "../../generated/prisma/enums";

/** Human wording for states, transitions and actors. Kept in one place so the UI says the same thing everywhere. */
export const STATE_LABEL: Record<ItemState, string> = {
  RECEIVED: "Received",
  ACKNOWLEDGED: "Acknowledged",
  RESPONDED: "Responded",
  IN_PROGRESS: "In progress",
  RESOLUTION_PROPOSED: "Resolution proposed",
  RESOLUTION_CONFIRMED: "Resolution confirmed",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

export const STATE_TONE: Record<ItemState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  RECEIVED: "neutral",
  ACKNOWLEDGED: "info",
  RESPONDED: "info",
  IN_PROGRESS: "info",
  RESOLUTION_PROPOSED: "warning",
  RESOLUTION_CONFIRMED: "success",
  CLOSED: "neutral",
  REOPENED: "danger",
};

/** What a request to move to this state means to a person. */
export const TRANSITION_LABEL: Partial<Record<ItemState, string>> = {
  RESOLUTION_PROPOSED: "Propose resolution",
  RESOLUTION_CONFIRMED: "Confirm resolution",
  CLOSED: "Close item",
  REOPENED: "Reopen item",
  IN_PROGRESS: "Mark in progress",
};

export const REVIEW_TYPE_LABEL: Record<string, string> = {
  LOW_CONFIDENCE: "Low confidence",
  CORRELATION: "Possible duplicate",
  SCHEMA_FAILURE: "Could not process",
  OWNERSHIP: "Needs an owner",
};

export const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

/** Deterministic, timezone-explicit date text (UTC), so server and test output never depend on the machine's locale. */
export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function describeActor(e: { actorType: "USER" | "SYSTEM" | "ANALYZER"; actorLabel: string | null }): string {
  if (e.actorType === "USER") return e.actorLabel ?? "A person";
  if (e.actorType === "ANALYZER") return `AI recommendation${e.actorLabel ? ` (${e.actorLabel.replace(/_/g, " ")})` : ""}`;
  return "System";
}

export const PROVIDER_LABEL: Record<string, string> = { GMAIL: "Gmail", GOOGLE_CHAT: "Google Chat", SYNTHETIC: "Synthetic source" };
export const SIGNAL_LABEL: Record<string, string> = { time: "Timing", sender: "Sender", reference: "Reference numbers", text: "Wording" };
