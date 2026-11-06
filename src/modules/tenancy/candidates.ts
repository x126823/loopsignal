import { withTenant } from "@/lib/db";

export interface TeamCandidate {
  /** The user's id. */
  id: string;
  /** Display name, or the email's local part when there is none. */
  name: string;
  /** The email's local part, used for @mentions. Never the full address. */
  handle: string;
}

/**
 * People who can own work for a team, for the ownership resolver. Deliberately minimal: a name and a mention handle,
 * not the email address, since this is sent to the model (data minimization). Viewers and auditors cannot own items.
 */
export async function listTeamCandidates(organizationId: string, teamId: string): Promise<TeamCandidate[]> {
  return withTenant({ organizationId }, async (tx) => {
    const members = await tx.teamMember.findMany({ where: { teamId, role: { in: ["MEMBER", "TEAM_LEAD", "ORG_ADMIN"] } }, include: { user: true } });
    return members
      .map((m) => {
        const handle = m.user.email.split("@")[0] ?? m.user.email;
        return { id: m.userId, name: m.user.name ?? handle, handle };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  });
}

/**
 * User ids who may act on a team's work, for notifications: team members with a role that can act (or only team leads), whose
 * organization role is not read-only, plus organization administrators. Ids only. Mirrors the rules in `identity.can`.
 */
export async function listTeamActors(organizationId: string, teamId: string, opts: { leadsOnly?: boolean } = {}): Promise<string[]> {
  return withTenant({ organizationId }, async (tx) => {
    const members = await tx.teamMember.findMany({ where: { teamId, role: { in: opts.leadsOnly ? ["TEAM_LEAD"] : ["MEMBER", "TEAM_LEAD"] } }, select: { userId: true } });
    const admins = await tx.membership.findMany({ where: { role: "ORG_ADMIN" }, select: { userId: true } });
    const memberships = await tx.membership.findMany({ where: { userId: { in: members.map((m) => m.userId) }, role: { notIn: ["VIEWER", "AUDITOR"] } }, select: { userId: true } });
    return [...new Set([...memberships.map((m) => m.userId), ...admins.map((a) => a.userId)])].sort();
  });
}

export interface OrgUser { id: string; name: string }

/**
 * Everyone who can own work in the organization (not viewers or auditors), by display name only (no email), for an admin choosing
 * which LoopSignal user a Chat person is. The caller authorizes; this lists names.
 */
export async function listOrganizationUsers(organizationId: string): Promise<OrgUser[]> {
  return withTenant({ organizationId }, async (tx) => {
    const members = await tx.membership.findMany({ where: { role: { in: ["MEMBER", "TEAM_LEAD", "ORG_ADMIN"] } }, include: { user: true } });
    return members.map((m) => ({ id: m.userId, name: m.user.name ?? m.user.email.split("@")[0] ?? m.userId })).sort((a, b) => a.name.localeCompare(b.name));
  });
}
