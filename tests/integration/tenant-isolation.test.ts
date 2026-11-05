import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant } from "@/lib/db";

// Owner connection (bypasses RLS): fixture setup and cleanup only.
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
// Raw app-role connection, NO extension: proves RLS alone fails closed.
const raw = createPrismaClient(process.env["APP_DATABASE_URL"]!);

const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const userBoth = randomUUID();
const emailA = `a-${userA}@synthetic.loopsignal.test`;
let teamA = "";
let teamB = "";

/** Run a callback on the raw app-role client with RLS settings but without the Prisma extension. */
async function rawWith<T>(
  s: { org?: string; user?: string; email?: string },
  fn: (tx: Parameters<Parameters<typeof raw.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${s.org ?? ""}, true),
      set_config('app.user_id', ${s.user ?? ""}, true), set_config('app.login_email', ${s.email ?? ""}, true)`;
    return fn(tx);
  });
}

beforeAll(async () => {
  await owner.organization.createMany({ data: [{ id: orgA, name: "Org A" }, { id: orgB, name: "Org B" }] });
  await owner.user.createMany({
    data: [
      { id: userA, email: emailA },
      { id: userB, email: `b-${userB}@synthetic.loopsignal.test` },
      { id: userBoth, email: `both-${userBoth}@synthetic.loopsignal.test` },
    ],
  });
  await owner.membership.createMany({
    data: [
      { organizationId: orgA, userId: userA, role: "MEMBER" },
      { organizationId: orgB, userId: userB, role: "MEMBER" },
      { organizationId: orgA, userId: userBoth, role: "VIEWER" },
      { organizationId: orgB, userId: userBoth, role: "TEAM_LEAD" },
    ],
  });
  teamA = (await owner.team.create({ data: { organizationId: orgA, name: "Team A" } })).id;
  teamB = (await owner.team.create({ data: { organizationId: orgB, name: "Team B" } })).id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  const users = [userA, userB, userBoth];
  await owner.teamMember.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.team.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.membership.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.user.deleteMany({ where: { id: { in: users } } });
  await owner.organization.deleteMany({ where: { id: { in: orgs } } });
  await owner.$disconnect();
  await raw.$disconnect();
});

describe("runtime database role", () => {
  it("is not a superuser, not BYPASSRLS, and owns no tenant table", async () => {
    const [role] = await raw.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await raw.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`;
    expect(owned).toEqual([]);
  });
});

describe("RLS alone (no Prisma extension)", () => {
  it("returns no rows when no tenant settings are set", async () => {
    const [teams, members, orgs, users] = await Promise.all([
      raw.team.findMany(), raw.membership.findMany(), raw.organization.findMany(), raw.user.findMany(),
    ]);
    expect([teams, members, orgs, users].map((r) => r.length)).toEqual([0, 0, 0, 0]);
  });

  it("scopes reads to the active organization", async () => {
    const teams = await rawWith({ org: orgA }, (tx) => tx.team.findMany());
    expect(teams.map((t) => t.id)).toEqual([teamA]);
  });

  it("rejects inserting a row for another organization", async () => {
    await expect(
      rawWith({ org: orgA }, (tx) => tx.team.create({ data: { organizationId: orgB, name: "Injected" } })),
    ).rejects.toThrow();
  });

  it("cannot update or delete another organization's rows (zero rows affected)", async () => {
    const updated = await rawWith({ org: orgA }, (tx) =>
      tx.team.updateMany({ where: { id: teamB }, data: { name: "Hacked" } }));
    const deleted = await rawWith({ org: orgA }, (tx) => tx.team.deleteMany({ where: { id: teamB } }));
    expect([updated.count, deleted.count]).toEqual([0, 0]);
    expect((await owner.team.findUniqueOrThrow({ where: { id: teamB } })).name).toBe("Team B");
  });

  it("rejects a malformed org setting instead of widening access", async () => {
    await expect(rawWith({ org: "not-a-uuid" }, (tx) => tx.team.findMany())).rejects.toThrow();
  });

  it("limits the Organization table to the active org or the user's own orgs", async () => {
    expect((await rawWith({ org: orgA }, (tx) => tx.organization.findMany())).map((o) => o.id)).toEqual([orgA]);
    const own = await rawWith({ user: userBoth }, (tx) => tx.organization.findMany());
    expect(own.map((o) => o.id).sort()).toEqual([orgA, orgB].sort());
  });

  it("hides users who share no organization with the caller", async () => {
    const visible = await rawWith({ org: orgA }, (tx) => tx.user.findMany({ where: { id: { in: [userA, userB, userBoth] } } }));
    expect(visible.map((u) => u.id).sort()).toEqual([userA, userBoth].sort());
  });

  it("allows the sign-in email lookup to see exactly that user", async () => {
    const found = await rawWith({ email: emailA }, (tx) => tx.user.findMany());
    expect(found.map((u) => u.id)).toEqual([userA]);
  });

  it("only lets a user insert or update their own User row", async () => {
    await expect(
      rawWith({ user: userA }, (tx) => tx.user.create({ data: { id: randomUUID(), email: "evil@synthetic.loopsignal.test" } })),
    ).rejects.toThrow();
    const changed = await rawWith({ user: userA }, (tx) =>
      tx.user.updateMany({ where: { id: userB }, data: { name: "Hacked" } }));
    expect(changed.count).toBe(0);
  });
});

describe("schema integrity", () => {
  it("rejects a TeamMember that references another organization's team", async () => {
    await expect(
      owner.teamMember.create({ data: { organizationId: orgA, teamId: teamB, userId: userA } }),
    ).rejects.toThrow();
  });
});

describe("withTenant (extension + RLS)", () => {
  it("refuses an empty or malformed context", async () => {
    await expect(withTenant({}, async () => 1)).rejects.toThrow();
    await expect(withTenant({ organizationId: "nope" }, async () => 1)).rejects.toThrow();
  });

  it("refuses org-scoped models when only a user is known (except own memberships)", async () => {
    await expect(withTenant({ userId: userA }, (tx) => tx.team.findMany())).rejects.toThrow(/organizationId/);
    const own = await withTenant({ userId: userBoth }, (tx) => tx.membership.findMany());
    expect(own.map((m) => m.organizationId).sort()).toEqual([orgA, orgB].sort());
  });

  it("scopes reads and unique lookups to the organization", async () => {
    const teams = await withTenant({ organizationId: orgA }, (tx) => tx.team.findMany());
    expect(teams.map((t) => t.id)).toEqual([teamA]);
    expect(await withTenant({ organizationId: orgA }, (tx) => tx.team.findUnique({ where: { id: teamB } }))).toBeNull();
  });

  it("rejects writes naming another organization and cannot reach its rows", async () => {
    await expect(
      withTenant({ organizationId: orgA }, (tx) => tx.team.create({ data: { organizationId: orgB, name: "X" } })),
    ).rejects.toThrow(/Cross-tenant/);
    await expect(
      withTenant({ organizationId: orgA }, (tx) => tx.team.update({ where: { id: teamB }, data: { name: "X" } })),
    ).rejects.toThrow();
    await expect(
      withTenant({ organizationId: orgA }, (tx) => tx.team.updateMany({ where: {}, data: { organizationId: orgB } })),
    ).rejects.toThrow(/Cross-tenant/);
  });

  it("stamps the organization on creates and keeps them readable only by that tenant", async () => {
    const created = await withTenant({ organizationId: orgA }, (tx) =>
      tx.team.create({ data: { organizationId: orgA, name: "Created in A" } }));
    expect(await withTenant({ organizationId: orgB }, (tx) => tx.team.findUnique({ where: { id: created.id } }))).toBeNull();
    expect(await withTenant({ organizationId: orgA }, (tx) => tx.team.count())).toBe(2);
  });

  it("counts and aggregates only within the tenant", async () => {
    expect(await withTenant({ organizationId: orgB }, (tx) => tx.membership.count())).toBe(2);
  });
});
