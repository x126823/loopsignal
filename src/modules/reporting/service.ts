// Dashboards. Computed live from lifecycle events and SLA timers, scoped to what the viewer may see; nothing is stored, so there is
// no second source of truth to drift (MetricSnapshot stays unused until scale needs it). Read-only: this module writes nothing.
import type { Clock } from "@/lib/clock";
import { can, type Principal } from "@/modules/identity";
import { listItemsForReporting } from "@/modules/lifecycle";
import { listTimerStates } from "@/modules/sla";
import { listTeams } from "@/modules/tenancy";
import { buildDashboard, type DashboardData } from "./aggregate";

export const WINDOW_DAYS = [7, 30, 90, 365] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_WINDOW_DAYS: WindowDays = 30;

export interface Dashboard {
  window: { from: Date; to: Date; days: WindowDays };
  /** The one team being shown, or null for everything the viewer may see. */
  teamId: string | null;
  /** Teams the viewer may view, for the team picker and for naming rows. */
  teams: Array<{ id: string; name: string }>;
  data: DashboardData;
}

export const isWindowDays = (v: unknown): v is WindowDays => typeof v === "number" && (WINDOW_DAYS as readonly number[]).includes(v);

/**
 * The dashboard for a principal: only items they may view, in a window ending now, optionally for one team they may view (any
 * other team id yields an empty dashboard, never an error that reveals it exists). The caller supplies the clock.
 */
export async function getDashboard(principal: Principal, opts: { days?: number; teamId?: string | null }, deps: { clock: Clock }): Promise<Dashboard> {
  const days = isWindowDays(opts.days) ? opts.days : DEFAULT_WINDOW_DAYS;
  const to = deps.clock.now();
  const from = new Date(to.getTime() - days * 86_400_000);
  const viewable = (await listTeams(principal.organizationId)).filter((t) => can(principal, "item:view", { organizationId: principal.organizationId, teamId: t.id }));
  const teamId = opts.teamId && viewable.some((t) => t.id === opts.teamId) ? opts.teamId : null;
  if (opts.teamId && !teamId) return { window: { from, to, days }, teamId: null, teams: viewable, data: buildDashboard([], []) };

  const items = await listItemsForReporting(principal, { from, to, ...(teamId ? { teamId } : {}) });
  const timers = await listTimerStates(principal, items.map((i) => i.id), deps);
  return { window: { from, to, days }, teamId, teams: viewable, data: buildDashboard(items, timers) };
}
