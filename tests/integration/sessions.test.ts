import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { getSessionsValidAfter, revokeMemberSessions, revokeOwnSessions } from "@/modules/identity";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { purgeOrgs } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const app = createPrismaClient(process.env["APP_DATABASE_URL"]!);
let f: EngineFixture;
let g: EngineFixture;
const T = new Date("2027-01-02T03:04:05.000Z");
const validAfter = (id: string) => owner.user.findUniqueOrThrow({ where: { id }, select: { sessionsValidAfter: true } }).then((u) => u.sessionsValidAfter);

beforeAll(async () => {
  f = await createEngineFixture(owner);
  g = await createEngineFixture(owner);
});
afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId, g.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [...Object.values(f.users), ...Object.values(g.users)] } } });
  await owner.$disconnect();
  await app.$disconnect();
});

describe("ending your own sessions", () => {
  it("records the moment, for you and nobody else, and audits it", async () => {
    expect(await getSessionsValidAfter(f.users.member)).toBeNull();
    await revokeOwnSessions(f.principals.member, T);
    expect(await getSessionsValidAfter(f.users.member)).toEqual(T);
    expect(await validAfter(f.users.lead)).toBeNull();
    expect(await validAfter(g.users.member)).toBeNull();
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "session.revoked_self", entityId: f.users.member } })).toMatchObject({ actorId: f.users.member, actorType: "USER" });
  });

  it("can only ever change your own row, whatever is asked at the database layer", async () => {
    const before = await validAfter(f.users.lead);
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true), set_config('app.user_id', ${f.users.member}, true)`;
      return tx.$executeRaw`UPDATE "User" SET "sessionsValidAfter" = now() WHERE id = ${f.users.lead}::uuid`; // someone else's row, as the member
    });
    expect(rows).toBe(0); // row-level security: not visible, not changed
    expect(await validAfter(f.users.lead)).toEqual(before);
  });
});

describe("an administrator ending a member's sessions", () => {
  it("works for a member of the organization, and is audited against the administrator", async () => {
    expect(await revokeMemberSessions(f.principals.admin, f.users.viewer, T)).toBe("REVOKED");
    expect(await validAfter(f.users.viewer)).toEqual(T);
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "session.revoked", entityId: f.users.viewer } })).toMatchObject({ actorId: f.users.admin, actorType: "USER" });
  });

  it("is refused for everyone who is not an administrator, at the module and at the database", async () => {
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(revokeMemberSessions(f.principals[who], f.users.otherTeamMember, T), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    expect(await validAfter(f.users.otherTeamMember)).toBeNull();
    // Skipping the module and calling the function directly as a non-administrator is refused by the function itself.
    await expect(app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true), set_config('app.user_id', ${f.users.member}, true)`;
      await tx.$queryRaw`SELECT revoke_member_sessions(${f.organizationId}::uuid, ${f.users.otherTeamMember}::uuid, ${T}::timestamptz)`;
    })).rejects.toThrow(/administrator/);
    expect(await validAfter(f.users.otherTeamMember)).toBeNull();
  });

  it("will not touch a person who is not a member of the organization, or an organization that is not the caller's", async () => {
    expect(await revokeMemberSessions(f.principals.admin, g.users.member, T)).toBe("NOT_A_MEMBER"); // another organization's member
    expect(await revokeMemberSessions(f.principals.admin, randomUUID(), T)).toBe("NOT_A_MEMBER");
    expect(await validAfter(g.users.member)).toBeNull();
    await expect(app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true), set_config('app.user_id', ${f.users.admin}, true)`;
      await tx.$queryRaw`SELECT revoke_member_sessions(${g.organizationId}::uuid, ${g.users.member}::uuid, ${T}::timestamptz)`; // asks about ANOTHER organization
    })).rejects.toThrow(/tenant context/);
    await expect(app.$queryRaw`SELECT revoke_member_sessions(${f.organizationId}::uuid, ${f.users.member}::uuid, ${T}::timestamptz)`).rejects.toThrow(); // no context at all
    expect(await validAfter(g.users.member)).toBeNull();
  });

  it("an administrator of another organization cannot use their role here", async () => {
    await expect(revokeMemberSessions({ ...g.principals.admin, organizationId: f.organizationId }, f.users.member, new Date("2028-01-01T00:00:00Z"))).rejects.toThrow();
    expect(await validAfter(f.users.member)).toEqual(T); // unchanged from the earlier revocation
  });
});
