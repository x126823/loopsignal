import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ItemState } from "../../generated/prisma/enums";
import { ManualClock } from "@/lib/clock";
import { createPrismaClient, withTenant } from "@/lib/db";
import { apply, createItem, propose } from "@/modules/lifecycle";
import { getDashboard } from "@/modules/reporting";
import { createPolicy, reconcileItem } from "@/modules/sla";
import { purgeOrgs } from "../helpers/fixtures";
import { at, createEngineFixture, createThreadWithMessage, engineOpts, type EngineFixture } from "../helpers/engine-fixture";

/** Dashboards are derived from events and timers, scoped to what the viewer may see, and write nothing. at(0) is Mon 2026-10-05 09:00 UTC. */
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const created: EngineFixture[] = [];
const SYSTEM = { type: "SYSTEM" as const };
const clock = (minute: number) => new ManualClock(at(minute));
const DAY = 24 * 60;

let f: EngineFixture;
const ids: Record<string, string> = {};

async function newItem(fx: EngineFixture, key: string, o: { teamId?: string; minute: number; policyId?: string; priority?: "NORMAL" | "URGENT" }) {
  const { threadId, messageId } = await createThreadWithMessage(owner, fx, `Please help with ${key}.`, o.minute);
  const out = await withTenant({ organizationId: fx.organizationId }, (tx) => createItem(tx, {
    organizationId: fx.organizationId, teamId: o.teamId ?? fx.teamId, originMessageId: messageId, threadId, title: key, occurredAt: at(o.minute), actor: SYSTEM,
    ...(o.policyId ? { slaPolicyId: o.policyId } : {}), ...(o.priority ? { priority: o.priority } : {}),
  }, engineOpts));
  if (out.outcome !== "CREATED") throw new Error("not created");
  ids[key] = out.itemId;
  return out.itemId;
}
async function step(fx: EngineFixture, itemId: string, to: ItemState, minute: number) {
  const human = to === "RESOLUTION_CONFIRMED" || to === "CLOSED";
  const base = { organizationId: fx.organizationId, itemId, to, occurredAt: at(minute) };
  const out = await withTenant({ organizationId: fx.organizationId }, (tx) => (human ? apply(tx, { ...base, actor: { type: "USER", principal: fx.principals.admin } }, engineOpts) : propose(tx, { ...base, actor: SYSTEM }, engineOpts)));
  if (out.outcome !== "APPLIED") throw new Error(`${to}: ${JSON.stringify(out)}`);
}

beforeAll(async () => {
  f = await createEngineFixture(owner);
  created.push(f);
  const policy = (await createPolicy(f.principals.admin, { name: "Default", ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200, warnAtPct: 80 })).id;
  // Support: "fast" acknowledged at +10 and responded at +30; "slow" acknowledged at +90 (late); "silent" untouched; "proposed" resolution only proposed.
  await newItem(f, "fast", { minute: 0, policyId: policy });
  await step(f, ids["fast"]!, "ACKNOWLEDGED", 10);
  await step(f, ids["fast"]!, "RESPONDED", 30);
  await newItem(f, "slow", { minute: 0, policyId: policy, priority: "URGENT" });
  await step(f, ids["slow"]!, "ACKNOWLEDGED", 90);
  await newItem(f, "silent", { minute: 60, policyId: policy });
  await newItem(f, "proposed", { minute: 0, policyId: policy });
  await step(f, ids["proposed"]!, "RESPONDED", 20);
  await step(f, ids["proposed"]!, "RESOLUTION_PROPOSED", 40);
  // Billing: one item acknowledged at +20.
  await newItem(f, "billing", { minute: 0, teamId: f.otherTeamId, policyId: policy });
  await step(f, ids["billing"]!, "ACKNOWLEDGED", 20);
  // An old item, long before the window.
  await newItem(f, "old", { minute: -60 * DAY, policyId: policy });
  for (const key of Object.keys(ids)) await reconcileItem(f.organizationId, ids[key]!, { clock: clock(5 * DAY) });
});
afterAll(async () => {
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

const now = clock(10 * DAY); // ten days after the items arrived

describe("the dashboard for people who may see everything", () => {
  it("derives the four metrics separately from events, and attainment from timers", async () => {
    const d = (await getDashboard(f.principals.admin, { days: 30 }, { clock: now })).data;
    expect(d.items).toBe(5); // fast, slow, silent, proposed, billing; "old" is outside the window
    expect(d.metrics.acknowledgment).toMatchObject({ achieved: 3, pending: 2 }); // fast, slow, billing; proposed went straight to a response
    expect(d.metrics.response).toMatchObject({ achieved: 2, pending: 3 }); // fast, proposed: acknowledgment is not a response
    expect(d.metrics.resolution).toMatchObject({ achieved: 0, pending: 5 }); // a proposal is not a resolution
    expect(d.metrics.closure).toMatchObject({ achieved: 0, pending: 5 });
    expect(d.metrics.acknowledgment.medianSec).toBe(20 * 60); // durations 10, 20 and 90 minutes
    expect(d.metrics.acknowledgment.p90Sec).toBe(90 * 60);
    expect(d.byState).toMatchObject({ RESPONDED: 1, ACKNOWLEDGED: 2, RECEIVED: 1, RESOLUTION_PROPOSED: 1 });
    // ACK timers: fast met (10 < 60), billing met (20 < 60), proposed met by its early response (20 < 60), slow late (90 > 60), silent overdue by the clock.
    expect(d.sla.ACK).toMatchObject({ met: 3, breached: 2, attainmentPct: 60 });
    expect(d.breachedTimers).toBeGreaterThanOrEqual(2);
  });

  it("lists what needs attention, urgent and overdue first", async () => {
    const d = (await getDashboard(f.principals.admin, { days: 30 }, { clock: now })).data;
    expect(d.attention[0]).toMatchObject({ itemId: ids["slow"], priority: "URGENT" });
    expect(d.attention.map((a) => a.itemId)).toContain(ids["silent"]);
    expect(d.attention.find((a) => a.itemId === ids["billing"])).toMatchObject({ overdue: expect.arrayContaining(["RESPONSE"]) }); // acknowledged, but never answered
    expect(d.teams.map((t) => t.rollup.items).sort()).toEqual([1, 4]);
  });

  it("honours the window: a longer one includes the old item, an invalid one falls back to 30 days", async () => {
    expect((await getDashboard(f.principals.admin, { days: 365 }, { clock: now })).data.items).toBe(6);
    expect((await getDashboard(f.principals.admin, { days: 7 }, { clock: now })).data.items).toBe(0); // everything arrived ten days ago
    const odd = await getDashboard(f.principals.admin, { days: 12 }, { clock: now });
    expect(odd.window.days).toBe(30);
    expect(odd.data.items).toBe(5);
  });
});

describe("only what the viewer may see", () => {
  it("scopes by team: leads and viewers see Support, the other team sees Billing, auditors see everything", async () => {
    const count = async (p: EngineFixture["principals"][keyof EngineFixture["principals"]]) => (await getDashboard(p, { days: 30 }, { clock: now })).data.items;
    expect(await count(f.principals.lead)).toBe(4);
    expect(await count(f.principals.member)).toBe(4);
    expect(await count(f.principals.viewer)).toBe(4);
    expect(await count(f.principals.otherTeamMember)).toBe(1);
    expect(await count(f.principals.auditor)).toBe(5);
    expect((await getDashboard(f.principals.lead, { days: 30 }, { clock: now })).teams.map((t) => t.id)).toEqual([f.teamId]);
  });

  it("a team filter narrows to a team the viewer may see, and a team they may not see shows nothing and says nothing", async () => {
    const mine = await getDashboard(f.principals.lead, { days: 30, teamId: f.teamId }, { clock: now });
    expect([mine.teamId, mine.data.items]).toEqual([f.teamId, 4]);
    const hidden = await getDashboard(f.principals.lead, { days: 30, teamId: f.otherTeamId }, { clock: now });
    expect([hidden.teamId, hidden.data.items, hidden.data.attention]).toEqual([null, 0, []]); // indistinguishable from an empty team
    const nonsense = await getDashboard(f.principals.lead, { days: 30, teamId: "00000000-0000-4000-8000-000000000000" }, { clock: now });
    expect(nonsense.data.items).toBe(0);
  });

  it("never includes another organization's items", async () => {
    const other = await createEngineFixture(owner);
    created.push(other);
    await newItem(other, "theirs", { minute: 0 });
    expect((await getDashboard(f.principals.admin, { days: 30 }, { clock: now })).data.items).toBe(5);
    expect((await getDashboard(other.principals.admin, { days: 30 }, { clock: now })).data.items).toBe(1);
  });
});

describe("it only reads", () => {
  it("writes no events, timers, audit rows or items", async () => {
    const count = async () => [await owner.lifecycleEvent.count({ where: { organizationId: f.organizationId } }), await owner.slaTimer.count({ where: { organizationId: f.organizationId } }),
      await owner.auditLog.count({ where: { organizationId: f.organizationId } }), await owner.trackedItem.count({ where: { organizationId: f.organizationId } })];
    const before = await count();
    await getDashboard(f.principals.admin, { days: 365 }, { clock: now });
    await getDashboard(f.principals.lead, { days: 30, teamId: f.teamId }, { clock: now });
    expect(await count()).toEqual(before);
  });
});
