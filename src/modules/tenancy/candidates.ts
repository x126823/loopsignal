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
