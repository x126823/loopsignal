import { describe, expect, it } from "vitest";
import type { ReportingItem } from "@/modules/lifecycle";
import type { TimerStateRow } from "@/modules/sla";
import { buildDashboard, percentile } from "./aggregate";

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
type Step = [ReportingItem["state"], number, number?]; // state, minutes after T0, cycle
let n = 0;
function item(steps: Step[], o: Partial<ReportingItem> = {}): ReportingItem {
  const events = [["RECEIVED", 0, 1] as Step, ...steps].map(([toState, min, cycle], i) => ({ seq: i + 1, cycle: cycle ?? 1, toState, createdAt: at(min) }));
  return { id: `item-${++n}`, teamId: "team-a", title: `Item ${n}`, priority: "NORMAL", state: events.at(-1)!.toState, events, ...o };
}
const timer = (i: ReportingItem, type: TimerStateRow["type"], state: TimerStateRow["state"], cycle = 1): TimerStateRow => ({ itemId: i.id, cycle, type, state });

describe("percentile (nearest rank)", () => {
  it("matches the textbook values", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(50);
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30); // order does not matter
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 90)).toBe(9);
  });
  it("is null for no data", () => expect(percentile([], 50)).toBeNull());
});

describe("the four metrics are separate (rules 4 and 5)", () => {
  it("an acknowledgment is not a response, a proposal is not a resolution, a confirmation is not a closure", () => {
    const acked = item([["ACKNOWLEDGED", 5]]);
    const proposed = item([["RESPONDED", 10], ["RESOLUTION_PROPOSED", 30]]);
    const confirmed = item([["RESPONDED", 10], ["RESOLUTION_PROPOSED", 30], ["RESOLUTION_CONFIRMED", 60]]);
    const d = buildDashboard([acked, proposed, confirmed], []);
    expect(d.metrics.acknowledgment).toMatchObject({ achieved: 1, pending: 2 }); // only the item that was acknowledged
    expect(d.metrics.response).toMatchObject({ achieved: 2, pending: 1 }); // the acknowledged-only item has no response
    expect(d.metrics.resolution).toMatchObject({ achieved: 1, pending: 2 }); // the proposal does not count
    expect(d.metrics.closure).toMatchObject({ achieved: 0, pending: 3 }); // the confirmation does not count
  });

  it("measures each from the start of the cycle to its own event", () => {
    const d = buildDashboard([item([["ACKNOWLEDGED", 5], ["RESPONDED", 20], ["RESOLUTION_PROPOSED", 30], ["RESOLUTION_CONFIRMED", 60], ["CLOSED", 90]])], []);
    expect(d.metrics.acknowledgment.medianSec).toBe(300);
    expect(d.metrics.response.medianSec).toBe(1200);
    expect(d.metrics.resolution.medianSec).toBe(3600);
    expect(d.metrics.closure.medianSec).toBe(5400);
    expect(d.closed).toBe(1);
  });

  it("reports median and p90 over achieved durations only", () => {
    const items = [10, 20, 30, 40, 50].map((m) => item([["ACKNOWLEDGED", m]]));
    items.push(item([])); // never acknowledged: pending, not a zero
    const d = buildDashboard(items, []);
    expect(d.metrics.acknowledgment).toEqual({ achieved: 5, pending: 1, medianSec: 1800, p90Sec: 3000 });
  });

  it("has no numbers, and no divisions by zero, when there is nothing", () => {
    const d = buildDashboard([], []);
    expect(d.items).toBe(0);
    expect(d.metrics.acknowledgment).toEqual({ achieved: 0, pending: 0, medianSec: null, p90Sec: null });
    expect(d.sla.ACK.attainmentPct).toBeNull();
    expect(d.attention).toEqual([]);
    expect(d.teams).toEqual([]);
  });
});

describe("reopened items", () => {
  it("are measured from the reopening, on the current cycle only", () => {
    const i = item([["RESPONDED", 10], ["RESOLUTION_PROPOSED", 20], ["RESOLUTION_CONFIRMED", 30], ["CLOSED", 40], ["REOPENED", 1000, 2], ["RESPONDED", 1015, 2]]);
    const d = buildDashboard([i], [timer(i, "RESPONSE", "MET", 1), timer(i, "RESPONSE", "BREACHED", 2), timer(i, "RESOLVE", "RUNNING", 2)]);
    expect(d.reopened).toBe(1);
    expect(d.open).toBe(1);
    expect(d.metrics.response.medianSec).toBe(15 * 60); // from the reopening at minute 1000, not from receipt
    expect(d.metrics.resolution.achieved).toBe(0); // the earlier cycle's resolution and closure do not carry over
    expect(d.metrics.closure.achieved).toBe(0);
    expect(d.sla.RESPONSE).toMatchObject({ met: 0, breached: 1, attainmentPct: 0 }); // cycle 1's MET is not counted
  });
});

describe("SLA attainment", () => {
  it("is met over decided, and keeps undecided timers apart", () => {
    const items = [item([]), item([]), item([]), item([]), item([]), item([])];
    const states: TimerStateRow["state"][] = ["MET", "MET", "MET", "BREACHED", "WARNED", "RUNNING"];
    const d = buildDashboard(items, items.map((i, k) => timer(i, "ACK", states[k]!)));
    expect(d.sla.ACK).toEqual({ met: 3, breached: 1, warned: 1, running: 1, cancelled: 0, attainmentPct: 75 });
    expect(d.sla.RESPONSE.attainmentPct).toBeNull(); // nothing decided for that timer
    expect(d.breachedTimers).toBe(1);
  });
});

describe("teams and attention", () => {
  it("splits by team and the parts add up", () => {
    const a = item([["ACKNOWLEDGED", 5]], { teamId: "team-a" });
    const b = item([], { teamId: "team-b" });
    const c = item([["ACKNOWLEDGED", 9]], { teamId: "team-b" });
    const d = buildDashboard([a, b, c], []);
    expect(d.teams.map((t) => [t.teamId, t.rollup.items])).toEqual([["team-a", 1], ["team-b", 2]]);
    expect(d.teams.reduce((s, t) => s + t.rollup.metrics.acknowledgment.achieved, 0)).toBe(d.metrics.acknowledgment.achieved);
    expect(d.teams[1]!.rollup.metrics.acknowledgment).toMatchObject({ achieved: 1, pending: 1 });
  });

  it("lists open items that are overdue or due soon, worst first, never closed ones", () => {
    const overdueLow = item([], { priority: "LOW" });
    const overdueUrgent = item([], { priority: "URGENT" });
    const twoOverdue = item([], { priority: "LOW" });
    const soon = item([], { priority: "HIGH" });
    const closed = item([["RESPONDED", 5], ["RESOLUTION_PROPOSED", 6], ["RESOLUTION_CONFIRMED", 7], ["CLOSED", 8]]);
    const fine = item([]);
    const timers = [
      timer(overdueLow, "ACK", "BREACHED"), timer(overdueUrgent, "RESPONSE", "BREACHED"), timer(twoOverdue, "ACK", "BREACHED"), timer(twoOverdue, "RESPONSE", "BREACHED"),
      timer(soon, "ACK", "WARNED"), timer(closed, "RESOLVE", "BREACHED"), timer(fine, "ACK", "RUNNING"),
    ];
    const d = buildDashboard([overdueLow, overdueUrgent, twoOverdue, soon, closed, fine], timers);
    expect(d.attention.map((a) => a.itemId)).toEqual([twoOverdue.id, overdueUrgent.id, overdueLow.id, soon.id]);
    expect(d.attention[0]).toMatchObject({ overdue: ["ACK", "RESPONSE"], dueSoon: [] });
    expect(d.attention.at(-1)).toMatchObject({ overdue: [], dueSoon: ["ACK"] });
    expect(d.attention.some((a) => a.itemId === closed.id)).toBe(false);
  });

  it("counts states and never reports a negative duration", () => {
    const odd = item([["ACKNOWLEDGED", -5]]); // a backdated event must not produce a negative number
    const d = buildDashboard([odd, item([["RESPONDED", 3]])], []);
    expect(d.metrics.acknowledgment.medianSec).toBe(0);
    expect(d.byState).toEqual({ ACKNOWLEDGED: 1, RESPONDED: 1 });
  });
});
