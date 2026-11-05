import type { Role } from "../../../generated/prisma/enums";

/**
 * Authorization policy functions. Pure and deny-by-default: an action is allowed only when a rule below
 * explicitly grants it. Always evaluate server-side; never trust role claims from the client or a JWT.
 */
export type Action =
  | "org:manage" // org settings, memberships, role grants
  | "audit:view"
  | "report:view"
  | "team:manage"
  | "item:view"
  | "item:act" // assign, comment, propose resolution
  | "item:confirm" // RESOLUTION_CONFIRMED: human-only approval
  | "item:close"; // CLOSED: human-only approval

export interface Principal {
  userId: string;
  organizationId: string;
  /** Role from the user's Membership in the active organization. */
  orgRole: Role;
  /** Per-team roles from TeamMember rows, keyed by team id. */
  teamRoles: Readonly<Record<string, Role>>;
}

export interface Resource {
  organizationId: string;
  teamId?: string;
}

export interface PolicyOptions {
  /** Minimum team role to confirm or close, configured per organization. Default MEMBER. */
  approvalMinRole?: "MEMBER" | "TEAM_LEAD" | "ORG_ADMIN";
}

export class ForbiddenError extends Error {
  constructor(action: Action) {
    super(`Forbidden: ${action}`);
    this.name = "ForbiddenError";
  }
}

// AUDITOR is read-only and never ranks above VIEWER for item actions.
const RANK: Record<Role, number> = { VIEWER: 0, AUDITOR: 0, MEMBER: 1, TEAM_LEAD: 2, ORG_ADMIN: 3 };

/** Effective role on a team: the team role, capped at read-only for org-level VIEWER/AUDITOR. */
function effectiveTeamRank(p: Principal, teamId: string | undefined): number | undefined {
  if (!teamId) return undefined;
  const teamRole = p.teamRoles[teamId];
  if (!teamRole) return undefined;
  const rank = RANK[teamRole];
  return p.orgRole === "VIEWER" || p.orgRole === "AUDITOR" ? Math.min(rank, 0) : rank;
}

export function can(principal: Principal, action: Action, resource: Resource, options: PolicyOptions = {}): boolean {
  if (resource.organizationId !== principal.organizationId) return false; // tenant boundary first
  const { orgRole } = principal;
  if (orgRole === "ORG_ADMIN") return true;
  const teamRank = effectiveTeamRank(principal, resource.teamId);

  switch (action) {
    case "org:manage":
      return false;
    case "audit:view":
      return orgRole === "AUDITOR";
    case "report:view":
      return true; // any member of the org may see aggregate reporting
    case "team:manage":
      return orgRole === "TEAM_LEAD" && teamRank !== undefined && teamRank >= RANK.TEAM_LEAD;
    case "item:view":
      return orgRole === "AUDITOR" || (teamRank !== undefined && teamRank >= RANK.VIEWER);
    case "item:act":
      return teamRank !== undefined && teamRank >= RANK.MEMBER;
    case "item:confirm":
    case "item:close":
      return teamRank !== undefined && teamRank >= RANK[options.approvalMinRole ?? "MEMBER"];
    default:
      return false;
  }
}

export function assertCan(principal: Principal, action: Action, resource: Resource, options?: PolicyOptions): void {
  if (!can(principal, action, resource, options)) throw new ForbiddenError(action);
}
