import { withTenant } from "@/lib/db";
import { assertCan, type Principal } from "@/modules/identity";
import { recordAudit } from "@/modules/audit";

type Role = "ORG_ADMIN" | "TEAM_LEAD" | "MEMBER" | "VIEWER" | "AUDITOR";

/**
 * Membership and team mutations. Each one: checks authorization server-side, applies the change, and writes
 * its AuditLog row in the same transaction (rule 3), so a failed audit write rolls the change back.
 */
const ctxOf = (actor: Principal) => ({ organizationId: actor.organizationId, userId: actor.userId });
const auditActor = (actor: Principal) => ({
  organizationId: actor.organizationId, actorType: "USER" as const, actorId: actor.userId,
});

export async function addMembership(actor: Principal, input: { userId: string; role: Role }): Promise<void> {
  assertCan(actor, "org:manage", { organizationId: actor.organizationId });
  await withTenant(ctxOf(actor), async (tx) => {
    await tx.membership.create({ data: { organizationId: actor.organizationId, userId: input.userId, role: input.role } });
    await recordAudit(tx, {
      ...auditActor(actor), action: "membership.granted", entityType: "Membership", entityId: input.userId,
      metadata: { userId: input.userId, role: input.role },
    });
  });
}

export async function changeMembershipRole(actor: Principal, input: { userId: string; role: Role }): Promise<void> {
  assertCan(actor, "org:manage", { organizationId: actor.organizationId });
  await withTenant(ctxOf(actor), async (tx) => {
    const current = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: actor.organizationId, userId: input.userId } },
    });
    if (!current) throw new Error("Membership not found");
    if (current.role === "ORG_ADMIN" && input.role !== "ORG_ADMIN") {
      const admins = await tx.membership.count({ where: { role: "ORG_ADMIN" } });
      if (admins <= 1) throw new Error("Cannot remove the last ORG_ADMIN");
    }
    await tx.membership.update({
      where: { organizationId_userId: { organizationId: actor.organizationId, userId: input.userId } },
      data: { role: input.role },
    });
    await recordAudit(tx, {
      ...auditActor(actor), action: "membership.role_changed", entityType: "Membership", entityId: input.userId,
      metadata: { userId: input.userId, previousRole: current.role, role: input.role },
    });
  });
}

export async function createTeam(actor: Principal, input: { name: string }): Promise<{ id: string }> {
  assertCan(actor, "org:manage", { organizationId: actor.organizationId });
  return withTenant(ctxOf(actor), async (tx) => {
    const team = await tx.team.create({ data: { organizationId: actor.organizationId, name: input.name } });
    await recordAudit(tx, {
      ...auditActor(actor), action: "team.created", entityType: "Team", entityId: team.id, metadata: { name: input.name },
    });
    return { id: team.id };
  });
}

export async function addTeamMember(actor: Principal, input: { teamId: string; userId: string; role: Role }): Promise<void> {
  assertCan(actor, "team:manage", { organizationId: actor.organizationId, teamId: input.teamId });
  await withTenant(ctxOf(actor), async (tx) => {
    const isOrgMember = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId: actor.organizationId, userId: input.userId } },
    });
    if (!isOrgMember) throw new Error("User must be an organization member before joining a team");
    await tx.teamMember.create({
      data: { organizationId: actor.organizationId, teamId: input.teamId, userId: input.userId, role: input.role },
    });
    await recordAudit(tx, {
      ...auditActor(actor), action: "team.member_added", entityType: "Team", entityId: input.teamId,
      metadata: { userId: input.userId, role: input.role },
    });
  });
}
