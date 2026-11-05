import type { ItemState } from "../../../generated/prisma/enums";

/**
 * SLA timers are a pure function of an item's lifecycle events, the due dates fixed when each timer was created, and the
 * current time. Nothing is edited by hand (rule 4): a timer is "met" because the event exists, and replaying this against
 * the same events always gives the same answer, however late it runs.
 *
 * Rules (decided with the user):
 *  - All four timers start together when a cycle starts: at receipt for the first cycle, at the REOPENED event for later ones.
 *  - ACK is met by the earlier of the acknowledgment and the first substantive response, since an answer plainly acknowledges
 *    the request. (The item's own acknowledgment metric is unaffected: rule 5 still holds.)
 *  - A timer that completes after its due time is BREACHED (late), not MET.
 *  - When a cycle ends (the item is closed, or reopened) a timer still incomplete is BREACHED if it was already overdue, and
 *    otherwise CANCELLED. Items never alarm after they are finished.
 *  - A reopen starts a new cycle with its own timers; earlier cycles keep their history.
 */
export type TimerType = "ACK" | "RESPONSE" | "RESOLVE" | "CLOSE";
export const TIMER_TYPES: readonly TimerType[] = ["ACK", "RESPONSE", "RESOLVE", "CLOSE"];
export type TimerState = "RUNNING" | "WARNED" | "MET" | "BREACHED" | "CANCELLED";

export interface EventLite {
  seq: number;
  cycle: number;
  toState: ItemState;
  createdAt: Date;
}

export interface PlannedTimer {
  cycle: number;
  type: TimerType;
  startedAt: Date;
  /** When the metric event happened, or null if it has not (yet). */
  completedAt: Date | null;
  /** When the cycle ended without this timer completing (closure or reopening), or null if the cycle is still going. */
  endedAt: Date | null;
}

const first = (events: readonly EventLite[], state: ItemState): Date | null => events.find((e) => e.toState === state)?.createdAt ?? null;
const earliest = (...dates: Array<Date | null>): Date | null => {
  const real = dates.filter((d): d is Date => d !== null);
  return real.length === 0 ? null : new Date(Math.min(...real.map((d) => d.getTime())));
};

/** What should exist, independent of any policy: each cycle's four timers with their start and completion. */
export function planTimers(allEvents: readonly EventLite[]): PlannedTimer[] {
  const events = [...allEvents].sort((a, b) => a.seq - b.seq);
  if (events.length === 0) return [];
  const cycles = [...new Set(events.map((e) => e.cycle))].sort((a, b) => a - b);
  const out: PlannedTimer[] = [];

  for (const cycle of cycles) {
    const inCycle = events.filter((e) => e.cycle === cycle);
    // A cycle starts at its first event: RECEIVED for the first, REOPENED for the rest.
    const startedAt = inCycle[0]!.createdAt;
    const nextStart = events.find((e) => e.cycle === cycle + 1)?.createdAt ?? null;
    const closedAt = first(inCycle, "CLOSED");
    const endedAt = closedAt ?? nextStart; // work in this cycle stopped here

    const responseAt = first(inCycle, "RESPONDED");
    const completion: Record<TimerType, Date | null> = {
      ACK: earliest(first(inCycle, "ACKNOWLEDGED"), responseAt),
      RESPONSE: responseAt,
      RESOLVE: first(inCycle, "RESOLUTION_CONFIRMED"),
      CLOSE: closedAt,
    };
    for (const type of TIMER_TYPES) out.push({ cycle, type, startedAt, completedAt: completion[type], endedAt: completion[type] ? null : endedAt });
  }
  return out;
}

/** A timer's state and the instant it was settled (null while it is still open), given its fixed due and warn times. */
export function timerState(
  t: Pick<PlannedTimer, "completedAt" | "endedAt">, dueAt: Date, warnAt: Date, now: Date,
): { state: TimerState; resolvedAt: Date | null } {
  if (t.completedAt) return { state: t.completedAt.getTime() <= dueAt.getTime() ? "MET" : "BREACHED", resolvedAt: t.completedAt };
  if (t.endedAt) return { state: dueAt.getTime() <= t.endedAt.getTime() ? "BREACHED" : "CANCELLED", resolvedAt: t.endedAt };
  if (now.getTime() >= dueAt.getTime()) return { state: "BREACHED", resolvedAt: null }; // overdue and still open
  if (now.getTime() >= warnAt.getTime()) return { state: "WARNED", resolvedAt: null };
  return { state: "RUNNING", resolvedAt: null };
}
