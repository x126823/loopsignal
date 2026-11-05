import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ManualClock } from "@/lib/clock";
import { createPrismaClient, withTenant } from "@/lib/db";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { HeuristicProvider, ProviderError, type LLMProvider } from "@/modules/intelligence";
import { createItem } from "@/modules/lifecycle";
import { createCalendar, createPolicy, reconcileItem, timerProgress } from "@/modules/sla";
import { handleSlaRisk } from "@/workers/sla-risk";
import { handleSlaScan, registerSlaScanSchedule, SLA_SCAN_SCHEDULE_ID } from "@/workers/sla-scan";
import { purgeOrgs } from "../helpers/fixtures";
import { at, createEngineFixture, createThreadWithMessage, engineOpts, type EngineFixture } from "../helpers/engine-fixture";
import { createTestHub, destroyTestHub } from "../helpers/queue";

// The scan discovers organizations across the whole database. These tests run against a shared dev database that also holds
// the seeded organizations, and fake clocks (October 2026) must never be used to re-derive timers for data that is not theirs.
// So the real cross-tenant function still runs, but its result is narrowed to the organizations these tests created.
const scanAllowlist = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, listOrganizationsWithSlaPolicies: async () => (await real.listOrganizationsWithSlaPolicies()).filter((id) => scanAllowlist.has(id)) };
});

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const created: EngineFixture[] = [];
const TARGETS = { ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200 };
const clock = (minute: number) => new ManualClock(at(minute));
const heuristic = new HeuristicProvider();
const riskDeps = (minute: number, provider: LLMProvider = heuristic) => ({ provider, pipeline: { fieldKey: engineOpts.fieldKey }, clock: clock(minute) });

let hub: QueueHub;
let f: EngineFixture;
let policyId: string;

async function newItem(text: string, minute = 0) {
  const { threadId, messageId } = await createThreadWithMessage(owner, f, text, minute);
  const out = await withTenant({ organizationId: f.organizationId }, (tx) => createItem(tx, {
    organizationId: f.organizationId, teamId: f.teamId, originMessageId: messageId, threadId, title: "SLA risk item", occurredAt: at(minute), actor: { type: "SYSTEM" }, slaPolicyId: policyId,
  }, engineOpts));
  if (out.outcome !== "CREATED") throw new Error("not created");
  return { itemId: out.itemId };
}
const timerOf = (itemId: string, type: string) => owner.slaTimer.findFirstOrThrow({ where: { itemId, type: type as never, cycle: 1 } });
const riskJobs = () => hub.queue(QUEUES.slaRisk).getJobs(["waiting", "delayed", "active", "prioritized", "completed"]);

beforeAll(async () => {
  hub = createTestHub();
  f = await createEngineFixture(owner);
  created.push(f);
  scanAllowlist.add(f.organizationId);
  policyId = (await createPolicy(f.principals.admin, { name: "Default", ...TARGETS, warnAtPct: 80 })).id;
});
afterAll(async () => {
  await destroyTestHub(hub);
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

describe("the repeating scan schedule", () => {
  it("is registered idempotently: registering on every worker start leaves exactly one schedule", async () => {
    await registerSlaScanSchedule(hub, 60_000);
    await registerSlaScanSchedule(hub, 60_000);
    await registerSlaScanSchedule(hub, 30_000); // a changed interval updates it, never adds a second
    const schedulers = await hub.queue(QUEUES.slaScan).getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual([SLA_SCAN_SCHEDULE_ID]);
    expect(schedulers[0]?.every).toBe(30_000);
  });
});

describe("handleSlaScan", () => {
  it("queues one advisory risk job per timer that enters its warning window, and never a second on replay", async () => {
    const { itemId } = await newItem("Please help, the synthetic export fails.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) }); // timers exist, nothing warned yet
    const before = (await riskJobs()).length;

    // 49 minutes in: the 1 hour ACK timer passed its 80% warning (48 minutes).
    const first = await handleSlaScan({ hub, clock: clock(49) });
    const ack = await timerOf(itemId, "ACK");
    expect(ack.state).toBe("WARNED");
    expect(first.warned.some((t) => t.timerId === ack.id)).toBe(true);
    const jobs = await riskJobs();
    expect(jobs.length - before).toBe(first.riskJobs);
    expect(jobs.filter((j) => j.data.timerId === ack.id)).toHaveLength(1);
    expect(Object.keys(jobs.find((j) => j.data.timerId === ack.id)!.data).sort()).toEqual(["itemId", "organizationId", "timerId"]); // ids only

    // Replays and later scans: nothing newly warned for that timer, so no new job and the same single job id.
    const again = await handleSlaScan({ hub, clock: clock(50) });
    expect(again.warned.some((t) => t.timerId === ack.id)).toBe(false);
    expect((await riskJobs()).filter((j) => j.data.timerId === ack.id)).toHaveLength(1);
  });

  it("de-duplicates by timer even if the same timer is reported as newly warned twice", async () => {
    const { itemId } = await newItem("Please help, the synthetic dashboard is slow.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    await handleSlaScan({ hub, clock: clock(49) });
    const ack = await timerOf(itemId, "ACK");
    // Simulate a stored state that fell behind (for example a restored backup): the scan will warn about the same timer again.
    await owner.slaTimer.update({ where: { id: ack.id }, data: { state: "RUNNING" } });
    const second = await handleSlaScan({ hub, clock: clock(50) });
    expect(second.warned.some((t) => t.timerId === ack.id)).toBe(true);
    expect((await riskJobs()).filter((j) => j.data.timerId === ack.id)).toHaveLength(1);
  });

  it("a failure to queue a risk job does not fail the scan or lose the warned state", async () => {
    const { itemId } = await newItem("Please help, the synthetic report is empty.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    const broken = { enqueue: async () => { throw new Error("redis down"); } } as unknown as QueueHub;
    const r = await handleSlaScan({ hub: broken, clock: clock(49) });
    expect(r.riskJobs).toBe(0);
    expect(r.warned.length).toBeGreaterThan(0);
    expect((await timerOf(itemId, "ACK")).state).toBe("WARNED");
  });
});

describe("timerProgress", () => {
  it("measures elapsed business time as a whole percentage, and is null for settled timers", async () => {
    const { itemId } = await newItem("Please help, the synthetic login fails.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    const ack = await timerOf(itemId, "ACK");
    expect(await timerProgress(f.organizationId, itemId, ack.id, { clock: clock(30) })).toEqual({ type: "ACK", state: "RUNNING", percentElapsed: 50 });
    expect(await timerProgress(f.organizationId, itemId, ack.id, { clock: clock(54) })).toEqual({ type: "ACK", state: "WARNED", percentElapsed: 90 });
    expect((await timerProgress(f.organizationId, itemId, ack.id, { clock: clock(90) }))?.percentElapsed).toBe(150);
    expect(await timerProgress(f.organizationId, itemId, "00000000-0000-4000-8000-000000000000", { clock: clock(30) })).toBeNull();
  });

  it("uses the policy calendar: only open hours count", async () => {
    const cal = await createCalendar(f.principals.admin, { timezone: "UTC", hours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] }, holidays: [] });
    const bizPolicy = (await createPolicy(f.principals.admin, { name: "Biz", ...TARGETS, calendarId: cal.id, warnAtPct: 80 })).id;
    // Monday 16:00 UTC start (minute 420): one hour of Monday left, then Tuesday 09:00.
    const { threadId, messageId } = await createThreadWithMessage(owner, f, "Please help, the synthetic invoice is wrong.", 420);
    const out = await withTenant({ organizationId: f.organizationId }, (tx) => createItem(tx, {
      organizationId: f.organizationId, teamId: f.teamId, originMessageId: messageId, threadId, title: "Biz item", occurredAt: at(420), actor: { type: "SYSTEM" }, slaPolicyId: bizPolicy,
    }, engineOpts));
    if (out.outcome !== "CREATED") throw new Error("not created");
    await reconcileItem(f.organizationId, out.itemId, { clock: clock(421) });
    const ack = await timerOf(out.itemId, "ACK"); // 1 business hour from Mon 16:00 -> due Mon 17:00
    expect(ack.dueAt).toEqual(at(480));
    // Overnight does not count: Tuesday 09:00 is exactly the due time ... but the ACK is already past due, so use RESPONSE (4h): due Tue 12:00.
    const resp = await timerOf(out.itemId, "RESPONSE");
    expect(resp.dueAt).toEqual(at(24 * 60 + 3 * 60)); // Mon 16-17 (1h) + Tue 09-12 (3h)
    const p = await timerProgress(f.organizationId, out.itemId, resp.id, { clock: new ManualClock(at(24 * 60)) }); // Tue 09:00: 1 of 4 business hours used
    expect(p).toEqual({ type: "RESPONSE", state: "RUNNING", percentElapsed: 25 });
  });
});

describe("handleSlaRisk (advisory)", () => {
  it("records a risk hint from the thread and the measured facts, without changing any timer or the item", async () => {
    const { itemId } = await newItem("We are blocked on this and it is urgent, we need an answer today.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    await reconcileItem(f.organizationId, itemId, { clock: clock(49) });
    const ack = await timerOf(itemId, "ACK");
    const itemBefore = await owner.trackedItem.findUniqueOrThrow({ where: { id: itemId } });
    const timersBefore = await owner.slaTimer.findMany({ where: { itemId }, orderBy: { id: "asc" } });

    const out = await handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49));
    expect(out).toMatchObject({ status: "ASSESSED", risk: "HIGH", cached: false });
    const run = await owner.analysisRun.findFirstOrThrow({ where: { itemId, analyzer: "sla_risk_analyzer" } });
    expect(run).toMatchObject({ status: "OK", recommendedAction: "NONE" });
    expect(run.evidence).toEqual([]);

    expect(await owner.trackedItem.findUniqueOrThrow({ where: { id: itemId } })).toEqual(itemBefore);
    expect(await owner.slaTimer.findMany({ where: { itemId }, orderBy: { id: "asc" } })).toEqual(timersBefore);

    // Replay: served from the cache, still one run.
    const again = await handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49));
    expect(again).toMatchObject({ status: "ASSESSED", cached: true });
    expect(await owner.analysisRun.count({ where: { itemId, analyzer: "sla_risk_analyzer" } })).toBe(1);
  });

  it("skips a timer that is no longer open (met or gone), and rejects a payload with extra fields", async () => {
    const { itemId } = await newItem("Please help, the synthetic export fails again.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    const ack = await timerOf(itemId, "ACK");
    await owner.slaTimer.update({ where: { id: ack.id }, data: { state: "MET", resolvedAt: at(10) } });
    expect(await handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49))).toEqual({ status: "SKIPPED", reason: "TIMER_NOT_OPEN" });
    await expect(handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id, body: "hi" }, riskDeps(49))).rejects.toThrow(/Invalid sla-risk job payload/);
  });

  it("an unusable answer is recorded but never queues a human review task (advisory)", async () => {
    const { itemId } = await newItem("Please help, the synthetic sync stalls.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    await reconcileItem(f.organizationId, itemId, { clock: clock(49) });
    const ack = await timerOf(itemId, "ACK");
    const junk: LLMProvider = { name: "junk", model: "junk-1", complete: async () => ({ kind: "output", json: { risk: "SEVERE" }, tokensIn: 1, tokensOut: 1, model: "junk-1" }) };
    const tasksBefore = await owner.reviewTask.count({ where: { organizationId: f.organizationId } });
    const out = await handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49, junk));
    expect(out).toMatchObject({ status: "NO_ASSESSMENT" });
    expect(await owner.reviewTask.count({ where: { organizationId: f.organizationId } })).toBe(tasksBefore);
    expect(await owner.analysisRun.count({ where: { itemId, analyzer: "sla_risk_analyzer", status: { not: "OK" } } })).toBe(1);
  });

  it("a non-retryable provider error is unrecoverable; a retryable one is retried", async () => {
    const { itemId } = await newItem("Please help, the synthetic upload hangs.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    await reconcileItem(f.organizationId, itemId, { clock: clock(49) });
    const ack = await timerOf(itemId, "ACK");
    const failing = (retryable: boolean): LLMProvider => ({ name: "x", model: "x", complete: async () => { throw new ProviderError(retryable, "boom"); } });
    await expect(handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49, failing(false)))).rejects.toMatchObject({ name: "UnrecoverableError" });
    await expect(handleSlaRisk({ organizationId: f.organizationId, itemId, timerId: ack.id }, riskDeps(49, failing(true)))).rejects.toMatchObject({ name: "ProviderError" });
  });

  it("cannot be pointed at another organization's item", async () => {
    const other = await createEngineFixture(owner);
    created.push(other);
    const { itemId } = await newItem("Please help, the synthetic chart is blank.");
    await reconcileItem(f.organizationId, itemId, { clock: clock(1) });
    const ack = await timerOf(itemId, "ACK");
    expect(await handleSlaRisk({ organizationId: other.organizationId, itemId, timerId: ack.id }, riskDeps(49))).toEqual({ status: "SKIPPED", reason: "TIMER_NOT_OPEN" });
  });
});
