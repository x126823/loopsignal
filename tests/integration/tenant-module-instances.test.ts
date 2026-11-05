import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { purgeOrgs } from "../helpers/fixtures";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";

/**
 * Regression: Next.js can load the data layer more than once (separately bundled routes and server actions). The scoped client
 * is cached on globalThis and shared by every copy, so the tenant context must be shared too. Before the fix, a copy other than
 * the one that created the client saw an empty context and threw "Database access outside a tenant context", which surfaced as
 * intermittent failed sign-ins.
 */
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;

beforeAll(async () => {
  f = await createEngineFixture(owner);
});
afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
  await owner.$disconnect();
});

describe("the data layer loaded as more than one module instance", () => {
  it("keeps the tenant context working in every copy", async () => {
    const first = await import("@/lib/db/tenant");
    expect((await first.withTenant({ organizationId: f.organizationId }, (tx) => tx.team.findMany())).length).toBe(2); // creates and caches the client

    vi.resetModules(); // a second, independent copy of the module, as a separately bundled route would have
    const second = await import("@/lib/db/tenant");
    expect(second).not.toBe(first);
    const teams = await second.withTenant({ organizationId: f.organizationId }, (tx) => tx.team.findMany());
    expect(teams.map((t) => t.organizationId)).toEqual([f.organizationId, f.organizationId]);

    vi.resetModules();
    const third = await import("@/lib/db/tenant");
    expect((await third.withTenant({ userId: f.users.member }, (tx) => tx.membership.findMany())).length).toBeGreaterThan(0);
  });

  it("still refuses access with no context in any copy", async () => {
    vi.resetModules();
    const copy = await import("@/lib/db/tenant");
    await expect(copy.withTenant({}, async () => 1)).rejects.toThrow(); // an empty context is invalid
  });
});
