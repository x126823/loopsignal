import { z } from "zod";

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type PriorityName = (typeof PRIORITIES)[number];

const MAX_TARGET_SEC = 366 * 24 * 3600;
const target = z.number().int().positive().max(MAX_TARGET_SEC);

/** What a person supplies. Targets are in seconds of BUSINESS time when a calendar is set, otherwise of continuous time. */
export const policyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Scope. Leave all three empty for an organization-wide default. */
    teamId: z.string().uuid().nullable().default(null),
    monitoredSourceId: z.string().uuid().nullable().default(null),
    priority: z.enum(PRIORITIES).nullable().default(null),
    ackTargetSec: target,
    responseTargetSec: target,
    resolveTargetSec: target,
    closeTargetSec: target,
    calendarId: z.string().uuid().nullable().default(null),
    warnAtPct: z.number().int().min(1).max(99).default(80),
  })
  .strict()
  .superRefine((p, ctx) => {
    // The four obligations are nested: you cannot be allowed longer to acknowledge than to respond, and so on.
    const order: Array<[keyof typeof p, keyof typeof p]> = [["ackTargetSec", "responseTargetSec"], ["responseTargetSec", "resolveTargetSec"], ["resolveTargetSec", "closeTargetSec"]];
    for (const [a, b] of order) if ((p[a] as number) > (p[b] as number)) ctx.addIssue({ code: "custom", path: [a], message: `${a} must not exceed ${b}` });
  });
export type PolicyInput = z.infer<typeof policyInputSchema>;

export interface PolicyRecord {
  id: string;
  name: string;
  teamId: string | null;
  monitoredSourceId: string | null;
  priority: PriorityName | null;
  ackTargetSec: number;
  responseTargetSec: number;
  resolveTargetSec: number;
  closeTargetSec: number;
  calendarId: string | null;
  warnAtPct: number;
}

export interface ItemScope {
  teamId: string;
  monitoredSourceId: string | null;
  priority: PriorityName;
}

/** Specificity weights: a policy for a specific source outranks one for a team, which outranks one for a priority. */
const WEIGHT = { source: 4, team: 2, priority: 1 } as const;

/**
 * The most specific policy whose every set scope field matches the item. A policy with no scope matches everything (the
 * organization default). More specific wins (source over team over priority, summed); ties go to the earlier name, then id,
 * so the answer never depends on row order.
 */
export function resolvePolicy(policies: readonly PolicyRecord[], item: ItemScope): PolicyRecord | null {
  const matches = policies.filter(
    (p) => (p.teamId === null || p.teamId === item.teamId) && (p.monitoredSourceId === null || p.monitoredSourceId === item.monitoredSourceId) && (p.priority === null || p.priority === item.priority),
  );
  const score = (p: PolicyRecord) => (p.monitoredSourceId ? WEIGHT.source : 0) + (p.teamId ? WEIGHT.team : 0) + (p.priority ? WEIGHT.priority : 0);
  return [...matches].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0] ?? null;
}
