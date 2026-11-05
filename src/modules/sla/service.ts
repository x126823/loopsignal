import { Prisma } from "../../../generated/prisma/client";
import type { Clock } from "@/lib/clock";
import { listOrganizationsWithSlaPolicies, withTenant, type TenantTx } from "@/lib/db";
import { log } from "@/lib/log";
import { recordAudit } from "@/modules/audit";
import { assertCan, can, type Principal } from "@/modules/identity";
import { loadMessageContext } from "@/modules/ingestion";
import { listOpenItemIds, loadItemForSla } from "@/modules/lifecycle";
import { addBusinessSeconds, businessSecondsBetween, calendarSchema, type BusinessCalendar } from "./calendar";
import { planTimers, timerState, type TimerState, type TimerType } from "./derive";
import { policyInputSchema, resolvePolicy, type ItemScope, type PolicyInput, type PolicyRecord } from "./policy";

export interface SlaDeps {
  clock: Clock;
}

export class SlaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlaConfigError";
  }
}

export interface PolicyWithCalendar extends PolicyRecord {
  calendar: BusinessCalendar | null;
}

async function loadPolicies(tx: TenantTx): Promise<PolicyWithCalendar[]> {
  const [policies, calendars] = await Promise.all([tx.slaPolicy.findMany(), tx.businessCalendar.findMany()]);
  const byId = new Map(calendars.map((c) => [c.id, c]));
  return policies.map((p) => {
    const raw = p.calendarId ? byId.get(p.calendarId) : undefined;
    // A stored calendar that no longer validates is treated as unusable rather than guessed at: fall back to continuous time.
    const parsed = raw ? calendarSchema.safeParse({ timezone: raw.timezone, hours: raw.hours, holidays: raw.holidays }) : null;
    return {
      id: p.id, name: p.name, teamId: p.teamId, monitoredSourceId: p.monitoredSourceId, priority: p.priority, ackTargetSec: p.ackTargetSec,
      responseTargetSec: p.responseTargetSec, resolveTargetSec: p.resolveTargetSec, closeTargetSec: p.closeTargetSec, calendarId: p.calendarId,
      warnAtPct: p.warnAtPct, calendar: parsed?.success ? parsed.data : null,
    };
  });
}

/** The policy id that applies to an item with this scope (for example at creation), or null if the organization has none. */
export async function resolvePolicyFor(organizationId: string, scope: ItemScope): Promise<{ id: string } | null> {
  const policies = await withTenant({ organizationId }, loadPolicies);
  const hit = resolvePolicy(policies, scope);
  return hit ? { id: hit.id } : null;
}

const TARGET_OF: Record<TimerType, "ackTargetSec" | "responseTargetSec" | "resolveTargetSec" | "closeTargetSec"> = {
  ACK: "ackTargetSec", RESPONSE: "responseTargetSec", RESOLVE: "resolveTargetSec", CLOSE: "closeTargetSec",
};

const OPEN_RANK: Partial<Record<TimerState, number>> = { RUNNING: 0, WARNED: 1, BREACHED: 2 };
/** True when moving from the stored state to the computed one would go backwards among the open states (clock skew, not events). */
function regresses(stored: TimerState, computed: TimerState): boolean {
  const from = OPEN_RANK[stored];
  const to = OPEN_RANK[computed];
  return from !== undefined && to !== undefined && to < from;
}

export interface TimerRef {
  organizationId: string;
  itemId: string;
  timerId: string;
  type: TimerType;
  cycle: number;
}

export interface ReconcileResult {
  skipped?: "ITEM_NOT_FOUND" | "NO_POLICY";
  /** Timers that crossed into the warning window during this call. */
  warned: TimerRef[];
  /** Breaches recorded during this call (each timer is breached once, however many workers race). */
  breached: TimerRef[];
}

/**
 * Bring an item's SLA timers in line with its lifecycle events and the clock. Idempotent and replay-safe: the result depends
 * only on the events, the due dates fixed when each timer was created, and `clock.now()`. Run it as often as you like, in any
 * order, from several workers at once.
 *
 *  - New timers get their due and warning times from the item's policy, in business time when the policy has a calendar.
 *  - Existing timers keep their due times, so editing a policy never re-times work already in flight.
 *  - Each timer in BREACHED state gets exactly one SlaBreach row (breached at its due time) and one audit entry.
 */
export async function reconcileItem(organizationId: string, itemId: string, deps: SlaDeps): Promise<ReconcileResult> {
  const now = deps.clock.now();
  const facts = await loadItemForSla(organizationId, itemId);
  if (!facts) return { skipped: "ITEM_NOT_FOUND", warned: [], breached: [] };
  const planned = planTimers(facts.events);
  const sourceId = facts.slaPolicyId ? null : ((await loadMessageContext(organizationId, facts.originMessageId))?.monitoredSourceId ?? null);

  return withTenant({ organizationId }, async (tx) => {
    const policies = await loadPolicies(tx);
    const policy = facts.slaPolicyId ? policies.find((p) => p.id === facts.slaPolicyId) : resolvePolicy(policies, { teamId: facts.teamId, monitoredSourceId: sourceId, priority: facts.priority });
    if (!policy) return { skipped: "NO_POLICY" as const, warned: [], breached: [] };
    const calendar = (policy as PolicyWithCalendar).calendar ?? null;

    const before = await tx.slaTimer.findMany({ where: { itemId } });
    const key = (cycle: number, type: string) => `${cycle}:${type}`;
    const had = new Map(before.map((t) => [key(t.cycle, t.type), t]));

    // 1. Create what is missing. Due and warning times are fixed here and never recomputed.
    const missing = planned.filter((t) => !had.has(key(t.cycle, t.type)));
    if (missing.length > 0) {
      await tx.slaTimer.createMany({
        data: missing.map((t) => {
          const target = policy[TARGET_OF[t.type]];
          const dueAt = addBusinessSeconds(t.startedAt, target, calendar);
          const warnAt = addBusinessSeconds(t.startedAt, Math.floor((target * policy.warnAtPct) / 100), calendar);
          const s = timerState(t, dueAt, warnAt, now);
          return { organizationId, itemId, cycle: t.cycle, type: t.type, startedAt: t.startedAt, dueAt, warnAt, state: s.state, resolvedAt: s.resolvedAt };
        }),
        skipDuplicates: true, // a concurrent reconcile may have created them first
      });
    }

    // 2. Settle every timer's state from events and the clock, using its own fixed due and warning times.
    const rows = await tx.slaTimer.findMany({ where: { itemId } });
    const warned: TimerRef[] = [];
    const breachedTimers: Array<(typeof rows)[number]> = [];
    for (const row of rows) {
      const t = planned.find((p) => p.cycle === row.cycle && p.type === row.type);
      if (!t) continue;
      const warnAt = row.warnAt ?? addBusinessSeconds(t.startedAt, Math.floor((policy[TARGET_OF[t.type]] * policy.warnAtPct) / 100), calendar);
      const computed = timerState(t, row.dueAt, warnAt, now);
      // A worker whose clock runs behind must never walk an overdue or due-soon timer backwards. Only the still-open states are
      // ordered this way; a timer that is completed, ended or cancelled is settled by events, not by the clock.
      const s = regresses(row.state, computed.state) ? { state: row.state, resolvedAt: row.resolvedAt } : computed;
      const changed = s.state !== row.state || (s.resolvedAt?.getTime() ?? null) !== (row.resolvedAt?.getTime() ?? null) || row.warnAt === null;
      if (changed) await tx.slaTimer.update({ where: { id: row.id }, data: { state: s.state, resolvedAt: s.resolvedAt, warnAt } });
      const prior = had.get(key(row.cycle, row.type))?.state ?? null;
      if (s.state === "WARNED" && prior !== "WARNED") warned.push({ organizationId, itemId, timerId: row.id, type: row.type, cycle: row.cycle });
      if (s.state === "BREACHED") breachedTimers.push(row);
    }

    // 3. Exactly one breach record per breached timer (late completions count), and one audit entry when it is first recorded.
    const breached: TimerRef[] = [];
    for (const row of breachedTimers) {
      const { count } = await tx.slaBreach.createMany({ data: [{ organizationId, timerId: row.id, breachedAt: row.dueAt }], skipDuplicates: true });
      if (count === 1) {
        await recordAudit(tx, {
          organizationId, actorType: "SYSTEM", actorId: "sla-engine", action: "sla.timer_breached", entityType: "TrackedItem", entityId: itemId,
          metadata: { timerId: row.id, timerType: row.type, cycle: row.cycle, dueAt: row.dueAt.toISOString() },
        });
        breached.push({ organizationId, itemId, timerId: row.id, type: row.type, cycle: row.cycle });
      }
    }
    return { warned, breached };
  });
}

export interface TimerView {
  id: string;
  cycle: number;
  type: TimerType;
  startedAt: Date;
  dueAt: Date;
  warnAt: Date | null;
  /** State as of now, even if the next scan has not run yet. */
  state: TimerState;
  resolvedAt: Date | null;
}

/** An item's timers for display, or null if the principal may not view the item. Read-only; nothing is written. */
export async function getItemTimers(principal: Principal, itemId: string, deps: SlaDeps): Promise<TimerView[] | null> {
  const facts = await loadItemForSla(principal.organizationId, itemId);
  if (!facts || !can(principal, "item:view", { organizationId: principal.organizationId, teamId: facts.teamId })) return null;
  const now = deps.clock.now();
  const rows = await withTenant({ organizationId: principal.organizationId, userId: principal.userId }, (tx) => tx.slaTimer.findMany({ where: { itemId }, orderBy: [{ cycle: "asc" }, { startedAt: "asc" }] }));
  const order: Record<string, number> = { ACK: 0, RESPONSE: 1, RESOLVE: 2, CLOSE: 3 };
  return rows
    .map((r): TimerView => {
      const open = r.resolvedAt === null && (r.state === "RUNNING" || r.state === "WARNED" || r.state === "BREACHED");
      const state = open ? timerState({ completedAt: null, endedAt: null }, r.dueAt, r.warnAt ?? r.dueAt, now).state : r.state;
      return { id: r.id, cycle: r.cycle, type: r.type, startedAt: r.startedAt, dueAt: r.dueAt, warnAt: r.warnAt, state, resolvedAt: r.resolvedAt };
    })
    .sort((a, b) => a.cycle - b.cycle || (order[a.type] ?? 0) - (order[b.type] ?? 0));
}

export interface TimerProgress {
  type: TimerType;
  state: TimerState;
  /** How much of the allowed time is used, in business time when the policy has a calendar. 100 means exactly due. Whole number. */
  percentElapsed: number;
}

/**
 * Where an unfinished timer stands right now, for the advisory risk analyzer. Null when the timer does not exist or is already
 * settled (met or cancelled), because there is nothing left to estimate. Read-only.
 */
export async function timerProgress(organizationId: string, itemId: string, timerId: string, deps: SlaDeps): Promise<TimerProgress | null> {
  const now = deps.clock.now();
  const facts = await loadItemForSla(organizationId, itemId);
  if (!facts) return null;
  const sourceId = facts.slaPolicyId ? null : ((await loadMessageContext(organizationId, facts.originMessageId))?.monitoredSourceId ?? null);
  return withTenant({ organizationId }, async (tx) => {
    const timer = await tx.slaTimer.findFirst({ where: { id: timerId, itemId } });
    if (!timer || timer.resolvedAt !== null || (timer.state !== "RUNNING" && timer.state !== "WARNED")) return null;
    const policies = await loadPolicies(tx);
    const policy = facts.slaPolicyId ? policies.find((p) => p.id === facts.slaPolicyId) : resolvePolicy(policies, { teamId: facts.teamId, monitoredSourceId: sourceId, priority: facts.priority });
    const calendar = (policy as PolicyWithCalendar | undefined)?.calendar ?? null;
    const total = businessSecondsBetween(timer.startedAt, timer.dueAt, calendar);
    const used = businessSecondsBetween(timer.startedAt, now, calendar);
    const percentElapsed = total === 0 ? (now >= timer.dueAt ? 100 : 0) : Math.min(999, Math.floor((used * 100) / total));
    const state = timerState({ completedAt: null, endedAt: null }, timer.dueAt, timer.warnAt ?? timer.dueAt, now).state;
    return { type: timer.type, state, percentElapsed };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------------------------------

export interface ScanResult {
  items: number;
  warned: TimerRef[];
  breached: TimerRef[];
  failures: number;
}

/**
 * Re-check every item in an organization that could have a timer change: items that are not closed, plus items whose timers
 * are still unsettled (so a just-closed item's timers are finalized). One failing item never stops the rest.
 */
export async function scanOrganization(organizationId: string, deps: SlaDeps): Promise<ScanResult> {
  const unsettled = await withTenant({ organizationId }, (tx) =>
    tx.slaTimer.findMany({ where: { resolvedAt: null, state: { in: ["RUNNING", "WARNED", "BREACHED"] } }, select: { itemId: true }, distinct: ["itemId"] }));
  const ids = [...new Set([...(await listOpenItemIds(organizationId)), ...unsettled.map((t) => t.itemId)])];
  const out: ScanResult = { items: ids.length, warned: [], breached: [], failures: 0 };
  for (const id of ids) {
    try {
      const r = await reconcileItem(organizationId, id, deps);
      out.warned.push(...r.warned);
      out.breached.push(...r.breached);
    } catch (e) {
      out.failures++;
      log("error", "sla.reconcile_failed", { organizationId, itemId: id, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return out;
}

export interface ScanAllResult extends ScanResult {
  organizations: number;
}

/** Scan every organization that has SLA policies. Each is processed under its own tenant context. */
export async function scanAll(deps: SlaDeps): Promise<ScanAllResult> {
  const orgs = await listOrganizationsWithSlaPolicies();
  const total: ScanAllResult = { organizations: orgs.length, items: 0, warned: [], breached: [], failures: 0 };
  for (const org of orgs) {
    try {
      const r = await scanOrganization(org, deps);
      total.items += r.items;
      total.warned.push(...r.warned);
      total.breached.push(...r.breached);
      total.failures += r.failures;
    } catch (e) {
      total.failures++;
      log("error", "sla.scan_organization_failed", { organizationId: org, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  log("info", "sla.scanned", { organizations: total.organizations, items: total.items, warned: total.warned.length, breached: total.breached.length, failures: total.failures });
  return total;
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration (organization administrators only, audited)
// ---------------------------------------------------------------------------------------------------------------------

const asConfigError = (e: unknown, what: string): never => {
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || e.code === "P2003")) {
    throw new SlaConfigError(e.code === "P2002" ? `${what} name is already in use` : `${what} refers to a team, source or calendar that does not exist in this organization`);
  }
  throw e;
};

export async function createCalendar(principal: Principal, input: unknown): Promise<{ id: string }> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const parsed = calendarSchema.safeParse(input);
  if (!parsed.success) throw new SlaConfigError(`Invalid calendar: ${parsed.error.issues.map((i) => `${i.path.join(".") || "calendar"} ${i.message}`).join("; ")}`);
  const c = parsed.data;
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const row = await tx.businessCalendar.create({ data: { organizationId: principal.organizationId, timezone: c.timezone, hours: c.hours as unknown as Prisma.InputJsonObject, holidays: c.holidays } });
    await recordAudit(tx, { organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "sla.calendar_created", entityType: "BusinessCalendar", entityId: row.id, metadata: { timezone: c.timezone } });
    return { id: row.id };
  });
}

export async function createPolicy(principal: Principal, input: unknown): Promise<{ id: string }> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const parsed = policyInputSchema.safeParse(input);
  if (!parsed.success) throw new SlaConfigError(`Invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".") || "policy"} ${i.message}`).join("; ")}`);
  const p: PolicyInput = parsed.data;
  try {
    return await withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
      const row = await tx.slaPolicy.create({ data: { organizationId: principal.organizationId, ...p } });
      await recordAudit(tx, {
        organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "sla.policy_created", entityType: "SlaPolicy", entityId: row.id,
        metadata: { name: p.name, teamId: p.teamId, monitoredSourceId: p.monitoredSourceId, priority: p.priority, warnAtPct: p.warnAtPct },
      });
      return { id: row.id };
    });
  } catch (e) {
    return asConfigError(e, "Policy");
  }
}

export async function listPolicies(principal: Principal): Promise<Array<PolicyRecord & { calendarTimezone: string | null }>> {
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const policies = await loadPolicies(tx);
    return policies.map(({ calendar, ...p }) => ({ ...p, calendarTimezone: calendar?.timezone ?? null })).sort((a, b) => a.name.localeCompare(b.name));
  });
}
