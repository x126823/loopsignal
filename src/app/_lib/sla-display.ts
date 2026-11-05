// Pure helpers for showing SLA timers. No data access: the page passes in what it loaded.
import type { TimerState, TimerType, TimerView } from "@/modules/sla";

export const TIMER_LABEL: Record<TimerType, string> = {
  ACK: "Acknowledge",
  RESPONSE: "First substantive response",
  RESOLVE: "Resolve",
  CLOSE: "Close",
};

export const TIMER_STATE_LABEL: Record<TimerState, string> = {
  RUNNING: "On track",
  WARNED: "Due soon",
  BREACHED: "Overdue",
  MET: "Met",
  CANCELLED: "Not needed",
};

export const TIMER_STATE_TONE: Record<TimerState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  RUNNING: "info", WARNED: "warning", BREACHED: "danger", MET: "success", CANCELLED: "neutral",
};

const ORDER: Record<TimerType, number> = { ACK: 0, RESPONSE: 1, RESOLVE: 2, CLOSE: 3 };

/** Timers of the latest cycle only (a reopen starts a new set), in the order people think about them. */
export function currentTimers(timers: readonly TimerView[]): TimerView[] {
  const cycle = Math.max(0, ...timers.map((t) => t.cycle));
  return timers.filter((t) => t.cycle === cycle).sort((a, b) => ORDER[a.type] - ORDER[b.type]);
}

export const RISK_LABEL = { LOW: "Low risk", MEDIUM: "Medium risk", HIGH: "High risk" } as const;
export const RISK_TONE = { LOW: "success", MEDIUM: "warning", HIGH: "danger" } as const;
export type RiskLevel = keyof typeof RISK_LABEL;

/**
 * The newest AI risk estimate, but only while some timer is actually due soon: an estimate about a window that has since closed
 * would mislead. Returns null otherwise. It is a hint for people and is labelled that way where it is shown.
 */
export function riskHint(timers: readonly TimerView[], analyses: ReadonlyArray<{ analyzer: string; result: unknown }>): RiskLevel | null {
  if (!timers.some((t) => t.state === "WARNED")) return null;
  const latest = analyses.find((a) => a.analyzer === "sla_risk_analyzer"); // newest first
  const risk = (latest?.result as { risk?: unknown } | null | undefined)?.risk;
  return risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" ? risk : null;
}
