import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";

/** Create an organization and make `adminUserId` its ORG_ADMIN, atomically. */
export async function createOrganization(input: { name: string; adminUserId: string }): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  return withTenant({ organizationId: id, userId: input.adminUserId }, async (tx) => {
    const org = await tx.organization.create({ data: { id, name: input.name } });
    await tx.membership.create({ data: { organizationId: id, userId: input.adminUserId, role: "ORG_ADMIN" } });
    return { id: org.id, name: org.name };
  });
}

/** Organizations the user belongs to (org switcher). */
export async function listUserOrganizations(userId: string): Promise<Array<{ id: string; name: string; role: string }>> {
  return withTenant({ userId }, async (tx) => {
    const memberships = await tx.membership.findMany({ where: { userId } });
    const orgs = await tx.organization.findMany({ where: { id: { in: memberships.map((m) => m.organizationId) } } });
    const names = new Map(orgs.map((o) => [o.id, o.name]));
    return memberships.map((m) => ({ id: m.organizationId, name: names.get(m.organizationId) ?? "", role: m.role }));
  });
}

export async function listTeams(organizationId: string): Promise<Array<{ id: string; name: string }>> {
  return withTenant({ organizationId }, async (tx) => {
    const teams = await tx.team.findMany({ orderBy: { name: "asc" } });
    return teams.map((t) => ({ id: t.id, name: t.name }));
  });
}
