import { describe, expect, it } from "vitest";
import type { ItemState } from "../../../generated/prisma/enums";
import { ManualClock } from "@/lib/clock";
import { addBusinessSeconds, calendarSchema } from "./calendar";
import { planTimers, timerState, TIMER_TYPES, type EventLite, type PlannedTimer, type TimerState, type TimerType } from "./derive";
import { policyInputSchema, resolvePolicy, type PolicyRecord } from "./policy";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 9, 0); // Monday 09:00Z
const at = (m: number) => new Date(T0 + m * MIN);
let seq = 0;
const ev = (toState: ItemState, minute: number, cycle = 1): EventLite => ({ seq: ++seq, cycle, toState, createdAt: at(minute) });
const timers = (events: EventLite[]) => planTimers(events);
const get = (all: PlannedTimer[], type: TimerType, cycle = 1) => all.find((t) => t.type === type && t.cycle === cycle)!;

describe("planTimers", () => {
  it("starts all four timers at receipt, all still open", () => {
    const t = timers([ev("RECEIVED", 0)]);
    expect(t).toHaveLength(4);
    expect(t.map((x) => x.type)).toEqual([...TIMER_TYPES]);
    for (const x of t) expect([x.startedAt, x.completedAt, x.endedAt]).toEqual([at(0), null, null]);
  });

  it("completes each timer from its own event, separately (rule 4)", () => {
    const t = timers([ev("RECEIVED", 0), ev("ACKNOWLEDGED", 10), ev("RESPONDED", 60), ev("RESOLUTION_PROPOSED", 90), ev("RESOLUTION_CONFIRMED", 120), ev("CLOSED", 180)]);
    expect([get(t, "ACK").completedAt, get(t, "RESPONSE").completedAt, get(t, "RESOLVE").completedAt, get(t, "CLOSE").completedAt]).toEqual([at(10), at(60), at(120), at(180)]);
  });

  it("a proposal does not complete RESOLVE, and confirmation does not complete CLOSE (rule 5)", () => {
    const t = timers([ev("RECEIVED", 0), ev("RESPONDED", 30), ev("RESOLUTION_PROPOSED", 60), ev("RESOLUTION_CONFIRMED", 90)]);
    expect(get(t, "RESOLVE").completedAt).toEqual(at(90));
    expect(get(t, "CLOSE").completedAt).toBeNull();
    const proposedOnly = timers([ev("RECEIVED", 0), ev("RESPONDED", 30), ev("RESOLUTION_PROPOSED", 60)]);
    expect(get(proposedOnly, "RESOLVE").completedAt).toBeNull();
  });

  it("an early substantive response satisfies ACK, as decided; an acknowledgment alone does not satisfy RESPONSE", () => {
    const answered = timers([ev("RECEIVED", 0), ev("RESPONDED", 20)]);
    expect([get(answered, "ACK").completedAt, get(answered, "RESPONSE").completedAt]).toEqual([at(20), at(20)]);
    const ackedFirst = timers([ev("RECEIVED", 0), ev("ACKNOWLEDGED", 5), ev("RESPONDED", 20)]);
    expect(get(ackedFirst, "ACK").completedAt).toEqual(at(5));
    const ackOnly = timers([ev("RECEIVED", 0), ev("ACKNOWLEDGED", 5)]);
    expect([get(ackOnly, "ACK").completedAt, get(ackOnly, "RESPONSE").completedAt]).toEqual([at(5), null]);
  });

  it("ends a cycle at closure: timers still open are marked ended then", () => {
    const t = timers([ev("RECEIVED", 0), ev("IN_PROGRESS", 30), ev("RESOLUTION_PROPOSED", 60), ev("RESOLUTION_CONFIRMED", 90), ev("CLOSED", 120)]);
    expect([get(t, "ACK").completedAt, get(t, "ACK").endedAt]).toEqual([null, at(120)]); // never acknowledged or answered
    expect([get(t, "CLOSE").completedAt, get(t, "CLOSE").endedAt]).toEqual([at(120), null]);
  });

  it("a reopen starts a new cycle with its own timers, and ends the old cycle's open ones", () => {
    const t = timers([
      ev("RECEIVED", 0), ev("RESPONDED", 30), ev("RESOLUTION_PROPOSED", 60), ev("RESOLUTION_CONFIRMED", 90),
      ev("REOPENED", 600, 2), ev("ACKNOWLEDGED", 620, 2),
    ]);
    expect(t).toHaveLength(8);
    expect(get(t, "CLOSE", 1)).toMatchObject({ completedAt: null, endedAt: at(600) }); // reopened from confirmed, before closing
    expect(get(t, "ACK", 2)).toMatchObject({ startedAt: at(600), completedAt: at(620) });
    expect(get(t, "RESPONSE", 2)).toMatchObject({ startedAt: at(600), completedAt: null, endedAt: null });
    expect(get(t, "RESOLVE", 1).completedAt).toEqual(at(90)); // history is kept
  });

  it("a reopen after closure keeps both cycles' history", () => {
    const t = timers([ev("RECEIVED", 0), ev("RESPONDED", 30), ev("RESOLUTION_PROPOSED", 60), ev("RESOLUTION_CONFIRMED", 90), ev("CLOSED", 120), ev("REOPENED", 900, 2)]);
    expect([get(t, "CLOSE", 1).completedAt, get(t, "CLOSE", 2).completedAt]).toEqual([at(120), null]);
    expect(get(t, "ACK", 1).completedAt).toEqual(at(30));
  });

  it("does not depend on the order events are given in, and an empty history has no timers", () => {
    const events = [ev("RECEIVED", 0), ev("ACKNOWLEDGED", 10), ev("RESPONDED", 50)];
    expect(planTimers([...events].reverse())).toEqual(planTimers(events));
    expect(planTimers([])).toEqual([]);
  });
});

describe("timerState (fake clock: warn, breach, and finishing)", () => {
  const open = { completedAt: null, endedAt: null };
  const due = at(60);
  const warn = at(48); // 80% of 60 minutes
  const state = (t: Pick<PlannedTimer, "completedAt" | "endedAt">, now: Date): [TimerState, Date | null] => {
    const s = timerState(t, due, warn, now);
    return [s.state, s.resolvedAt];
  };

  it("runs, then warns, then breaches as the clock moves, and the boundaries are inclusive", () => {
    const clock = new ManualClock(at(0));
    expect(state(open, clock.now())[0]).toBe("RUNNING");
    clock.set(at(47.99));
    expect(state(open, clock.now())[0]).toBe("RUNNING");
    clock.set(at(48));
    expect(state(open, clock.now())[0]).toBe("WARNED"); // exactly at the warning time
    clock.set(at(59.99));
    expect(state(open, clock.now())[0]).toBe("WARNED");
    clock.set(at(60));
    expect(state(open, clock.now())).toEqual(["BREACHED", null]); // exactly at the due time: overdue and still open
    clock.advance({ days: 3 });
    expect(state(open, clock.now())).toEqual(["BREACHED", null]);
  });

  it("met on time is MET, met late is BREACHED, and time passing afterwards changes nothing", () => {
    expect(state({ completedAt: at(30), endedAt: null }, at(1_000))).toEqual(["MET", at(30)]);
    expect(state({ completedAt: at(60), endedAt: null }, at(1_000))).toEqual(["MET", at(60)]); // exactly on the due time counts as on time
    expect(state({ completedAt: at(61), endedAt: null }, at(1_000))).toEqual(["BREACHED", at(61)]);
    expect(state({ completedAt: at(61), endedAt: null }, at(0))).toEqual(["BREACHED", at(61)]); // independent of "now"
  });

  it("a cycle that ended before the due time cancels the timer; one that ended after it was already breached", () => {
    expect(state({ completedAt: null, endedAt: at(30) }, at(500))).toEqual(["CANCELLED", at(30)]);
    expect(state({ completedAt: null, endedAt: at(59) }, at(500))).toEqual(["CANCELLED", at(59)]);
    expect(state({ completedAt: null, endedAt: at(60) }, at(500))).toEqual(["BREACHED", at(60)]);
    expect(state({ completedAt: null, endedAt: at(200) }, at(500))).toEqual(["BREACHED", at(200)]);
  });
});

describe("due dates in business time", () => {
  const cal = calendarSchema.parse({ timezone: "UTC", hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "17:00"]]])) });
  it("a request received after hours is due the next business morning, and warns at the same fraction of business time", () => {
    const received = new Date(Date.UTC(2026, 9, 5, 18, 30)); // Monday evening, closed
    const dueAt = addBusinessSeconds(received, 3600, cal);
    const warnAt = addBusinessSeconds(received, Math.floor((3600 * 80) / 100), cal);
    expect(dueAt.toISOString()).toBe("2026-10-06T10:00:00.000Z");
    expect(warnAt.toISOString()).toBe("2026-10-06T09:48:00.000Z");
    expect(timerState({ completedAt: null, endedAt: null }, dueAt, warnAt, new Date("2026-10-06T00:30:00Z")).state).toBe("RUNNING"); // overnight is paused
    expect(timerState({ completedAt: null, endedAt: null }, dueAt, warnAt, new Date("2026-10-06T09:50:00Z")).state).toBe("WARNED");
    expect(timerState({ completedAt: null, endedAt: null }, dueAt, warnAt, new Date("2026-10-06T10:00:00Z")).state).toBe("BREACHED");
  });
});

describe("policy input", () => {
  const base = { name: "Default", ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200 };
  it("accepts nested targets and applies defaults", () => {
    const p = policyInputSchema.parse(base);
    expect([p.warnAtPct, p.teamId, p.priority, p.calendarId]).toEqual([80, null, null, null]);
  });
  it("rejects targets that are not nested, non-positive, too large, or a warning percentage outside 1-99", () => {
    const bad = (o: object) => policyInputSchema.safeParse({ ...base, ...o }).success;
    expect(bad({ ackTargetSec: 20_000 })).toBe(false); // ack longer than response
    expect(bad({ responseTargetSec: 200_000 })).toBe(false);
    expect(bad({ resolveTargetSec: 300_000 })).toBe(false);
    expect(bad({ ackTargetSec: 0 })).toBe(false);
    expect(bad({ ackTargetSec: -5 })).toBe(false);
    expect(bad({ closeTargetSec: 400 * 86_400 })).toBe(false);
    expect(bad({ warnAtPct: 0 })).toBe(false);
    expect(bad({ warnAtPct: 100 })).toBe(false);
    expect(bad({ name: "  " })).toBe(false);
    expect(bad({ priority: "CRITICAL" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ responseTargetSec: base.ackTargetSec })).toBe(true); // equal is fine
  });
});

describe("resolvePolicy", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const T2 = "22222222-2222-4222-8222-222222222222";
  const S1 = "33333333-3333-4333-8333-333333333333";
  const rec = (id: string, name: string, scope: Partial<PolicyRecord> = {}): PolicyRecord => ({
    id, name, teamId: null, monitoredSourceId: null, priority: null, ackTargetSec: 1, responseTargetSec: 2, resolveTargetSec: 3, closeTargetSec: 4, calendarId: null, warnAtPct: 80, ...scope,
  });
  const item = { teamId: T1, monitoredSourceId: S1, priority: "URGENT" as const };

  it("falls back to the organization default, and returns null when nothing matches", () => {
    expect(resolvePolicy([rec("a", "Default")], item)?.id).toBe("a");
    expect(resolvePolicy([rec("a", "Other team", { teamId: T2 })], item)).toBeNull();
    expect(resolvePolicy([], item)).toBeNull();
  });
  it("requires every set scope field to match", () => {
    expect(resolvePolicy([rec("a", "A", { teamId: T1, priority: "LOW" })], item)).toBeNull();
    expect(resolvePolicy([rec("a", "A", { teamId: T1, priority: "URGENT" })], item)?.id).toBe("a");
  });
  it("prefers the more specific policy: source over team over priority", () => {
    const all = [rec("d", "Default"), rec("p", "Urgent", { priority: "URGENT" }), rec("t", "Team", { teamId: T1 }), rec("s", "Source", { monitoredSourceId: S1 })];
    expect(resolvePolicy(all, item)?.id).toBe("s");
    expect(resolvePolicy(all.filter((p) => p.id !== "s"), item)?.id).toBe("t");
    expect(resolvePolicy(all.filter((p) => p.id === "d" || p.id === "p"), item)?.id).toBe("p");
    expect(resolvePolicy([rec("tp", "Team+priority", { teamId: T1, priority: "URGENT" }), rec("t", "Team", { teamId: T1 })], item)?.id).toBe("tp");
  });
  it("is deterministic: ties go to the earlier name then id, whatever the order given", () => {
    const a = rec("1", "Alpha", { teamId: T1 });
    const b = rec("2", "Beta", { teamId: T1 });
    expect(resolvePolicy([b, a], item)?.id).toBe("1");
    expect(resolvePolicy([a, b], item)?.id).toBe("1");
  });
});
