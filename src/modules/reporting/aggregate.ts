// Pure aggregation for dashboards. Everything is derived from lifecycle events and timer states handed in; nothing is stored,
// edited or read from a clock here (rule 4: the four metrics are derived from events and tracked separately).
//
// Definitions (kept deliberately plain so they can be explained to the people reading them):
//  - An item is "in the window" when its CURRENT cycle began inside it (receipt, or the reopening that started the cycle).
//  - Each metric is a duration from the start of that cycle to ITS OWN event. They never substitute for each other:
//      acknowledgment (ACKNOWLEDGED), first substantive response (RESPONDED), resolution (RESOLUTION_CONFIRMED, never a
//      proposal), closure (CLOSED, never a confirmation).
//  - "Pending" is an item in the window that has not reached that event yet in its current cycle.
//  - Percentiles use the nearest-rank method on achieved durations only.
//  - SLA attainment for a timer type is met / (met + breached) over the current cycle's timers; running, due-soon and
//    cancelled timers are not yet decided and are counted separately.
import { deriveMetrics, cycleStartOf, type ReportingItem } from "@/modules/lifecycle";
import type { TimerStateRow, TimerState, TimerType } from "@/modules/sla";

export const METRIC_KEYS = ["acknowledgment", "response", "resolution", "closure"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface MetricSummary {
  /** Items that reached this event in their current cycle. */
  achieved: number;
  /** Items in the window that have not reached it yet. */
  pending: number;
  medianSec: number | null;
  p90Sec: number | null;
}

export interface SlaSummary {
  met: number;
  breached: number;
  warned: number;
  running: number;
  cancelled: number;
  /** met / (met + breached) as a whole percent, or null when nothing has been decided. */
  attainmentPct: number | null;
}

export interface AttentionItem {
  itemId: string;
  teamId: string;
  title: string;
  priority: ReportingItem["priority"];
  state: ReportingItem["state"];
  /** Timer types currently overdue on this open item. */
  overdue: TimerType[];
  dueSoon: TimerType[];
}

export interface Rollup {
  items: number;
  open: number;
  closed: number;
  reopened: number;
  byState: Partial<Record<ReportingItem["state"], number>>;
  metrics: Record<MetricKey, MetricSummary>;
  sla: Record<TimerType, SlaSummary>;
  breachedTimers: number;
}

export interface DashboardData extends Rollup {
  teams: Array<{ teamId: string; rollup: Rollup }>;
  attention: AttentionItem[];
}

const TIMER_TYPES: TimerType[] = ["ACK", "RESPONSE", "RESOLVE", "CLOSE"];

/** Nearest-rank percentile of a list of numbers (p in 1..100). Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

const seconds = (from: Date, to: Date): number => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

function summarizeMetric(durations: number[], inWindow: number): MetricSummary {
  return { achieved: durations.length, pending: inWindow - durations.length, medianSec: percentile(durations, 50), p90Sec: percentile(durations, 90) };
}

function summarizeSla(rows: readonly TimerStateRow[], type: TimerType): SlaSummary {
  const of = (s: TimerState) => rows.filter((r) => r.type === type && r.state === s).length;
  const met = of("MET");
  const breached = of("BREACHED");
  return { met, breached, warned: of("WARNED"), running: of("RUNNING"), cancelled: of("CANCELLED"), attainmentPct: met + breached === 0 ? null : Math.round((met * 100) / (met + breached)) };
}

function rollup(items: readonly ReportingItem[], timers: readonly TimerStateRow[]): Rollup {
  const derived = items.map((i) => ({ item: i, d: deriveMetrics(i.events), start: cycleStartOf(i.events)! }));
  const byState: Rollup["byState"] = {};
  for (const { d } of derived) byState[d.state] = (byState[d.state] ?? 0) + 1;

  const durations = (pick: (d: ReturnType<typeof deriveMetrics>) => Date | null) =>
    derived.flatMap(({ d, start }) => { const at = pick(d); return at ? [seconds(start, at)] : []; });
  const n = derived.length;
  const metrics: Rollup["metrics"] = {
    acknowledgment: summarizeMetric(durations((d) => d.ackAt), n),
    response: summarizeMetric(durations((d) => d.firstSubstantiveResponseAt), n),
    resolution: summarizeMetric(durations((d) => d.resolvedAt), n),
    closure: summarizeMetric(durations((d) => d.closedAt), n),
  };

  // Only timers of each item's current cycle, so a reopened item is not judged on its earlier cycles.
  const currentCycle = new Map(derived.map(({ item, d }) => [item.id, d.cycle]));
  const current = timers.filter((t) => currentCycle.get(t.itemId) === t.cycle);
  const sla = Object.fromEntries(TIMER_TYPES.map((t) => [t, summarizeSla(current, t)])) as Rollup["sla"];

  return {
    items: n,
    open: derived.filter(({ d }) => d.state !== "CLOSED").length,
    closed: derived.filter(({ d }) => d.state === "CLOSED").length,
    reopened: derived.filter(({ d }) => d.reopenCount > 0).length,
    byState, metrics, sla,
    breachedTimers: current.filter((t) => t.state === "BREACHED").length,
  };
}

/** Roll up items (already authorized and windowed by the caller) and their timers: overall, per team, and what needs attention. */
export function buildDashboard(items: readonly ReportingItem[], timers: readonly TimerStateRow[]): DashboardData {
  const all = rollup(items, timers);
  const teamIds = [...new Set(items.map((i) => i.teamId))].sort();
  const teams = teamIds.map((teamId) => {
    const mine = items.filter((i) => i.teamId === teamId);
    const ids = new Set(mine.map((i) => i.id));
    return { teamId, rollup: rollup(mine, timers.filter((t) => ids.has(t.itemId))) };
  });

  const attention: AttentionItem[] = [];
  const order: Record<ReportingItem["priority"], number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  for (const item of items) {
    const d = deriveMetrics(item.events);
    if (d.state === "CLOSED") continue; // nothing left to chase
    const mine = timers.filter((t) => t.itemId === item.id && t.cycle === d.cycle);
    const overdue = TIMER_TYPES.filter((ty) => mine.some((t) => t.type === ty && t.state === "BREACHED"));
    const dueSoon = TIMER_TYPES.filter((ty) => mine.some((t) => t.type === ty && t.state === "WARNED"));
    if (overdue.length > 0 || dueSoon.length > 0) attention.push({ itemId: item.id, teamId: item.teamId, title: item.title, priority: item.priority, state: d.state, overdue, dueSoon });
  }
  attention.sort((a, b) => b.overdue.length - a.overdue.length || order[a.priority] - order[b.priority] || a.itemId.localeCompare(b.itemId));
  return { ...all, teams, attention };
}
