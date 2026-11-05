import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ItemState } from "../../generated/prisma/enums";
import { ManualClock } from "@/lib/clock";
import { createPrismaClient, withTenant } from "@/lib/db";
import { ForbiddenError } from "@/modules/identity";
import { apply, createItem, propose } from "@/modules/lifecycle";
import { createCalendar, createPolicy, getItemTimers, listPolicies, reconcileItem, resolvePolicyFor, scanAll, scanOrganization, SlaConfigError } from "@/modules/sla";
import { purgeOrgs } from "../helpers/fixtures";
import { at, createEngineFixture, createThreadWithMessage, engineOpts, type EngineFixture } from "../helpers/engine-fixture";

/**
 * Fake-clock tests for the SLA engine (Sprint 8 exit criterion): business hours, warning, breach and reopen. Time never comes
 * from the machine: `ManualClock` is advanced by hand and item events are stamped with explicit times.
 * at(0) is Monday 2026-10-05 09:00 UTC.
 */
// The scan discovers organizations across the whole database. These tests run against a shared dev database that also holds
// the seeded organizations, and fake clocks (October 2026) must never be used to re-derive timers for data that is not theirs.
// So the real cross-tenant function still runs, but its result is narrowed to the organizations these tests created.
const scanAllowlist = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, listOrganizationsWithSlaPolicies: async () => (await real.listOrganizationsWithSlaPolicies()).filter((id) => scanAllowlist.has(id)) };
});

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const SYSTEM = { type: "SYSTEM" as const };
const created: EngineFixture[] = [];

const TARGETS = { ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200 };
const WEEKDAYS_9_5 = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "17:00"]]]));

async function newOrg(): Promise<EngineFixture> {
  const f = await createEngineFixture(owner);
  created.push(f);
  scanAllowlist.add(f.organizationId);
  return f;
}
const inOrg = <T>(f: EngineFixture, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ organizationId: f.organizationId }, fn);

async function newItem(f: EngineFixture, o: { minute?: number; policyId?: string; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"; teamId?: string } = {}) {
  const { threadId, messageId } = await createThreadWithMessage(owner, f, "Please help with the synthetic problem.", 0);
  const out = await inOrg(f, (tx) => createItem(tx, {
    organizationId: f.organizationId, teamId: o.teamId ?? f.teamId, originMessageId: messageId, threadId, title: "SLA item", occurredAt: at(o.minute ?? 0),
    actor: SYSTEM, ...(o.policyId ? { slaPolicyId: o.policyId } : {}), ...(o.priority ? { priority: o.priority } : {}),
  }, engineOpts));
  if (out.outcome !== "CREATED") throw new Error("not created");
  return out.itemId;
}
/** Move an item at an explicit time: the system for automated steps, the admin for human decisions. */
async function step(f: EngineFixture, itemId: string, to: ItemState, minute: number) {
  const human = to === "RESOLUTION_CONFIRMED" || to === "CLOSED" || to === "REOPENED";
  const base = { organizationId: f.organizationId, itemId, to, occurredAt: at(minute) };
  const out = await inOrg(f, (tx) => (human ? apply(tx, { ...base, actor: { type: "USER", principal: f.principals.admin } }, engineOpts) : propose(tx, { ...base, actor: SYSTEM }, engineOpts)));
  if (out.outcome !== "APPLIED") throw new Error(`step ${to}: ${JSON.stringify(out)}`);
}
const timers = (itemId: string) => owner.slaTimer.findMany({ where: { itemId }, orderBy: [{ cycle: "asc" }, { type: "asc" }] });
const timer = async (itemId: string, type: string, cycle = 1) => (await owner.slaTimer.findFirstOrThrow({ where: { itemId, type: type as never, cycle } }));
const breaches = (itemId: string) => owner.slaBreach.count({ where: { timer: { itemId } } });
const clock = (minute: number) => new ManualClock(at(minute));

let f: EngineFixture; // organization with a continuous (24x7) default policy
let defaultPolicy: string;
let businessPolicy: string;

beforeAll(async () => {
  f = await newOrg();
  defaultPolicy = (await createPolicy(f.principals.admin, { name: "Default", ...TARGETS, warnAtPct: 80 })).id;
  const cal = await createCalendar(f.principals.admin, { timezone: "UTC", hours: WEEKDAYS_9_5, holidays: [] });
  businessPolicy = (await createPolicy(f.principals.admin, { name: "Business hours", ...TARGETS, calendarId: cal.id, warnAtPct: 80 })).id;
});

afterAll(async () => {
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

describe("clock skew", () => {
  it("a scan whose clock runs behind never walks an overdue or due-soon timer backwards, and never re-reports it", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    const late = await reconcileItem(f.organizationId, itemId, { clock: clock(100) }); // ACK (60) overdue; RESPONSE (240) not yet
    expect(late.breached.map((b) => b.type)).toEqual(["ACK"]);
    const behind = await reconcileItem(f.organizationId, itemId, { clock: clock(10) }); // another host, ninety minutes behind
    expect(behind).toEqual({ warned: [], breached: [] });
    expect((await timer(itemId, "ACK")).state).toBe("BREACHED");
    expect(await breaches(itemId)).toBe(1);
    // A timer that had only warned stays warned too.
    await reconcileItem(f.organizationId, itemId, { clock: clock(200) }); // RESPONSE warns at 192
    expect((await timer(itemId, "RESPONSE")).state).toBe("WARNED");
    await reconcileItem(f.organizationId, itemId, { clock: clock(20) });
    expect((await timer(itemId, "RESPONSE")).state).toBe("WARNED");
    // Time moving forward again behaves normally.
    await reconcileItem(f.organizationId, itemId, { clock: clock(241) });
    expect((await timer(itemId, "RESPONSE")).state).toBe("BREACHED");
    expect(await breaches(itemId)).toBe(2);
  });
});

describe("timers are created from the policy, in continuous time", () => {
  it("starts all four timers at receipt with fixed due and warning times", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    const r = await reconcileItem(f.organizationId, itemId, { clock: clock(5) });
    expect(r).toEqual({ warned: [], breached: [] });
    const t = await timers(itemId);
    expect(t.map((x) => [x.type, x.state, x.cycle])).toEqual([["ACK", "RUNNING", 1], ["RESPONSE", "RUNNING", 1], ["RESOLVE", "RUNNING", 1], ["CLOSE", "RUNNING", 1]]);
    const ack = await timer(itemId, "ACK");
    expect([ack.startedAt, ack.dueAt, ack.warnAt]).toEqual([at(0), at(60), at(48)]); // 1h target, warning at 80%
    expect((await timer(itemId, "RESPONSE")).dueAt).toEqual(at(240));
    expect((await timer(itemId, "RESOLVE")).dueAt).toEqual(at(48 * 60));
    expect((await timer(itemId, "CLOSE")).dueAt).toEqual(at(72 * 60)); // all from receipt, as decided
  });

  it("is idempotent: reconciling repeatedly changes and duplicates nothing", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    for (let i = 0; i < 5; i++) await reconcileItem(f.organizationId, itemId, { clock: clock(5) });
    expect(await owner.slaTimer.count({ where: { itemId } })).toBe(4);
  });

  it("does nothing, and says so, for an item that is not found or has no policy", async () => {
    const bare = await newOrg(); // no policies at all
    const itemId = await newItem(bare);
    expect(await reconcileItem(bare.organizationId, itemId, { clock: clock(0) })).toEqual({ skipped: "NO_POLICY", warned: [], breached: [] });
    expect(await owner.slaTimer.count({ where: { itemId } })).toBe(0);
    expect(await reconcileItem(f.organizationId, randomUUID(), { clock: clock(0) })).toMatchObject({ skipped: "ITEM_NOT_FOUND" });
  });
});

describe("warning and breach as the clock moves", () => {
  it("warns at 80% of the target, once", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(47) });
    expect((await timer(itemId, "ACK")).state).toBe("RUNNING");
    const r = await reconcileItem(f.organizationId, itemId, { clock: clock(48) });
    expect(r.warned.map((w) => w.type)).toEqual(["ACK"]);
    expect((await timer(itemId, "ACK")).state).toBe("WARNED");
    expect((await reconcileItem(f.organizationId, itemId, { clock: clock(50) })).warned).toEqual([]); // already warned: not reported again
  });

  it("breaches at the due time, recording exactly one breach and one audit entry", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(59) });
    expect(await breaches(itemId)).toBe(0);
    const r = await reconcileItem(f.organizationId, itemId, { clock: clock(60) });
    expect(r.breached.map((b) => b.type)).toEqual(["ACK"]);
    const ack = await timer(itemId, "ACK");
    expect([ack.state, ack.resolvedAt]).toEqual(["BREACHED", null]); // overdue and still open
    const breach = await owner.slaBreach.findFirstOrThrow({ where: { timerId: ack.id } });
    expect(breach.breachedAt).toEqual(at(60)); // dated at the due time, not at whenever the scan ran
    // Ten hours on, RESPONSE (due at 4h) has also breached, but the ACK breach is not reported a second time.
    const later = await reconcileItem(f.organizationId, itemId, { clock: clock(600) });
    expect(later.breached.map((b) => b.type)).toEqual(["RESPONSE"]);
    expect(await owner.slaBreach.count({ where: { timerId: ack.id } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: itemId, action: "sla.timer_breached", metadata: { path: ["timerType"], equals: "ACK" } } })).toBe(1);
    expect((await reconcileItem(f.organizationId, itemId, { clock: clock(601) })).breached).toEqual([]); // and now nothing is new
  });

  it("breaches each timer at its own due time", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(241) });
    expect((await timers(itemId)).map((t) => [t.type, t.state])).toEqual([["ACK", "BREACHED"], ["RESPONSE", "BREACHED"], ["RESOLVE", "RUNNING"], ["CLOSE", "RUNNING"]]);
    await reconcileItem(f.organizationId, itemId, { clock: clock(73 * 60) });
    expect((await timers(itemId)).every((t) => t.state === "BREACHED")).toBe(true);
    expect(await breaches(itemId)).toBe(4);
  });

  it("a late acknowledgment settles the timer as BREACHED, dated when it actually arrived", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(61) }); // breach detected first
    await step(f, itemId, "ACKNOWLEDGED", 90);
    await reconcileItem(f.organizationId, itemId, { clock: clock(120) });
    const ack = await timer(itemId, "ACK");
    expect([ack.state, ack.resolvedAt]).toEqual(["BREACHED", at(90)]); // a late finish is still a breach
    expect(await owner.slaBreach.count({ where: { timerId: ack.id } })).toBe(1); // and still exactly one record
  });

  it("an on-time acknowledgment is MET, whenever the scan eventually runs", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "ACKNOWLEDGED", 10);
    await reconcileItem(f.organizationId, itemId, { clock: clock(24 * 60) }); // a day later
    const ack = await timer(itemId, "ACK");
    expect([ack.state, ack.resolvedAt]).toEqual(["MET", at(10)]);
    expect(await owner.slaBreach.count({ where: { timerId: ack.id } })).toBe(0); // met on time: no breach, however late the scan
  });

  it("a late scan reaches the same answer as a timely one", async () => {
    const a = await newItem(f, { policyId: defaultPolicy });
    const b = await newItem(f, { policyId: defaultPolicy });
    for (const id of [a, b]) await step(f, id, "ACKNOWLEDGED", 30);
    await reconcileItem(f.organizationId, a, { clock: clock(31) });
    await reconcileItem(f.organizationId, a, { clock: clock(10_000) });
    await reconcileItem(f.organizationId, b, { clock: clock(10_000) }); // only ever scanned late
    const shape = async (id: string) => (await timers(id)).map((t) => [t.type, t.state, t.resolvedAt?.getTime() ?? null]);
    expect(await shape(a)).toEqual(await shape(b));
  });
});

describe("the four metrics are tracked separately (rules 4 and 5)", () => {
  it("settles each timer from its own event, and a proposal or confirmation does not settle a later one", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "ACKNOWLEDGED", 5);
    await step(f, itemId, "RESPONDED", 50);
    await step(f, itemId, "RESOLUTION_PROPOSED", 80);
    await reconcileItem(f.organizationId, itemId, { clock: clock(100) });
    expect((await timers(itemId)).map((t) => [t.type, t.state])).toEqual([["ACK", "MET"], ["RESPONSE", "MET"], ["RESOLVE", "RUNNING"], ["CLOSE", "RUNNING"]]); // proposed is not resolved

    await step(f, itemId, "RESOLUTION_CONFIRMED", 120);
    await reconcileItem(f.organizationId, itemId, { clock: clock(130) });
    expect((await timers(itemId)).map((t) => [t.type, t.state])).toEqual([["ACK", "MET"], ["RESPONSE", "MET"], ["RESOLVE", "MET"], ["CLOSE", "RUNNING"]]); // confirmed is not closed

    await step(f, itemId, "CLOSED", 180);
    await reconcileItem(f.organizationId, itemId, { clock: clock(190) });
    const done = await timers(itemId);
    expect(done.map((t) => [t.type, t.state, t.resolvedAt])).toEqual([["ACK", "MET", at(5)], ["RESPONSE", "MET", at(50)], ["RESOLVE", "MET", at(120)], ["CLOSE", "MET", at(180)]]);
  });

  it("a substantive reply with no acknowledgment satisfies ACK at the reply's time, as decided", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "RESPONDED", 20);
    await reconcileItem(f.organizationId, itemId, { clock: clock(500) });
    expect([(await timer(itemId, "ACK")).state, (await timer(itemId, "ACK")).resolvedAt]).toEqual(["MET", at(20)]);
    expect((await owner.trackedItem.findUniqueOrThrow({ where: { id: itemId } })).ackAt).toBeNull(); // the acknowledgment metric itself stays empty (rule 5)
  });

  it("an acknowledgment alone never satisfies RESPONSE", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "ACKNOWLEDGED", 10);
    await reconcileItem(f.organizationId, itemId, { clock: clock(300) });
    expect([(await timer(itemId, "ACK")).state, (await timer(itemId, "RESPONSE")).state]).toEqual(["MET", "BREACHED"]);
  });

  it("closing an item ends its obligations: overdue ones stay breached, ones not yet due are cancelled", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "IN_PROGRESS", 30); // worked on, but never acknowledged or answered
    await step(f, itemId, "RESOLUTION_PROPOSED", 60);
    await step(f, itemId, "RESOLUTION_CONFIRMED", 90);
    await step(f, itemId, "CLOSED", 120);
    await reconcileItem(f.organizationId, itemId, { clock: clock(130) });
    const t = await timers(itemId);
    expect(t.map((x) => [x.type, x.state, x.resolvedAt])).toEqual([["ACK", "BREACHED", at(120)], ["RESPONSE", "CANCELLED", at(120)], ["RESOLVE", "MET", at(90)], ["CLOSE", "MET", at(120)]]);
    // A finished item never alarms afterwards.
    await reconcileItem(f.organizationId, itemId, { clock: clock(100_000) });
    expect((await timers(itemId)).map((x) => x.state)).toEqual(["BREACHED", "CANCELLED", "MET", "MET"]);
  });
});

describe("reopening starts a new cycle", () => {
  it("keeps the old cycle's history and starts four fresh timers at the reopening", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "RESPONDED", 30);
    await step(f, itemId, "RESOLUTION_PROPOSED", 60);
    await step(f, itemId, "RESOLUTION_CONFIRMED", 90);
    await step(f, itemId, "CLOSED", 120);
    await step(f, itemId, "REOPENED", 1_000);
    await reconcileItem(f.organizationId, itemId, { clock: clock(1_010) });
    const all = await timers(itemId);
    expect(all).toHaveLength(8);
    expect(all.filter((t) => t.cycle === 1).map((t) => t.state)).toEqual(["MET", "MET", "MET", "MET"]); // cycle 1 untouched
    const cycle2 = await timer(itemId, "ACK", 2);
    expect([cycle2.startedAt, cycle2.dueAt, cycle2.state]).toEqual([at(1_000), at(1_060), "RUNNING"]);
  });

  it("the new cycle warns and breaches on its own clock, without disturbing the old one", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "RESPONDED", 30);
    await step(f, itemId, "RESOLUTION_PROPOSED", 60);
    await step(f, itemId, "RESOLUTION_CONFIRMED", 90);
    await step(f, itemId, "CLOSED", 120);
    await step(f, itemId, "REOPENED", 1_000);
    const w = await reconcileItem(f.organizationId, itemId, { clock: clock(1_048) });
    expect(w.warned.map((x) => [x.type, x.cycle])).toEqual([["ACK", 2]]);
    const b = await reconcileItem(f.organizationId, itemId, { clock: clock(1_061) });
    expect(b.breached.map((x) => [x.type, x.cycle])).toEqual([["ACK", 2]]);
    expect((await timers(itemId)).filter((t) => t.cycle === 1).every((t) => t.state === "MET")).toBe(true);
    await step(f, itemId, "ACKNOWLEDGED", 1_100);
    await reconcileItem(f.organizationId, itemId, { clock: clock(1_200) });
    expect(await timer(itemId, "ACK", 2)).toMatchObject({ state: "BREACHED", resolvedAt: at(1_100) }); // acknowledged, but late
  });

  it("reopening from confirmed, before closing, cancels the old cycle's closure timer", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await step(f, itemId, "RESPONDED", 30);
    await step(f, itemId, "RESOLUTION_PROPOSED", 60);
    await step(f, itemId, "RESOLUTION_CONFIRMED", 90);
    await step(f, itemId, "REOPENED", 600);
    await reconcileItem(f.organizationId, itemId, { clock: clock(610) });
    expect(await timer(itemId, "CLOSE", 1)).toMatchObject({ state: "CANCELLED", resolvedAt: at(600) });
  });
});

describe("business hours", () => {
  it("a request received after hours is due the next business morning, and overnight does not count", async () => {
    const itemId = await newItem(f, { policyId: businessPolicy, minute: 9 * 60 + 30 }); // Monday 18:30, closed
    await reconcileItem(f.organizationId, itemId, { clock: clock(9 * 60 + 31) });
    const ack = await timer(itemId, "ACK");
    expect(ack.dueAt.toISOString()).toBe("2026-10-06T10:00:00.000Z"); // Tuesday 09:00 + 1h
    expect(ack.warnAt?.toISOString()).toBe("2026-10-06T09:48:00.000Z");
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-06T00:30:00Z") });
    expect((await timer(itemId, "ACK")).state).toBe("RUNNING"); // paused overnight
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-06T09:50:00Z") });
    expect((await timer(itemId, "ACK")).state).toBe("WARNED");
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-06T10:00:00Z") });
    expect((await timer(itemId, "ACK")).state).toBe("BREACHED");
  });

  it("carries a Friday-evening request over the weekend", async () => {
    const itemId = await newItem(f, { policyId: businessPolicy, minute: 4 * 24 * 60 + 7 * 60 + 30 }); // Friday 16:30
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-09T16:31:00Z") });
    expect((await timer(itemId, "ACK")).dueAt.toISOString()).toBe("2026-10-12T09:30:00.000Z"); // 30 minutes Friday, 30 minutes Monday
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-11T12:00:00Z") });
    expect((await timer(itemId, "ACK")).state).toBe("RUNNING"); // Sunday: still paused
  });

  it("a reply during the weekend pause that arrives before the next opening is on time", async () => {
    const itemId = await newItem(f, { policyId: businessPolicy, minute: 4 * 24 * 60 + 7 * 60 + 30 }); // Friday 16:30
    await step(f, itemId, "ACKNOWLEDGED", 4 * 24 * 60 + 8 * 60); // Friday 17:00, within the hour of business time left
    await reconcileItem(f.organizationId, itemId, { clock: new ManualClock("2026-10-20T00:00:00Z") });
    expect((await timer(itemId, "ACK")).state).toBe("MET");
  });
});

describe("policies", () => {
  it("fix an existing timer's due time: editing a policy never re-times work in flight", async () => {
    const o = await newOrg();
    const pid = (await createPolicy(o.principals.admin, { name: "Editable", ...TARGETS })).id;
    const a = await newItem(o, { policyId: pid });
    await reconcileItem(o.organizationId, a, { clock: clock(5) });
    const before = (await timer(a, "ACK")).dueAt;
    await owner.slaPolicy.update({ where: { id: pid }, data: { ackTargetSec: 600 } }); // now 10 minutes, where the original was 60
    // At minute 30 the NEW target would long since have been breached, but the timer already running keeps its original due time.
    const r = await reconcileItem(o.organizationId, a, { clock: clock(30) });
    expect((await timer(a, "ACK")).dueAt).toEqual(before); // unchanged
    expect((await timer(a, "ACK")).state).toBe("RUNNING"); // and judged against that fixed due time, not the edited policy
    expect([r.breached.length, await breaches(a)]).toEqual([0, 0]);
    const b = await newItem(o, { policyId: pid });
    await reconcileItem(o.organizationId, b, { clock: clock(6) });
    expect((await timer(b, "ACK")).dueAt).toEqual(at(10)); // new work uses the new target
  });

  it("are chosen by scope when an item has none set: the most specific wins", async () => {
    const o = await newOrg();
    const def = (await createPolicy(o.principals.admin, { name: "Default", ...TARGETS })).id;
    const urgent = (await createPolicy(o.principals.admin, { name: "Urgent", priority: "URGENT", ackTargetSec: 900, responseTargetSec: 3600, resolveTargetSec: 86_400, closeTargetSec: 172_800 })).id;
    const team = (await createPolicy(o.principals.admin, { name: "Support team", teamId: o.teamId, ...TARGETS })).id;
    const scope = (priority: "NORMAL" | "URGENT", teamId = o.teamId) => resolvePolicyFor(o.organizationId, { teamId, monitoredSourceId: o.sourceId, priority });
    expect((await scope("URGENT"))?.id).toBe(team); // team (2) outranks priority (1)
    expect((await scope("NORMAL"))?.id).toBe(team);
    expect((await scope("URGENT", o.otherTeamId))?.id).toBe(urgent); // no team policy for the other team: priority applies
    expect((await scope("NORMAL", o.otherTeamId))?.id).toBe(def);

    const item = await newItem(o, { priority: "URGENT", teamId: o.otherTeamId }); // no policy set on the item: resolved at reconcile
    await reconcileItem(o.organizationId, item, { clock: clock(1) });
    expect((await timer(item, "ACK")).dueAt).toEqual(at(15)); // the urgent policy's 15-minute target
  });

  it("use the item's own policy even when a more specific one exists", async () => {
    const o = await newOrg();
    const slow = (await createPolicy(o.principals.admin, { name: "Slow", ...TARGETS })).id;
    await createPolicy(o.principals.admin, { name: "Urgent", priority: "URGENT", ackTargetSec: 900, responseTargetSec: 3600, resolveTargetSec: 86_400, closeTargetSec: 172_800 });
    const item = await newItem(o, { policyId: slow, priority: "URGENT" });
    await reconcileItem(o.organizationId, item, { clock: clock(1) });
    expect((await timer(item, "ACK")).dueAt).toEqual(at(60));
  });
});

describe("concurrency and isolation", () => {
  it("eight concurrent reconciles still leave exactly four timers and one breach per breached timer", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reconcileItem(f.organizationId, itemId, { clock: clock(61) })));
    for (const r of results) if (r.status === "rejected") throw r.reason;
    expect(await owner.slaTimer.count({ where: { itemId } })).toBe(4);
    expect(await breaches(itemId)).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: itemId, action: "sla.timer_breached" } })).toBe(1);
    const reported = results.flatMap((r) => (r.status === "fulfilled" ? r.value.breached : []));
    expect(reported).toHaveLength(1); // exactly one caller is told about the breach
  });

  it("cannot reconcile another organization's item", async () => {
    const other = await newOrg();
    const itemId = await newItem(f, { policyId: defaultPolicy });
    expect(await reconcileItem(other.organizationId, itemId, { clock: clock(0) })).toMatchObject({ skipped: "ITEM_NOT_FOUND" });
  });
});

describe("reading timers for display", () => {
  it("shows the effective state as of now, even before the next scan has run", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(5) }); // stored as RUNNING
    const stale = await getItemTimers(f.principals.member, itemId, { clock: clock(61) });
    expect(stale!.find((t) => t.type === "ACK")!.state).toBe("BREACHED");
    expect((await timer(itemId, "ACK")).state).toBe("RUNNING"); // reading wrote nothing
  });

  it("is limited to people who may view the item", async () => {
    const itemId = await newItem(f, { policyId: defaultPolicy });
    await reconcileItem(f.organizationId, itemId, { clock: clock(5) });
    for (const who of ["admin", "lead", "member", "viewer", "auditor"] as const) expect(await getItemTimers(f.principals[who], itemId, { clock: clock(5) }), who).not.toBeNull();
    expect(await getItemTimers(f.principals.otherTeamMember, itemId, { clock: clock(5) })).toBeNull();
  });
});

describe("the scan", () => {
  it("reconciles open items and unsettled timers, and reports what newly warned and breached", async () => {
    const o = await newOrg();
    const pid = (await createPolicy(o.principals.admin, { name: "Scan policy", ...TARGETS })).id;
    const warnMe = await newItem(o, { policyId: pid, minute: 0 });
    const breachMe = await newItem(o, { policyId: pid, minute: -30 }); // received half an hour earlier
    const fine = await newItem(o, { policyId: pid, minute: 50 });
    const r = await scanOrganization(o.organizationId, { clock: clock(50) });
    expect(r.items).toBe(3);
    expect(r.failures).toBe(0);
    expect(r.warned.filter((w) => w.itemId === warnMe).map((w) => w.type)).toContain("ACK");
    expect(r.breached.filter((b) => b.itemId === breachMe).map((b) => b.type)).toEqual(["ACK"]);
    expect([...r.warned, ...r.breached].some((x) => x.itemId === fine)).toBe(false);
    const again = await scanOrganization(o.organizationId, { clock: clock(50) });
    expect([again.warned.length, again.breached.length]).toEqual([0, 0]); // nothing is reported twice
  });

  it("finalizes the timers of an item that has just been closed, then stops visiting it", async () => {
    const o = await newOrg();
    const pid = (await createPolicy(o.principals.admin, { name: "Finalize", ...TARGETS })).id;
    const itemId = await newItem(o, { policyId: pid });
    await scanOrganization(o.organizationId, { clock: clock(5) });
    for (const [to, m] of [["RESPONDED", 30], ["RESOLUTION_PROPOSED", 60], ["RESOLUTION_CONFIRMED", 90], ["CLOSED", 120]] as const) await step(o, itemId, to, m);
    expect((await scanOrganization(o.organizationId, { clock: clock(200) })).items).toBe(1); // still has unsettled timers
    expect((await timers(itemId)).every((t) => t.state === "MET")).toBe(true);
    expect((await scanOrganization(o.organizationId, { clock: clock(300) })).items).toBe(0); // finished: no longer visited
  });

  it("scanAll finds organizations through the narrow function and handles each under its own context", async () => {
    const withPolicy = await newOrg();
    const without = await newOrg();
    const pid = (await createPolicy(withPolicy.principals.admin, { name: "All", ...TARGETS })).id;
    const a = await newItem(withPolicy, { policyId: pid });
    const b = await newItem(without);
    const r = await scanAll({ clock: clock(70) });
    expect(r.organizations).toBeGreaterThanOrEqual(2);
    expect(r.breached.some((x) => x.itemId === a)).toBe(true);
    expect(await owner.slaTimer.count({ where: { itemId: b } })).toBe(0); // an organization with no policy is not scanned
  });

  it("the cross-tenant function returns ids only, and only the app role may call it", async () => {
    const raw = createPrismaClient(process.env["APP_DATABASE_URL"]!);
    try {
      const rows = await raw.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM sla_scan_org_ids()`;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row)).toEqual(["sla_scan_org_ids"]); // a single column, nothing else
      const [priv] = await owner.$queryRaw<Array<{ pub: boolean; app: boolean }>>`
        SELECT has_function_privilege('public', 'sla_scan_org_ids()', 'EXECUTE') AS pub, has_function_privilege('loopsignal_app', 'sla_scan_org_ids()', 'EXECUTE') AS app`;
      expect(priv).toEqual({ pub: false, app: true });
      // The app role still cannot read another organization's policies directly: the function is the only door, and it is narrow.
      expect(await raw.slaPolicy.findMany()).toEqual([]);
    } finally {
      await raw.$disconnect();
    }
  });
});

describe("configuring policies and calendars", () => {
  it("is for organization administrators only, and audited", async () => {
    const o = await newOrg();
    for (const who of ["member", "lead", "viewer", "auditor"] as const) {
      await expect(createPolicy(o.principals[who], { name: "No", ...TARGETS }), who).rejects.toThrow(ForbiddenError);
      await expect(createCalendar(o.principals[who], { timezone: "UTC", hours: WEEKDAYS_9_5 }), who).rejects.toThrow(ForbiddenError);
    }
    const cal = await createCalendar(o.principals.admin, { timezone: "America/Toronto", hours: WEEKDAYS_9_5, holidays: ["2026-12-25"] });
    const pol = await createPolicy(o.principals.admin, { name: "Audited", ...TARGETS, calendarId: cal.id });
    expect(await owner.auditLog.count({ where: { entityId: cal.id, action: "sla.calendar_created", actorId: o.users.admin } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: pol.id, action: "sla.policy_created", actorId: o.users.admin } })).toBe(1);
    expect((await listPolicies(o.principals.member)).map((p) => [p.name, p.calendarTimezone])).toEqual([["Audited", "America/Toronto"]]);
  });

  it("rejects invalid input with a clear error and writes nothing", async () => {
    const o = await newOrg();
    await expect(createCalendar(o.principals.admin, { timezone: "Mars/Base", hours: WEEKDAYS_9_5 })).rejects.toThrow(SlaConfigError);
    await expect(createCalendar(o.principals.admin, { timezone: "UTC", hours: {} })).rejects.toThrow(/open range/);
    await expect(createPolicy(o.principals.admin, { name: "Backwards", ...TARGETS, ackTargetSec: 999_999 })).rejects.toThrow(SlaConfigError);
    await expect(createPolicy(o.principals.admin, { name: "Dup", ...TARGETS })).resolves.toBeTruthy();
    await expect(createPolicy(o.principals.admin, { name: "Dup", ...TARGETS })).rejects.toThrow(/already in use/);
    await expect(createPolicy(o.principals.admin, { name: "Ghost", ...TARGETS, calendarId: randomUUID() })).rejects.toThrow(/does not exist/);
    await expect(createPolicy(o.principals.admin, { name: "Foreign", ...TARGETS, teamId: f.teamId })).rejects.toThrow(/does not exist/); // another organization's team
    expect((await listPolicies(o.principals.admin)).map((p) => p.name)).toEqual(["Dup"]);
  });

  it("will not let a policy or calendar be read across organizations", async () => {
    const o = await newOrg();
    await createPolicy(o.principals.admin, { name: "Mine only", ...TARGETS });
    expect((await listPolicies(f.principals.admin)).map((p) => p.name)).not.toContain("Mine only");
  });
});
