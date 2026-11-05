import type { ItemState } from "../../../generated/prisma/enums";
import type { Action } from "@/modules/identity";

/**
 * The transition table, as data. Source of truth: docs/ARCHITECTURE.md section 4. Anything not listed is illegal.
 *
 * Who may do what:
 *  - `automated`: SYSTEM or ANALYZER may apply it (the engine applies a rule-verified recommendation; analyzers
 *    never write state themselves).
 *  - `human`: an authorized USER may perform it, checked against `action`.
 *  - `suggestible`: automated actors may only *suggest* it, which queues an ApprovalRequest for a human.
 *    Confirmation, closure and reopening are never applied from AI or system inference (rule 2).
 */
export interface TransitionRule {
  readonly from: ItemState;
  readonly to: ItemState;
  readonly automated: boolean;
  readonly human: boolean;
  readonly suggestible: boolean;
  /** RBAC action a human needs on the item's team. */
  readonly action: Action;
}

const auto = (from: ItemState, to: ItemState): TransitionRule => ({ from, to, automated: true, human: false, suggestible: false, action: "item:act" });
const autoOrHuman = (from: ItemState, to: ItemState): TransitionRule => ({ from, to, automated: true, human: true, suggestible: false, action: "item:act" });
const humanOnly = (from: ItemState, to: ItemState, action: Action): TransitionRule => ({ from, to, automated: false, human: true, suggestible: true, action });

export const TRANSITIONS: readonly TransitionRule[] = [
  auto("RECEIVED", "ACKNOWLEDGED"),
  auto("RECEIVED", "RESPONDED"),
  auto("ACKNOWLEDGED", "RESPONDED"),
  auto("RECEIVED", "IN_PROGRESS"),
  auto("ACKNOWLEDGED", "IN_PROGRESS"),
  auto("RESPONDED", "IN_PROGRESS"),
  autoOrHuman("RESPONDED", "RESOLUTION_PROPOSED"),
  autoOrHuman("IN_PROGRESS", "RESOLUTION_PROPOSED"),
  // Added in Sprint 3 (not in the original table): a proposal that is rejected or contradicted by the customer
  // must have a way forward. Rejecting a pending confirmation uses this transition.
  autoOrHuman("RESOLUTION_PROPOSED", "IN_PROGRESS"),
  humanOnly("RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "item:confirm"),
  humanOnly("RESOLUTION_CONFIRMED", "CLOSED", "item:close"),
  humanOnly("CLOSED", "REOPENED", "item:act"),
  humanOnly("RESOLUTION_CONFIRMED", "REOPENED", "item:act"),
  auto("REOPENED", "ACKNOWLEDGED"),
  auto("REOPENED", "RESPONDED"),
  auto("REOPENED", "IN_PROGRESS"),
];

export const ITEM_STATES: readonly ItemState[] = [
  "RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED",
];

export function ruleFor(from: ItemState, to: ItemState): TransitionRule | undefined {
  return TRANSITIONS.find((r) => r.from === from && r.to === to);
}

/** Target states that always require a human decision. */
export const HUMAN_DECISION_STATES: ReadonlySet<ItemState> = new Set(["RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"]);

/** Placeholder until golden sets set real thresholds in Sprint 6; overridable per organization. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
