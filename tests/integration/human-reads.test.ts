import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant } from "@/lib/db";
import { ForbiddenError, type Principal } from "@/modules/identity";
import { loadThreadMessages } from "@/modules/ingestion";
import { listItemAnalysis } from "@/modules/intelligence";
import {
  apply, assignOwner, createItem, getItemDetail, listOpenReviewTasks, listPendingApprovals, listVisibleItems, propose, queueReviewTask, resolveReviewTask,
} from "@/modules/lifecycle";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { at, createAnalysisRun, createEngineFixture, createMessage, createThreadWithMessage, engineOpts, type EngineFixture } from "../helpers/engine-fixture";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;
let g: EngineFixture;
let clock = 10;
const tick = () => at(++clock);
const SYSTEM = { type: "SYSTEM" as const };

async function item(fx: EngineFixture, teamId: string, title: string) {
  const { threadId, messageId } = await createThreadWithMessage(owner, fx, `Message for ${title}`, 0);
  const out = await withTenant({ organizationId: fx.organizationId }, (tx) =>
    createItem(tx, { organizationId: fx.organizationId, teamId, originMessageId: messageId, threadId, title, occurredAt: tick(), actor: SYSTEM }, engineOpts));
  if (out.outcome !== "CREATED") throw new Error("not created");
  await owner.trackedItem.update({ where: { id: out.itemId }, data: { title } }).catch(() => undefined);
  return { itemId: out.itemId, threadId, messageId };
}
const as = (fx: EngineFixture, to: "RESPONDED" | "RESOLUTION_PROPOSED", itemId: string) =>
  withTenant({ organizationId: fx.organizationId }, (tx) => propose(tx, { organizationId: fx.organizationId, itemId, to, occurredAt: tick(), actor: SYSTEM }, engineOpts));

let supportItem: Awaited<ReturnType<typeof item>>;
let billingItem: Awaited<ReturnType<typeof item>>;
let foreignItem: Awaited<ReturnType<typeof item>>;

beforeAll(async () => {
  f = await createEngineFixture(owner);
  g = await createEngineFixture(owner);
  await owner.user.update({ where: { id: f.users.lead }, data: { name: "Bob Lead" } });
  await owner.user.update({ where: { id: f.users.member }, data: { name: "Carol Member" } });
  supportItem = await item(f, f.teamId, "Support item");
  billingItem = await item(f, f.otherTeamId, "Billing item");
  foreignItem = await item(g, g.teamId, "Foreign item");
});

afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId, g.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [...Object.values(f.users), ...Object.values(g.users)] } } });
  await owner.$disconnect();
});

describe("listVisibleItems", () => {
  const ids = async (p: Principal, opts = {}) => (await listVisibleItems(p, opts)).map((i) => i.id).sort();
  const both = [supportItem?.itemId, billingItem?.itemId];

  it("shows admins and auditors every item in their organization, and team members only their team's", async () => {
    const all = [supportItem.itemId, billingItem.itemId].sort();
    expect(await ids(f.principals.admin)).toEqual(all);
    expect(await ids(f.principals.auditor)).toEqual(all);
    for (const who of ["lead", "member", "viewer"] as const) expect(await ids(f.principals[who]), who).toEqual([supportItem.itemId]);
    expect(await ids(f.principals.otherTeamMember)).toEqual([billingItem.itemId]);
    void both;
  });

  it("never includes another organization's items", async () => {
    for (const p of Object.values(f.principals)) expect(await ids(p, { view: "all" })).not.toContain(foreignItem.itemId);
    expect(await ids(g.principals.admin)).toEqual([foreignItem.itemId]);
  });

  it("filters by open and closed, and names the owner", async () => {
    expect((await listVisibleItems(f.principals.admin, { view: "closed" })).length).toBe(0);
    expect((await listVisibleItems(f.principals.admin, { view: "all" })).length).toBe(2);
    await withTenant({ organizationId: f.organizationId }, (tx) => assignOwner(tx, { organizationId: f.organizationId, itemId: supportItem.itemId, userId: f.users.member, principal: f.principals.lead, occurredAt: tick() }));
    const row = (await listVisibleItems(f.principals.member)).find((i) => i.id === supportItem.itemId)!;
    expect([row.ownerUserId, row.ownerName]).toEqual([f.users.member, "Carol Member"]);
  });

  it("clamps the limit", async () => {
    expect(await listVisibleItems(f.principals.admin, { limit: 0 })).toHaveLength(1);
    expect((await listVisibleItems(f.principals.admin, { limit: 10_000 })).length).toBeLessThanOrEqual(500);
  });
});

describe("getItemDetail", () => {
  it("returns the item with its history for someone who may view it, with people shown by name", async () => {
    await as(f, "RESPONDED", supportItem.itemId);
    const d = (await getItemDetail(f.principals.member, supportItem.itemId))!;
    expect([d.item.title, d.item.teamName, d.item.state]).toEqual(["Support item", "Support", "RESPONDED"]);
    expect(d.events.map((e) => [e.seq, e.toState, e.actorType])).toEqual([[1, "RECEIVED", "SYSTEM"], [2, "RESPONDED", "SYSTEM"]]);
    expect(d.item.ownerName).toBe("Carol Member");
  });

  it("returns null, not an error, for an item the principal may not view, one that does not exist, and another organization's", async () => {
    expect(await getItemDetail(f.principals.otherTeamMember, supportItem.itemId)).toBeNull();
    expect(await getItemDetail(f.principals.lead, billingItem.itemId)).toBeNull();
    expect(await getItemDetail(f.principals.admin, randomUUID())).toBeNull();
    for (const p of Object.values(f.principals)) expect(await getItemDetail(p, foreignItem.itemId)).toBeNull();
  });

  it("shows analyzer attribution, quotes and approval decisions", async () => {
    const t = await item(f, f.teamId, "Detail item");
    await as(f, "RESPONDED", t.itemId);
    await as(f, "RESOLUTION_PROPOSED", t.itemId);
    const queued = await withTenant({ organizationId: f.organizationId }, (tx) => propose(tx, { organizationId: f.organizationId, itemId: t.itemId, to: "RESOLUTION_CONFIRMED", occurredAt: tick(), actor: SYSTEM }, engineOpts));
    expect(queued.outcome).toBe("APPROVAL_REQUIRED");
    const approved = await withTenant({ organizationId: f.organizationId }, (tx) => apply(tx, { organizationId: f.organizationId, itemId: t.itemId, to: "RESOLUTION_CONFIRMED", occurredAt: tick(), reason: "Customer confirmed", actor: { type: "USER", principal: f.principals.lead } }, engineOpts));
    expect(approved.outcome).toBe("APPLIED");
    const d = (await getItemDetail(f.principals.member, t.itemId))!;
    const confirm = d.events.find((e) => e.toState === "RESOLUTION_CONFIRMED")!;
    expect([confirm.actorType, confirm.actorLabel, confirm.reason]).toEqual(["USER", "Bob Lead", "Customer confirmed"]);
    expect(d.approvals[0]).toMatchObject({ requestedTransition: "RESOLUTION_CONFIRMED", status: "APPROVED", decidedByName: "Bob Lead" });
  });
});

describe("listPendingApprovals", () => {
  it("lists pending approvals on viewable items only, oldest first", async () => {
    const mine = await item(f, f.teamId, "Needs approval");
    const theirs = await item(f, f.otherTeamId, "Billing needs approval");
    for (const t of [mine, theirs]) {
      await as(f, "RESPONDED", t.itemId);
      await as(f, "RESOLUTION_PROPOSED", t.itemId);
      await withTenant({ organizationId: f.organizationId }, (tx) => propose(tx, { organizationId: f.organizationId, itemId: t.itemId, to: "RESOLUTION_CONFIRMED", occurredAt: tick(), actor: SYSTEM }, engineOpts));
    }
    const titles = async (p: Principal) => (await listPendingApprovals(p)).map((a) => a.itemTitle);
    expect(await titles(f.principals.member)).toContain("Needs approval");
    expect(await titles(f.principals.member)).not.toContain("Billing needs approval");
    expect(await titles(f.principals.otherTeamMember)).toEqual(["Billing needs approval"]);
    expect(await titles(f.principals.admin)).toEqual(expect.arrayContaining(["Needs approval", "Billing needs approval"]));
    const row = (await listPendingApprovals(f.principals.admin)).find((a) => a.itemTitle === "Needs approval")!;
    expect([row.itemState, row.requestedTransition]).toEqual(["RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED"]);
    expect(await listPendingApprovals(g.principals.admin)).toEqual([]); // nothing leaks across organizations
  });
});

describe("review queue", () => {
  it("is hidden from viewers, scoped to viewable items for members, and readable by auditors", async () => {
    const mine = await item(f, f.teamId, "Review mine");
    const other = await item(f, f.otherTeamId, "Review other");
    await queueReviewTask(f.organizationId, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: mine.itemId });
    await queueReviewTask(f.organizationId, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: other.itemId });
    await queueReviewTask(f.organizationId, { type: "SCHEMA_FAILURE", refType: "AnalysisRun", refId: randomUUID() });
    const titles = async (p: Principal) => (await listOpenReviewTasks(p)).map((t) => t.itemTitle ?? t.refType);
    expect(await listOpenReviewTasks(f.principals.viewer)).toEqual([]);
    expect(await titles(f.principals.member)).toEqual(expect.arrayContaining(["Review mine", "AnalysisRun"]));
    expect(await titles(f.principals.member)).not.toContain("Review other");
    expect(await titles(f.principals.auditor)).toEqual(expect.arrayContaining(["Review mine", "Review other"]));
    expect(await listOpenReviewTasks(g.principals.admin)).toEqual([]);
  });

  it("lets a member close a task on their team's item, audits it, and refuses a second close", async () => {
    const t = await item(f, f.teamId, "Close me");
    const task = await queueReviewTask(f.organizationId, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: t.itemId });
    expect(await resolveReviewTask(f.principals.member, { id: task.id, status: "RESOLVED", resolution: "Looked fine" })).toEqual({ outcome: "RESOLVED" });
    const row = await owner.reviewTask.findUniqueOrThrow({ where: { id: task.id } });
    expect([row.status, row.resolution]).toEqual(["RESOLVED", "Looked fine"]);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { entityId: task.id, action: "review.closed" } });
    expect([audit.actorId, audit.metadata]).toEqual([f.users.member, { type: "LOW_CONFIDENCE", status: "RESOLVED", refType: "TrackedItem", refId: t.itemId }]);
    expect(await resolveReviewTask(f.principals.member, { id: task.id, status: "DISMISSED" })).toEqual({ outcome: "REJECTED", reason: "NOT_OPEN" });
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("RESOLVED"); // unchanged
  });

  it("refuses viewers and auditors, and a member acting on another team's item, changing nothing", async () => {
    const other = await item(f, f.otherTeamId, "Not yours");
    const task = await queueReviewTask(f.organizationId, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: other.itemId });
    for (const who of ["viewer", "auditor", "member", "lead"] as const) {
      await expect(resolveReviewTask(f.principals[who], { id: task.id, status: "RESOLVED" }), who).rejects.toThrow(ForbiddenError);
    }
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("OPEN");
    expect(await resolveReviewTask(f.principals.admin, { id: task.id, status: "DISMISSED" })).toEqual({ outcome: "DISMISSED" });
  });

  it("reports unknown and other-organization tasks as not found, and truncates long notes", async () => {
    expect(await resolveReviewTask(f.principals.admin, { id: randomUUID(), status: "RESOLVED" })).toEqual({ outcome: "REJECTED", reason: "NOT_FOUND" });
    const foreign = await queueReviewTask(g.organizationId, { type: "SCHEMA_FAILURE", refType: "AnalysisRun", refId: randomUUID() });
    expect(await resolveReviewTask(f.principals.admin, { id: foreign.id, status: "RESOLVED" })).toEqual({ outcome: "REJECTED", reason: "NOT_FOUND" });
    const own = await queueReviewTask(f.organizationId, { type: "SCHEMA_FAILURE", refType: "AnalysisRun", refId: randomUUID() });
    await resolveReviewTask(f.principals.admin, { id: own.id, status: "RESOLVED", resolution: "x".repeat(900) });
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: own.id } })).resolution).toHaveLength(500);
  });

  it("closes the OWNERSHIP task when a person assigns an owner, and leaves other tasks and a mere clearing alone", async () => {
    const t = await item(f, f.teamId, "Owner task");
    const own = await queueReviewTask(f.organizationId, { type: "OWNERSHIP", refType: "TrackedItem", refId: t.itemId });
    const other = await queueReviewTask(f.organizationId, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: t.itemId });
    const assign = (userId: string | null) => withTenant({ organizationId: f.organizationId }, (tx) => assignOwner(tx, { organizationId: f.organizationId, itemId: t.itemId, userId, principal: f.principals.lead, occurredAt: tick() }));
    await assign(null); // clearing an already-empty owner changes nothing
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("OPEN");
    await assign(f.users.member);
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("RESOLVED");
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("OPEN");
  });
});

describe("thread messages (decrypted, only after an item-level check)", () => {
  it("returns a thread's messages in order with their text, senders and directions", async () => {
    const t = await item(f, f.teamId, "Thread item");
    await createMessage(owner, f, t.threadId, "Our reply, in the clear for authorized viewers.", 30, "OUTBOUND");
    const msgs = await loadThreadMessages(f.organizationId, t.threadId, { fieldKey: testKey });
    expect(msgs.map((m) => [m.direction, m.text])).toEqual([["INBOUND", "Message for Thread item"], ["OUTBOUND", "Our reply, in the clear for authorized viewers."]]);
  });

  it("is scoped to the organization: another tenant's thread id returns nothing", async () => {
    expect(await loadThreadMessages(f.organizationId, foreignItem.threadId, { fieldKey: testKey })).toEqual([]);
    expect(await loadThreadMessages(g.organizationId, supportItem.threadId, { fieldKey: testKey })).toEqual([]);
  });
});

describe("item analysis history", () => {
  it("lists accepted analyses linked to the item, with their cited quotes, and nothing from other items", async () => {
    const a = await item(f, f.teamId, "Analysis A");
    const b = await item(f, f.teamId, "Analysis B");
    const run = await createAnalysisRun(owner, f, "progress_analyzer");
    await owner.analysisRun.update({ where: { id: run.id }, data: { itemId: a.itemId, recommendedAction: "TRANSITION_IN_PROGRESS", confidence: 0.9, evidence: [{ messageId: a.messageId, quote: "working on it" }] } });
    const rows = await listItemAnalysis(f.organizationId, a.itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analyzer: "progress_analyzer", recommendedAction: "TRANSITION_IN_PROGRESS", evidence: [{ quote: "working on it" }] });
    expect(await listItemAnalysis(f.organizationId, b.itemId)).toEqual([]);
    expect(await listItemAnalysis(g.organizationId, a.itemId)).toEqual([]);
  });
});
