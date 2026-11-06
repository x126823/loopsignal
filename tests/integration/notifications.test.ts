import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "@/lib/clock";
import { createPrismaClient, withTenant } from "@/lib/db";
import { HeuristicProvider } from "@/modules/intelligence";
import { createItem } from "@/modules/lifecycle";
import { countUnread, createNotifications, listNotifications, listPreferences, markRead, setPreference } from "@/modules/notifications";
import { createPolicy, reconcileItem } from "@/modules/sla";
import { listTeamActors } from "@/modules/tenancy";
import { handleAnalyzeMessage } from "../../src/workers/analyze-message";
import { notifyApprovalRequested, notifySlaTimers } from "../../src/workers/notify";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { at, createEngineFixture, createMessage, createThreadWithMessage, engineOpts, NOW, type EngineFixture } from "../helpers/engine-fixture";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const created: EngineFixture[] = [];
const heuristic = new HeuristicProvider();
let f: EngineFixture;
let itemId: string;
const U = () => f.users;
const P = () => f.principals;

async function newItem(fx: EngineFixture, o: { teamId?: string; ownerUserId?: string; policyId?: string; title?: string } = {}) {
  const { threadId, messageId } = await createThreadWithMessage(owner, fx, "Please help, the synthetic export fails.", 0);
  const out = await withTenant({ organizationId: fx.organizationId }, (tx) => createItem(tx, {
    organizationId: fx.organizationId, teamId: o.teamId ?? fx.teamId, originMessageId: messageId, threadId, title: o.title ?? "Export fails", occurredAt: at(0), actor: { type: "SYSTEM" },
    ...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {}), ...(o.policyId ? { slaPolicyId: o.policyId } : {}),
  }, engineOpts));
  if (out.outcome !== "CREATED") throw new Error("not created");
  return { itemId: out.itemId, threadId, messageId };
}
const slaPayload = (id: string) => ({ itemId: id, timerId: randomUUID(), timerType: "ACK" as const, cycle: 1 });

beforeAll(async () => {
  f = await createEngineFixture(owner);
  created.push(f);
  itemId = (await newItem(f)).itemId;
});
afterAll(async () => {
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

describe("who counts as someone who can act", () => {
  it("lists team members who can act plus administrators, never viewers, auditors or other teams", async () => {
    expect(await listTeamActors(f.organizationId, f.teamId)).toEqual([U().admin, U().lead, U().member].sort());
    expect(await listTeamActors(f.organizationId, f.teamId, { leadsOnly: true })).toEqual([U().admin, U().lead].sort());
    expect(await listTeamActors(f.organizationId, f.otherTeamId)).toEqual([U().admin, U().otherTeamMember].sort());
  });

  it("does not count someone who is a team member but read-only in the organization (the team role is capped, as in the permission rules)", async () => {
    const fx = await createEngineFixture(owner);
    created.push(fx);
    const capped = randomUUID();
    await owner.user.create({ data: { id: capped, email: `${capped}@synthetic.loopsignal.test` } });
    await owner.membership.create({ data: { organizationId: fx.organizationId, userId: capped, role: "VIEWER" } });
    await owner.teamMember.create({ data: { organizationId: fx.organizationId, teamId: fx.teamId, userId: capped, role: "MEMBER" } });
    expect(await listTeamActors(fx.organizationId, fx.teamId)).not.toContain(capped);
    expect(await listTeamActors(fx.organizationId, fx.teamId)).toContain(fx.users.member);
    await owner.teamMember.deleteMany({ where: { userId: capped } });
    await owner.membership.deleteMany({ where: { userId: capped } });
    await owner.user.delete({ where: { id: capped } });
  });
});

describe("creating notifications", () => {
  it("carries ids and enums only: anything else is refused before it is stored", async () => {
    const base = { type: "review_ownership" as const, recipients: [U().member], dedupeKey: `k-${randomUUID()}` };
    await expect(createNotifications(f.organizationId, { ...base, payload: { itemId, body: "the customer says..." } as never })).rejects.toThrow();
    await expect(createNotifications(f.organizationId, { ...base, payload: { itemId: "not-a-uuid" } as never })).rejects.toThrow();
    await expect(createNotifications(f.organizationId, { ...base, type: "nope", payload: { itemId } } as never)).rejects.toThrow();
    expect(await owner.notification.count({ where: { dedupeKey: base.dedupeKey } })).toBe(0);
  });

  it("notifies in-app by default and by email only for people who opted in (recorded, never delivered)", async () => {
    await setPreference(P().lead, { type: "review_ownership", channel: "EMAIL", enabled: true });
    const key = `k-${randomUUID()}`;
    const r = await createNotifications(f.organizationId, { type: "review_ownership", recipients: [U().lead, U().member], payload: { itemId }, dedupeKey: key });
    expect(r).toEqual({ inApp: 2, email: 1 });
    const email = await owner.notification.findMany({ where: { dedupeKey: key, channel: "EMAIL" } });
    expect(email).toMatchObject([{ recipientUserId: U().lead, deliveredAt: null }]);
    // The database itself refuses to mark an email as delivered in this release.
    await expect(owner.notification.update({ where: { id: email[0]!.id }, data: { deliveredAt: new Date() } })).rejects.toThrow();
  });

  it("skips people who turned a type off, and notifies nobody when there are no recipients", async () => {
    await setPreference(P().member, { type: "sla_warning", channel: "IN_APP", enabled: false });
    const key = `k-${randomUUID()}`;
    expect(await createNotifications(f.organizationId, { type: "sla_warning", recipients: [U().member, U().lead], payload: slaPayload(itemId), dedupeKey: key })).toMatchObject({ inApp: 1 });
    expect(await owner.notification.count({ where: { dedupeKey: key, recipientUserId: U().member } })).toBe(0);
    expect(await createNotifications(f.organizationId, { type: "sla_warning", recipients: [], payload: slaPayload(itemId), dedupeKey: key })).toEqual({ inApp: 0, email: 0 });
  });

  it("is idempotent per event: replaying never notifies twice, a new event does", async () => {
    const key = `k-${randomUUID()}`;
    const args = { type: "review_ownership" as const, recipients: [U().viewer], payload: { itemId }, dedupeKey: key };
    expect((await createNotifications(f.organizationId, args)).inApp).toBe(1);
    expect((await createNotifications(f.organizationId, args)).inApp).toBe(0);
    expect((await createNotifications(f.organizationId, { ...args, dedupeKey: `${key}-2` })).inApp).toBe(1);
  });
});

describe("a person's own inbox", () => {
  it("shows only their own notifications, with text built from the item, newest first", async () => {
    const a = await newItem(f, { title: "Alpha outage" });
    await createNotifications(f.organizationId, { type: "sla_breach", recipients: [U().auditor], payload: slaPayload(a.itemId), dedupeKey: `k-${randomUUID()}` });
    await createNotifications(f.organizationId, { type: "approval_requested", recipients: [U().auditor], payload: { itemId: a.itemId, approvalRequestId: randomUUID(), transition: "CLOSED" }, dedupeKey: `k-${randomUUID()}` });
    const mine = await listNotifications(P().auditor);
    expect(mine.map((n) => n.type)).toEqual(["approval_requested", "sla_breach"]);
    expect(mine[0]).toMatchObject({ text: 'Please decide whether to close "Alpha outage"', href: `/items/${a.itemId}`, readAt: null });
    expect(mine[1]!.text).toBe('Missed: acknowledge deadline on "Alpha outage"');
    expect(await listNotifications(P().admin, { limit: 100 }).then((l) => l.some((n) => n.text.includes("Alpha outage")))).toBe(false); // someone else's
  });

  it("is protected by row-level security as well as by the query: another person cannot read or change it", async () => {
    const key = `k-${randomUUID()}`;
    await createNotifications(f.organizationId, { type: "review_ownership", recipients: [U().lead], payload: { itemId }, dedupeKey: key });
    const row = await owner.notification.findFirstOrThrow({ where: { dedupeKey: key, recipientUserId: U().lead } });
    const asMember = { organizationId: f.organizationId, userId: U().member };
    expect(await withTenant(asMember, (tx) => tx.notification.findMany({ where: { id: row.id } }))).toEqual([]);
    expect((await withTenant(asMember, (tx) => tx.notification.updateMany({ where: { id: row.id }, data: { readAt: new Date() } }))).count).toBe(0);
    expect((await owner.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt).toBeNull();
    // ...and the marker the web app uses cannot reach it either.
    expect(await markRead(P().member, { ids: [row.id] })).toBe(0);
    expect(await markRead(P().lead, { ids: [row.id] })).toBe(1);
    // Another organization's context sees nothing at all.
    const stranger = await createEngineFixture(owner);
    created.push(stranger);
    expect(await withTenant({ organizationId: stranger.organizationId, userId: stranger.users.admin }, (tx) => tx.notification.findMany())).toEqual([]);
  });

  it("leaves out notifications about items the person can no longer view, and malformed ones", async () => {
    const billing = await newItem(f, { teamId: f.otherTeamId, title: "Billing only" });
    await createNotifications(f.organizationId, { type: "review_ownership", recipients: [U().lead], payload: { itemId: billing.itemId }, dedupeKey: `k-${randomUUID()}` });
    expect((await listNotifications(P().lead, { limit: 100 })).some((n) => n.text.includes("Billing only"))).toBe(false); // lead is on Support, not Billing
    expect((await listNotifications(P().otherTeamMember, { limit: 100 })).some((n) => n.text.includes("Billing only"))).toBe(false); // never notified
    await owner.notification.create({ data: { organizationId: f.organizationId, recipientUserId: U().lead, type: "review_ownership", payload: { itemId, extra: "<script>" }, channel: "IN_APP", dedupeKey: `bad-${randomUUID()}` } });
    await owner.notification.create({ data: { organizationId: f.organizationId, recipientUserId: U().lead, type: "made_up_type", payload: { itemId }, channel: "IN_APP", dedupeKey: `bad-${randomUUID()}` } });
    const shown = await listNotifications(P().lead, { limit: 100 });
    expect(shown.every((n) => !n.text.includes("script"))).toBe(true);
  });

  it("marks some or all read, counts what is unread, and ignores email rows", async () => {
    const fx = await createEngineFixture(owner);
    created.push(fx);
    const it1 = (await newItem(fx)).itemId;
    for (let i = 0; i < 3; i++) await createNotifications(fx.organizationId, { type: "review_ownership", recipients: [fx.users.member], payload: { itemId: it1 }, dedupeKey: `k-${i}-${randomUUID()}` });
    expect(await countUnread(fx.principals.member)).toBe(3);
    const [first] = await listNotifications(fx.principals.member);
    expect(await markRead(fx.principals.member, { ids: [first!.id] })).toBe(1);
    expect(await markRead(fx.principals.member, { ids: [first!.id] })).toBe(0); // already read
    expect(await countUnread(fx.principals.member)).toBe(2);
    expect(await markRead(fx.principals.member, { all: true })).toBe(2);
    expect(await countUnread(fx.principals.member)).toBe(0);
    expect((await listNotifications(fx.principals.member)).every((n) => n.readAt !== null)).toBe(true);
  });
});

describe("preferences", () => {
  it("default to in-app on and email off, save per person, and refuse unknown settings", async () => {
    const fx = await createEngineFixture(owner);
    created.push(fx);
    const all = await listPreferences(fx.principals.member);
    expect(all).toHaveLength(10);
    expect(all.filter((p) => p.channel === "IN_APP").every((p) => p.enabled && p.isDefault)).toBe(true);
    expect(all.filter((p) => p.channel === "EMAIL").every((p) => !p.enabled && p.isDefault)).toBe(true);
    expect(await setPreference(fx.principals.member, { type: "sla_breach", channel: "EMAIL", enabled: true })).toEqual({ outcome: "SAVED" });
    expect(await setPreference(fx.principals.member, { type: "sla_breach", channel: "EMAIL", enabled: false })).toEqual({ outcome: "SAVED" });
    expect(await setPreference(fx.principals.member, { type: "sla_breach", channel: "IN_APP", enabled: false })).toEqual({ outcome: "SAVED" });
    const mine = await listPreferences(fx.principals.member);
    expect(mine.find((p) => p.type === "sla_breach" && p.channel === "IN_APP")).toMatchObject({ enabled: false, isDefault: false });
    expect(mine.find((p) => p.type === "sla_breach" && p.channel === "EMAIL")).toMatchObject({ enabled: false, isDefault: false });
    expect((await listPreferences(fx.principals.lead)).find((p) => p.type === "sla_breach" && p.channel === "IN_APP")).toMatchObject({ enabled: true, isDefault: true }); // not leaked to others
    expect(await setPreference(fx.principals.member, { type: "nope", channel: "IN_APP", enabled: true })).toEqual({ outcome: "REFUSED", reason: "UNKNOWN_TYPE" });
    expect(await setPreference(fx.principals.member, { type: "sla_breach", channel: "SMS", enabled: true })).toEqual({ outcome: "REFUSED", reason: "UNKNOWN_CHANNEL" });
    expect(await owner.notificationPreference.count({ where: { organizationId: fx.organizationId } })).toBe(2); // two distinct rows: no duplicates, no junk
  });
});

describe("what raises notifications", () => {
  const TARGETS = { ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200 };

  it("deadlines: the owner hears about a due-soon and a missed deadline once; an unowned item goes to the leads", async () => {
    const fx = await createEngineFixture(owner);
    created.push(fx);
    const policy = (await createPolicy(fx.principals.admin, { name: "Default", ...TARGETS, warnAtPct: 80 })).id;
    const owned = await newItem(fx, { policyId: policy, ownerUserId: fx.users.member });
    const unowned = await newItem(fx, { policyId: policy });
    for (const id of [owned.itemId, unowned.itemId]) await reconcileItem(fx.organizationId, id, { clock: new ManualClock(at(1)) });

    const warn = [await reconcileItem(fx.organizationId, owned.itemId, { clock: new ManualClock(at(49)) }), await reconcileItem(fx.organizationId, unowned.itemId, { clock: new ManualClock(at(49)) })];
    await notifySlaTimers({ warned: warn.flatMap((w) => w.warned), breached: warn.flatMap((w) => w.breached) });
    await notifySlaTimers({ warned: warn.flatMap((w) => w.warned), breached: [] }); // a replay
    const miss = [await reconcileItem(fx.organizationId, owned.itemId, { clock: new ManualClock(at(70)) }), await reconcileItem(fx.organizationId, unowned.itemId, { clock: new ManualClock(at(70)) })];
    await notifySlaTimers({ warned: [], breached: miss.flatMap((m) => m.breached) });

    const types = async (u: string) => (await owner.notification.findMany({ where: { organizationId: fx.organizationId, recipientUserId: u, channel: "IN_APP" } })).map((n) => `${n.type}:${(n.payload as { itemId: string }).itemId === owned.itemId ? "owned" : "unowned"}`).sort();
    expect(await types(fx.users.member)).toEqual(["sla_breach:owned", "sla_warning:owned"]); // exactly once each despite the replay
    expect(await types(fx.users.lead)).toEqual(["sla_breach:unowned", "sla_warning:unowned"]);
    expect(await types(fx.users.admin)).toEqual(["sla_breach:unowned", "sla_warning:unowned"]); // administrators are leads too
    expect(await types(fx.users.viewer)).toEqual([]);
  });

  it("decisions: people who may decide are told when a suggestion is waiting, once, even if the job replays", async () => {
    const fx = await createEngineFixture(owner);
    created.push(fx);
    const run = (messageId: string) => handleAnalyzeMessage({ organizationId: fx.organizationId, messageId }, { provider: heuristic, pipeline: { fieldKey: testKey }, engine: engineOpts, now: () => NOW });
    const { threadId, messageId } = await createThreadWithMessage(owner, fx, "Our checkout page returns an error for every customer. Can you look into this urgently?", 0);
    expect(await run(messageId)).toMatchObject({ status: "ITEM_CREATED" });
    const fix = await createMessage(owner, fx, threadId, "The issue is now fixed. Please let us know if it works for you.", 30, "OUTBOUND");
    await run(fix.id);
    const confirm = await createMessage(owner, fx, threadId, "Works now, thanks! You can close this.", 40, "INBOUND");
    expect(await run(confirm.id)).toMatchObject({ status: "CONFIRMATION_SUGGESTED" });
    await run(confirm.id); // replay

    const approvals = (u: string) => owner.notification.count({ where: { organizationId: fx.organizationId, recipientUserId: u, type: "approval_requested", channel: "IN_APP" } });
    expect([await approvals(fx.users.member), await approvals(fx.users.lead), await approvals(fx.users.admin)]).toEqual([1, 1, 1]);
    expect([await approvals(fx.users.viewer), await approvals(fx.users.auditor), await approvals(fx.users.otherTeamMember)]).toEqual([0, 0, 0]);
    const seen = await listNotifications(fx.principals.member);
    expect(seen.find((n) => n.type === "approval_requested")?.text).toMatch(/^Please decide whether to confirm the resolution of /);
    // The same item also had no named owner, so people who can act were asked to assign one (also once).
    expect(await owner.notification.count({ where: { organizationId: fx.organizationId, recipientUserId: fx.users.lead, type: "review_ownership" } })).toBe(1);
  });

  it("a failure to notify never breaks the work that raised it", async () => {
    await expect(notifyApprovalRequested({ organizationId: randomUUID(), itemId: randomUUID(), teamId: randomUUID(), approvalRequestId: randomUUID(), transition: "CLOSED" })).resolves.toBeUndefined();
    const before = await owner.notification.count({ where: { organizationId: f.organizationId, type: "approval_requested" } });
    await expect(notifyApprovalRequested({ organizationId: f.organizationId, itemId, teamId: f.teamId, approvalRequestId: randomUUID(), transition: "NOT_A_TRANSITION" })).resolves.toBeUndefined();
    expect(await owner.notification.count({ where: { organizationId: f.organizationId, type: "approval_requested" } })).toBe(before); // an unknown transition notifies nobody
  });
});
