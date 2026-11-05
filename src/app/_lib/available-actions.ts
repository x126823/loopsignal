import { can, type Principal } from "@/modules/identity";
import { TRANSITIONS } from "@/modules/lifecycle";
import type { ItemState } from "../../../generated/prisma/enums";

/**
 * Which transitions to OFFER a person for an item. This only decides which buttons to render; the engine independently
 * re-checks legality and permission on every submit, so a hidden or tampered control gains nothing. Built from the same
 * transition table and `can()` the engine uses, so the UI cannot drift from what will actually be allowed.
 */
export function availableTransitions(
  principal: Principal,
  item: { organizationId: string; state: ItemState; teamId: string },
  policy: { approvalMinRole?: "MEMBER" | "TEAM_LEAD" | "ORG_ADMIN" } = {},
): ItemState[] {
  // The tenant check compares the ITEM's organization with the principal's, so a principal from another organization gets nothing.
  const resource = { organizationId: item.organizationId, teamId: item.teamId };
  return TRANSITIONS.filter((r) => r.from === item.state && r.human && can(principal, r.action, resource, policy)).map((r) => r.to);
}

/** Button text for a person-initiated move from one state to another. */
export function transitionButtonLabel(from: ItemState, to: ItemState): string {
  if (from === "RESOLUTION_PROPOSED" && to === "IN_PROGRESS") return "Reject proposal";
  switch (to) {
    case "RESOLUTION_PROPOSED": return "Propose resolution";
    case "RESOLUTION_CONFIRMED": return "Confirm resolution";
    case "CLOSED": return "Close item";
    case "REOPENED": return "Reopen item";
    case "IN_PROGRESS": return "Mark in progress";
    default: return to;
  }
}

/** Whether this principal may decide a pending approval for `requested` on an item in `state`. */
export function canDecideApproval(
  principal: Principal,
  item: { organizationId: string; state: ItemState; teamId: string },
  requested: ItemState,
  policy: { approvalMinRole?: "MEMBER" | "TEAM_LEAD" | "ORG_ADMIN" } = {},
): boolean {
  return availableTransitions(principal, item, policy).includes(requested);
}
