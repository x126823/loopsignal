import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { resolvePrincipal } from "@/modules/identity";
import { can } from "@/modules/identity";
import { findUserByEmail } from "@/modules/identity/users";
import { createOrganization, listTeams, listUserOrganizations } from "@/modules/tenancy";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);

const admin = randomUUID();
const member = randomUUID();
const outsider = randomUUID();
const email = (id: string) => `u-${id}@synthetic.loopsignal.test`;
let orgId = "";
let otherOrgId = "";
let teamId = "";

beforeAll(async () => {
  await owner.user.createMany({ data: [admin, member, outsider].map((id) => ({ id, email: email(id) })) });
  orgId = (await createOrganization({ name: "Test Org", adminUserId: admin })).id;
  otherOrgId = (await createOrganization({ name: "Other Org", adminUserId: outsider })).id;
  teamId = (await owner.team.create({ data: { organizationId: orgId, name: "Support" } })).id;
  await owner.membership.create({ data: { organizationId: orgId, userId: member, role: "MEMBER" } });
  await owner.teamMember.create({ data: { organizationId: orgId, teamId, userId: member, role: "MEMBER" } });
});

afterAll(async () => {
  const orgs = [orgId, otherOrgId];
  await owner.teamMember.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.team.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.membership.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.user.deleteMany({ where: { id: { in: [admin, member, outsider] } } });
  await owner.organization.deleteMany({ where: { id: { in: orgs } } });
  await owner.$disconnect();
});

describe("resolvePrincipal", () => {
  it("builds the principal from Membership and TeamMember rows", async () => {
    const p = await resolvePrincipal(member, orgId);
    expect(p).toEqual({ userId: member, organizationId: orgId, orgRole: "MEMBER", teamRoles: { [teamId]: "MEMBER" } });
    expect(can(p!, "item:act", { organizationId: orgId, teamId })).toBe(true);
  });

  it("returns null for a user with no membership in that org (deny by default)", async () => {
    expect(await resolvePrincipal(outsider, orgId)).toBeNull();
    expect(await resolvePrincipal(member, otherOrgId)).toBeNull();
  });

  it("makes the creator of an organization its ORG_ADMIN", async () => {
    expect((await resolvePrincipal(admin, orgId))?.orgRole).toBe("ORG_ADMIN");
  });
});

describe("tenancy module", () => {
  it("lists only the caller's organizations and teams", async () => {
    expect((await listUserOrganizations(admin)).map((o) => o.id)).toEqual([orgId]);
    expect((await listTeams(orgId)).map((t) => t.id)).toEqual([teamId]);
    expect(await listTeams(otherOrgId)).toEqual([]);
  });
});

describe("sign-in lookup", () => {
  it("finds an existing user by email, case-insensitively", async () => {
    expect((await findUserByEmail(email(admin).toUpperCase()))?.id).toBe(admin);
  });

  it("never creates users: unknown emails return null (invite-only)", async () => {
    expect(await findUserByEmail("stranger@synthetic.loopsignal.test")).toBeNull();
    expect(await owner.user.count({ where: { email: "stranger@synthetic.loopsignal.test" } })).toBe(0);
  });
});
