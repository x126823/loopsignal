import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant } from "@/lib/db";
import { ForbiddenError, resolvePrincipal, type Principal } from "@/modules/identity";
import { verifyAuditChain } from "@/modules/audit";
import { addMembership, addTeamMember, changeMembershipRole, createOrganization, createTeam } from "@/modules/tenancy";
import { purgeOrgs, syntheticEmail } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const [admin, member, newcomer, outsider] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
let orgId = "";
let adminP: Principal;
let memberP: Principal;

const actions = async () =>
  (await owner.auditLog.findMany({ where: { organizationId: orgId }, orderBy: { seq: "asc" } })).map((r) => r.action);

beforeAll(async () => {
  await owner.user.createMany({ data: [admin, member, newcomer, outsider].map((id) => ({ id, email: syntheticEmail(id) })) });
  orgId = (await createOrganization({ name: "Mutation Org", adminUserId: admin })).id;
  adminP = (await resolvePrincipal(admin, orgId))!;
  await addMembership(adminP, { userId: member, role: "MEMBER" });
  memberP = (await resolvePrincipal(member, orgId))!;
});

afterAll(async () => {
  await purgeOrgs(owner, [orgId]);
  await owner.user.deleteMany({ where: { id: { in: [admin, member, newcomer, outsider] } } });
  await owner.$disconnect();
});

describe("audited tenancy mutations", () => {
  it("records org creation and the admin grant, in order", async () => {
    expect((await actions()).slice(0, 3)).toEqual(["organization.created", "membership.granted", "membership.granted"]);
  });

  it("denies non-admins and writes nothing", async () => {
    const before = await actions();
    await expect(addMembership(memberP, { userId: newcomer, role: "MEMBER" })).rejects.toThrow(ForbiddenError);
    await expect(createTeam(memberP, { name: "Nope" })).rejects.toThrow(ForbiddenError);
    await expect(changeMembershipRole(memberP, { userId: member, role: "ORG_ADMIN" })).rejects.toThrow(ForbiddenError);
    expect(await actions()).toEqual(before);
    expect(await owner.membership.count({ where: { organizationId: orgId, userId: newcomer } })).toBe(0);
  });

  it("cannot attach a member to another organization's team (composite FK + RLS)", async () => {
    const foreignTeam = await owner.team.create({ data: { organizationId: (await createOrganization({ name: "Foreign", adminUserId: outsider })).id, name: "Elsewhere" } });
    const before = await actions();
    await expect(addTeamMember(adminP, { teamId: foreignTeam.id, userId: member, role: "MEMBER" })).rejects.toThrow();
    expect(await actions()).toEqual(before);
    await purgeOrgs(owner, [foreignTeam.organizationId]);
  });

  it("creates teams, adds members, and audits each step", async () => {
    const { id: teamId } = await createTeam(adminP, { name: "Support" });
    await addTeamMember(adminP, { teamId, userId: member, role: "MEMBER" });
    const log = await actions();
    expect(log.slice(-2)).toEqual(["team.created", "team.member_added"]);
    expect(await owner.teamMember.count({ where: { teamId, userId: member } })).toBe(1);
  });

  it("requires org membership before joining a team", async () => {
    const { id: teamId } = await createTeam(adminP, { name: "Billing" });
    await expect(addTeamMember(adminP, { teamId, userId: outsider, role: "MEMBER" })).rejects.toThrow(/organization member/);
  });

  it("audits role changes with the previous role", async () => {
    await changeMembershipRole(adminP, { userId: member, role: "TEAM_LEAD" });
    const last = (await owner.auditLog.findMany({ where: { organizationId: orgId }, orderBy: { seq: "desc" }, take: 1 }))[0]!;
    expect(last.action).toBe("membership.role_changed");
    expect(last.metadata).toEqual({ userId: member, previousRole: "MEMBER", role: "TEAM_LEAD" });
    expect(last.actorId).toBe(admin);
  });

  it("refuses to remove the last ORG_ADMIN, and rolls back cleanly", async () => {
    const before = await actions();
    await expect(changeMembershipRole(adminP, { userId: admin, role: "MEMBER" })).rejects.toThrow(/last ORG_ADMIN/);
    expect(await actions()).toEqual(before);
    expect((await owner.membership.findFirstOrThrow({ where: { organizationId: orgId, userId: admin } })).role).toBe("ORG_ADMIN");
  });

  it("leaves an intact hash chain after all of the above", async () => {
    expect(await withTenant({ organizationId: orgId }, (tx) => verifyAuditChain(tx, orgId))).toEqual({ intact: true });
  });
});
