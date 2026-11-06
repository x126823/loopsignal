import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { listOpenReviewTasks, listOpenReviewTasksPage } from "@/modules/lifecycle";
import { createEngineFixture, createThreadWithMessage, type EngineFixture } from "../helpers/engine-fixture";
import { asLifecycleWriter, purgeOrgs } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 9, n));

beforeAll(async () => {
  f = await createEngineFixture(owner);
});
afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
  await owner.$disconnect();
});

async function task(teamId: string, minute: number, type: "OWNERSHIP" | "LOW_CONFIDENCE" | "CORRELATION" = "OWNERSHIP") {
  const { threadId, messageId } = await createThreadWithMessage(owner, f, `Task ${minute}`, minute);
  const item = await asLifecycleWriter(owner, (tx) => tx.trackedItem.create({ data: { organizationId: f.organizationId, teamId, originMessageId: messageId, threadId, title: `Item for task ${minute}` } }));
  return owner.reviewTask.create({ data: { organizationId: f.organizationId, type, refType: "TrackedItem", refId: item.id, createdAt: at(minute) } });
}

describe("the review queue is bounded", () => {
  it("returns the oldest tasks up to the limit, and says how many there are in all", async () => {
    const g = await createEngineFixture(owner);
    const ids: string[] = [];
    const make = async (minute: number) => {
      const { threadId, messageId } = await createThreadWithMessage(owner, g, `T${minute}`, minute);
      const item = await asLifecycleWriter(owner, (tx) => tx.trackedItem.create({ data: { organizationId: g.organizationId, teamId: g.teamId, originMessageId: messageId, threadId, title: `Item ${minute}` } }));
      ids.push((await owner.reviewTask.create({ data: { organizationId: g.organizationId, type: "OWNERSHIP", refType: "TrackedItem", refId: item.id, createdAt: at(minute) } })).id);
    };
    for (let m = 1; m <= 5; m++) await make(m);
    const page = await listOpenReviewTasksPage(g.principals.admin, { limit: 3 });
    expect(page.total).toBe(5);
    expect(page.tasks.map((t) => t.id)).toEqual(ids.slice(0, 3)); // oldest first
    expect((await listOpenReviewTasks(g.principals.admin, { limit: 2 })).map((t) => t.id)).toEqual(ids.slice(0, 2));
    expect((await listOpenReviewTasksPage(g.principals.admin)).tasks).toHaveLength(5); // the default is generous (100), not tiny
    await purgeOrgs(owner, [g.organizationId]);
    await owner.user.deleteMany({ where: { id: { in: Object.values(g.users) } } });
  });

  it("decides what a person may see BEFORE cutting, and never counts what they may not see", async () => {
    // Three older tasks belong to the other team; one newer task belongs to the member's own team.
    for (const m of [10, 11, 12]) await task(f.otherTeamId, m);
    const mine = await task(f.teamId, 13);
    const page = await listOpenReviewTasksPage(f.principals.member, { limit: 1 });
    expect(page.tasks.map((t) => t.id)).toEqual([mine.id]); // not pushed out by tasks they cannot see
    expect(page.total).toBe(1); // and the three hidden tasks are not revealed by the count
    const other = await listOpenReviewTasksPage(f.principals.otherTeamMember, { limit: 100 });
    expect(other.total).toBe(3);
    expect(other.tasks.every((t) => t.itemTitle !== null && /task 1[012]$/.test(t.itemTitle))).toBe(true);
    expect((await listOpenReviewTasksPage(f.principals.admin)).total).toBeGreaterThanOrEqual(4); // administrators see everything
  });

  it("can leave cross-channel questions out, and shows nothing to people who may not read the queue", async () => {
    const corr = await task(f.teamId, 20, "CORRELATION");
    const all = await listOpenReviewTasksPage(f.principals.admin, { limit: 500 });
    const without = await listOpenReviewTasksPage(f.principals.admin, { limit: 500, excludeCorrelation: true });
    expect(all.tasks.some((t) => t.id === corr.id)).toBe(true);
    expect(without.tasks.some((t) => t.id === corr.id)).toBe(false);
    expect(without.total).toBe(all.total - 1);
    expect(await listOpenReviewTasksPage(f.principals.viewer)).toEqual({ tasks: [], total: 0 });
    expect((await listOpenReviewTasksPage(f.principals.auditor)).total).toBeGreaterThan(0); // auditors may read it
  });

  it("clamps an absurd limit instead of returning everything", async () => {
    const g = await createEngineFixture(owner);
    await owner.reviewTask.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ organizationId: g.organizationId, type: "LOW_CONFIDENCE" as const, refType: "Message", refId: randomUUID(), createdAt: at(i % 50) })) });
    const huge = await listOpenReviewTasksPage(g.principals.admin, { limit: 10_000_000 });
    expect(huge.tasks).toHaveLength(500); // the ceiling
    expect(huge.total).toBe(600);
    expect((await listOpenReviewTasksPage(g.principals.admin, { limit: -4 })).tasks).toHaveLength(1); // the floor
    expect((await listOpenReviewTasksPage(g.principals.admin)).tasks).toHaveLength(100); // the default
    await purgeOrgs(owner, [g.organizationId]);
    await owner.user.deleteMany({ where: { id: { in: Object.values(g.users) } } });
  });
});
