import { withTenant } from "@/lib/db";
import type { Principal } from "./rbac";

/**
 * Build the authorization principal for a user in an organization from the database (never from the JWT).
 * Returns null when the user has no membership there, so callers deny by default.
 */
export async function resolvePrincipal(userId: string, organizationId: string): Promise<Principal | null> {
  return withTenant({ organizationId, userId }, async (tx) => {
    const membership = await tx.membership.findFirst({ where: { userId } });
    if (!membership) return null;
    const teams = await tx.teamMember.findMany({ where: { userId } });
    return {
      userId,
      organizationId,
      orgRole: membership.role,
      teamRoles: Object.fromEntries(teams.map((t) => [t.teamId, t.role])),
    };
  });
}
