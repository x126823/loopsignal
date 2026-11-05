import type { ItemState, Priority } from "../../../generated/prisma/enums";
import type { Principal } from "@/modules/identity";

/**
 * Actors. Analyzers never write state: an ANALYZER actor is the attribution for a recommendation that the
 * engine validated and applied (or queued). Only USER actors can perform human-only transitions.
 */
export type AutomatedActor =
  | { type: "SYSTEM"; id?: string }
  | { type: "ANALYZER"; analyzer: string; analysisRunId: string };
export type HumanActor = { type: "USER"; principal: Principal };
export type Actor = AutomatedActor | HumanActor;

export interface EvidenceQuote {
  /** Must be a verbatim substring of the triggering message (rule 6). */
  quote: string;
}

export interface TransitionRequest {
  organizationId: string;
  itemId: string;
  to: ItemState;
  actor: Actor;
  /** When it happened (for message-triggered steps, the message's sentAt), not when it was processed. */
  occurredAt: Date;
  /** Message that triggered the step. It is linked to the item with a role matching the target state. */
  messageId?: string;
  /** Analyzer confidence in [0, 1]. Required for ANALYZER actors. */
  confidence?: number;
  /** Required for ANALYZER actors; each quote is verified against the message body. */
  evidence?: EvidenceQuote[];
  reason?: string;
  /** Optimistic concurrency: fail with STALE_VERSION if the item has moved on. */
  expectedVersion?: number;
}

export type RejectionReason =
  | "NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "INVALID_ACTOR"
  | "OUT_OF_ORDER"
  | "FUTURE_TIMESTAMP"
  | "STALE_VERSION"
  | "NOT_PENDING"
  | "THREAD_HAS_OPEN_ITEM";

export type ReviewReason =
  | "LOW_CONFIDENCE"
  | "MISSING_CONFIDENCE"
  | "MISSING_EVIDENCE"
  | "EVIDENCE_NOT_VERBATIM"
  | "UNKNOWN_ANALYSIS_RUN";

export type Outcome =
  | { outcome: "APPLIED"; itemId: string; fromState: ItemState; toState: ItemState; version: number; eventId: string; idempotent?: true }
  | { outcome: "APPROVAL_REQUIRED"; approvalRequestId: string }
  | { outcome: "NEEDS_REVIEW"; reviewTaskId: string; reason: ReviewReason }
  | { outcome: "NOOP"; reason: "ALREADY_IN_STATE" }
  | { outcome: "REJECTED"; reason: RejectionReason };

export interface CreateItemRequest {
  organizationId: string;
  teamId: string;
  originMessageId: string;
  threadId: string;
  title: string;
  priority?: Priority;
  ownerUserId?: string;
  slaPolicyId?: string;
  occurredAt: Date;
  actor: AutomatedActor;
  /** Analyzer confidence. Below the threshold the item is still created, flagged for review. */
  confidence?: number;
  reason?: string;
}

export type CreateItemOutcome =
  | { outcome: "CREATED"; itemId: string; needsReview: boolean }
  | { outcome: "EXISTS"; itemId: string }
  | { outcome: "REJECTED"; reason: "MESSAGE_NOT_FOUND" | "FUTURE_TIMESTAMP" };

export interface EngineOptions {
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** Key for decrypting message bodies when verifying evidence. Defaults to FIELD_ENCRYPTION_KEY. */
  fieldKey?: Buffer;
}

/** Thrown when a concurrent writer won a race. The surrounding transaction rolls back; callers may retry. */
export class LifecycleConflictError extends Error {
  constructor(message = "Concurrent lifecycle update; retry") {
    super(message);
    this.name = "LifecycleConflictError";
  }
}
