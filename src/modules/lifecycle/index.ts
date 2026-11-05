// Public API of the lifecycle module. Other modules import only from here.
// This module is the sole writer of TrackedItem state and the four metrics (CLAUDE.md rule 1).
export { apply, assignOwner, createItem, decideApproval, propose, verifyItemMetrics, type DecisionOutcome, type OwnerOutcome } from "./engine";
export {
  canResolveReviewTasks, findThreadItem, getApprovalPolicy, getItemDetail, listOpenItemIds, listOpenReviewTasks, loadItemForSla, listPendingApprovals, listVisibleItems, queueReviewTask, resolveReviewTask,
  type ApprovalView, type ItemDetail, type ItemEventView, type ItemForSla, type ItemSummary, type PendingApproval, type ReviewKind, type ReviewResolveOutcome, type ReviewTaskView, type ThreadItem,
} from "./queries";
export { deriveMetrics, type DerivedItem, type EventForMetrics } from "./metrics";
export { DEFAULT_CONFIDENCE_THRESHOLD, HUMAN_DECISION_STATES, ITEM_STATES, ruleFor, TRANSITIONS, type TransitionRule } from "./transitions";
export {
  LifecycleConflictError,
  type Actor, type AutomatedActor, type CreateItemOutcome, type CreateItemRequest, type EngineOptions, type EvidenceQuote,
  type HumanActor, type Outcome, type RejectionReason, type ReviewReason, type TransitionRequest,
} from "./types";
