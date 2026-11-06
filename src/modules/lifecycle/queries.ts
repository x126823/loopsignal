import { withTenant, type TenantTx } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { loadPolicy } from "./engine";
import { assertCan, can, ForbiddenError, type Principal } from "@/modules/identity";
import type { ItemState } from "../../../generated/prisma/enums";

export interface ThreadItem {
  id: string;
  state: ItemState;
  teamId: string;
  originMessageId: string;
  version: number;
  closedAt: Date | null;
}

/** The most recent item on a thread (open or closed), or null. Read-only. */
export async function findThreadItem(organizationId: string, threadId: string): Promise<ThreadItem | null> {
  return withTenant({ organizationId }, async (tx) => {
    const item = await tx.trackedItem.findFirst({ where: { threadId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    return item && { id: item.id, state: item.state, teamId: item.teamId, originMessageId: item.originMessageId, version: item.version, closedAt: item.closedAt };
  });
}

export type ReviewKind = "LOW_CONFIDENCE" | "CORRELATION" | "SCHEMA_FAILURE" | "OWNERSHIP";

/** Queue a human review task. Idempotent: an open task for the same subject is reused. Does not touch item state. */
export async function queueReviewTask(organizationId: string, task: { type: ReviewKind; refType: string; refId: string }): Promise<{ id: string; created: boolean }> {
  return withTenant({ organizationId }, async (tx) => {
    const open = await tx.reviewTask.findFirst({ where: { type: task.type, refType: task.refType, refId: task.refId, status: "OPEN" } });
    if (open) return { id: open.id, created: false };
    const created = await tx.reviewTask.create({ data: { organizationId, type: task.type, refType: task.refType, refId: task.refId } });
    return { id: created.id, created: true };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Authorized reads for people (the UI). Every function takes the caller's Principal and shows only what that principal may
// see: item visibility is the same `can(principal, "item:view", ...)` rule that guards actions. Nothing here writes state.
// ---------------------------------------------------------------------------------------------------------------------

export interface ItemSummary {
  id: string;
  title: string;
  state: ItemState;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  teamId: string;
  ownerUserId: string | null;
  ownerName: string | null;
  needsReview: boolean;
  version: number;
  reopenCount: number;
  createdAt: Date;
  ackAt: Date | null;
  firstSubstantiveResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

type ItemRow = Awaited<ReturnType<TenantTx["trackedItem"]["findFirstOrThrow"]>>;
const ctxOf = (p: Principal) => ({ organizationId: p.organizationId, userId: p.userId });
const nameOf = (u: { name: string | null; email: string }) => u.name ?? u.email.split("@")[0] ?? u.email;
const canView = (p: Principal, teamId: string) => can(p, "item:view", { organizationId: p.organizationId, teamId });

async function userNames(tx: TenantTx, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (unique.length === 0) return new Map();
  const users = await tx.user.findMany({ where: { id: { in: unique } } });
  return new Map(users.map((u) => [u.id, nameOf(u)]));
}

const summarize = (i: ItemRow, names: Map<string, string>): ItemSummary => ({
  id: i.id, title: i.title, state: i.state, priority: i.priority, teamId: i.teamId, ownerUserId: i.ownerUserId,
  ownerName: i.ownerUserId ? (names.get(i.ownerUserId) ?? null) : null, needsReview: i.needsReview, version: i.version, reopenCount: i.reopenCount,
  createdAt: i.createdAt, ackAt: i.ackAt, firstSubstantiveResponseAt: i.firstSubstantiveResponseAt, resolvedAt: i.resolvedAt, closedAt: i.closedAt,
});

/** Items the principal may view, newest first. `view` is "open" (not CLOSED), "closed", or "all". */
export async function listVisibleItems(principal: Principal, opts: { view?: "open" | "closed" | "all"; limit?: number } = {}): Promise<ItemSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return withTenant(ctxOf(principal), async (tx) => {
    const seeAll = principal.orgRole === "ORG_ADMIN" || principal.orgRole === "AUDITOR";
    const rows = await tx.trackedItem.findMany({
      where: {
        ...(opts.view === "closed" ? { state: "CLOSED" as const } : opts.view === "all" ? {} : { state: { not: "CLOSED" as const } }),
        ...(seeAll ? {} : { teamId: { in: Object.keys(principal.teamRoles) } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    const visible = rows.filter((r) => canView(principal, r.teamId));
    const names = await userNames(tx, visible.map((r) => r.ownerUserId));
    return visible.map((r) => summarize(r, names));
  });
}

export interface ItemEventView {
  seq: number;
  cycle: number;
  fromState: ItemState | null;
  toState: ItemState;
  actorType: "USER" | "SYSTEM" | "ANALYZER";
  /** A person's name for USER events, the analyzer's name for ANALYZER events, otherwise null. */
  actorLabel: string | null;
  reason: string | null;
  evidence: Array<{ quote: string }>;
  createdAt: Date;
}

export interface ApprovalView {
  id: string;
  requestedTransition: ItemState;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  reason: string | null;
  createdAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
}

export interface ItemDetail {
  item: ItemSummary & { threadId: string; originMessageId: string; teamName: string };
  events: ItemEventView[];
  approvals: ApprovalView[];
  openReviewTasks: Array<{ id: string; type: ReviewKind; createdAt: Date }>;
}

/** One item with its history, or null if it does not exist or the principal may not view it (callers should 404). */
export async function getItemDetail(principal: Principal, itemId: string): Promise<ItemDetail | null> {
  return withTenant(ctxOf(principal), async (tx) => {
    const item = await tx.trackedItem.findUnique({ where: { id: itemId } });
    if (!item || !canView(principal, item.teamId)) return null;
    const [events, approvals, reviews, team] = await Promise.all([
      tx.lifecycleEvent.findMany({ where: { itemId }, orderBy: { seq: "asc" } }),
      tx.approvalRequest.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } }),
      tx.reviewTask.findMany({ where: { refType: "TrackedItem", refId: itemId, status: "OPEN" }, orderBy: { createdAt: "asc" } }),
      tx.team.findUnique({ where: { id: item.teamId } }),
    ]);
    const names = await userNames(tx, [item.ownerUserId, ...events.filter((e) => e.actorType === "USER").map((e) => e.actorId), ...approvals.map((a) => a.decidedBy)]);
    return {
      item: { ...summarize(item, names), threadId: item.threadId, originMessageId: item.originMessageId, teamName: team?.name ?? "" },
      events: events.map((e) => ({
        seq: e.seq, cycle: e.cycle, fromState: e.fromState, toState: e.toState, actorType: e.actorType,
        actorLabel: e.actorType === "USER" ? (names.get(e.actorId ?? "") ?? null) : e.actorType === "ANALYZER" ? e.actorId : null,
        reason: e.reason, createdAt: e.createdAt,
        evidence: Array.isArray(e.evidence) ? (e.evidence as Array<{ quote?: unknown }>).flatMap((x) => (typeof x?.quote === "string" ? [{ quote: x.quote }] : [])) : [],
      })),
      approvals: approvals.map((a) => ({
        id: a.id, requestedTransition: a.requestedTransition, status: a.status, reason: a.reason, createdAt: a.createdAt,
        decidedByName: a.decidedBy ? (names.get(a.decidedBy) ?? null) : null, decidedAt: a.decidedAt,
      })),
      openReviewTasks: reviews.map((r) => ({ id: r.id, type: r.type, createdAt: r.createdAt })),
    };
  });
}

export interface PendingApproval {
  id: string;
  itemId: string;
  teamId: string;
  itemTitle: string;
  itemState: ItemState;
  requestedTransition: ItemState;
  reason: string | null;
  createdAt: Date;
}

/** Pending approval requests on items the principal may view, oldest first. */
export async function listPendingApprovals(principal: Principal): Promise<PendingApproval[]> {
  return withTenant(ctxOf(principal), async (tx) => {
    const pending = await tx.approvalRequest.findMany({ where: { status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const items = await tx.trackedItem.findMany({ where: { id: { in: pending.map((p) => p.itemId) } } });
    const byId = new Map(items.map((i) => [i.id, i]));
    return pending.flatMap((p): PendingApproval[] => {
      const item = byId.get(p.itemId);
      return item && canView(principal, item.teamId)
        ? [{ id: p.id, itemId: p.itemId, teamId: item.teamId, itemTitle: item.title, itemState: item.state, requestedTransition: p.requestedTransition, reason: p.reason, createdAt: p.createdAt }]
        : [];
    });
  });
}

export interface ReviewTaskView {
  id: string;
  type: ReviewKind;
  refType: string;
  refId: string;
  /** Set when the task is about an item the principal can view. */
  itemTitle: string | null;
  createdAt: Date;
}

/** Roles that work the review queue. VIEWERs do not see it. AUDITORs may read it but not resolve tasks. */
const REVIEW_READERS = new Set(["ORG_ADMIN", "TEAM_LEAD", "MEMBER", "AUDITOR"]);
const REVIEW_RESOLVERS = new Set(["ORG_ADMIN", "TEAM_LEAD", "MEMBER"]);

export async function listOpenReviewTasks(principal: Principal): Promise<ReviewTaskView[]> {
  if (!REVIEW_READERS.has(principal.orgRole)) return [];
  return withTenant(ctxOf(principal), async (tx) => {
    const tasks = await tx.reviewTask.findMany({ where: { status: "OPEN" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const items = await tx.trackedItem.findMany({ where: { id: { in: tasks.filter((t) => t.refType === "TrackedItem").map((t) => t.refId) } } });
    const byId = new Map(items.map((i) => [i.id, i]));
    return tasks.flatMap((t): ReviewTaskView[] => {
      if (t.refType !== "TrackedItem") return [{ id: t.id, type: t.type, refType: t.refType, refId: t.refId, itemTitle: null, createdAt: t.createdAt }];
      const item = byId.get(t.refId);
      return item && canView(principal, item.teamId) ? [{ id: t.id, type: t.type, refType: t.refType, refId: t.refId, itemTitle: item.title, createdAt: t.createdAt }] : [];
    });
  });
}

export type ReviewResolveOutcome = { outcome: "RESOLVED" } | { outcome: "DISMISSED" } | { outcome: "REJECTED"; reason: "NOT_FOUND" | "NOT_OPEN" | "DECISION_REQUIRED" };

/** A person closes a review task. Audited in the same transaction. Throws ForbiddenError if the role may not. */
export async function resolveReviewTask(principal: Principal, req: { id: string; status: "RESOLVED" | "DISMISSED"; resolution?: string }): Promise<ReviewResolveOutcome> {
  if (!REVIEW_RESOLVERS.has(principal.orgRole)) throw new ForbiddenError("item:act");
  return withTenant(ctxOf(principal), async (tx) => {
    const task = await tx.reviewTask.findUnique({ where: { id: req.id } });
    if (!task) return { outcome: "REJECTED", reason: "NOT_FOUND" } as const;
    // A cross-channel question is closed only by deciding it (confirm or reject), which also acts on the candidate. Closing the
    // task alone would leave the message waiting forever, so the generic close refuses it.
    if (task.type === "CORRELATION" && task.status === "OPEN") return { outcome: "REJECTED", reason: "DECISION_REQUIRED" } as const;
    if (task.refType === "TrackedItem") {
      const item = await tx.trackedItem.findUnique({ where: { id: task.refId } });
      if (!item) return { outcome: "REJECTED", reason: "NOT_FOUND" } as const;
      assertCan(principal, "item:act", { organizationId: principal.organizationId, teamId: item.teamId });
    }
    const { count } = await tx.reviewTask.updateMany({
      where: { id: task.id, status: "OPEN" },
      data: { status: req.status, resolution: req.resolution?.slice(0, 500) ?? null },
    });
    if (count !== 1) return { outcome: "REJECTED", reason: "NOT_OPEN" } as const;
    await recordAudit(tx, {
      organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "review.closed", entityType: "ReviewTask", entityId: task.id,
      metadata: { type: task.type, status: req.status, refType: task.refType, refId: task.refId },
    });
    return (req.status === "RESOLVED" ? { outcome: "RESOLVED" } : { outcome: "DISMISSED" }) as ReviewResolveOutcome;
  });
}

/** The organization's approval bar: the minimum team role that may confirm or close. Lets the UI show only what will work. */
export async function getApprovalPolicy(principal: Principal): Promise<{ approvalMinRole: "MEMBER" | "TEAM_LEAD" | "ORG_ADMIN" }> {
  return withTenant(ctxOf(principal), async (tx) => ({ approvalMinRole: (await loadPolicy(tx, principal.organizationId)).approvalMinRole ?? "MEMBER" }));
}

/** Whether this principal may work (close) the review queue. The same rule `resolveReviewTask` enforces. */
export const canResolveReviewTasks = (principal: Principal): boolean => REVIEW_RESOLVERS.has(principal.orgRole);

export interface ItemForSla {
  id: string;
  teamId: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  slaPolicyId: string | null;
  originMessageId: string;
  state: ItemState;
  events: Array<{ seq: number; cycle: number; toState: ItemState; createdAt: Date }>;
}

/** An item's SLA-relevant facts and its ordered events, for deriving timers. Read-only; callers authorize. */
export async function loadItemForSla(organizationId: string, itemId: string): Promise<ItemForSla | null> {
  return withTenant({ organizationId }, async (tx) => {
    const item = await tx.trackedItem.findUnique({ where: { id: itemId } });
    if (!item) return null;
    const events = await tx.lifecycleEvent.findMany({ where: { itemId }, orderBy: { seq: "asc" }, select: { seq: true, cycle: true, toState: true, createdAt: true } });
    return { id: item.id, teamId: item.teamId, priority: item.priority, slaPolicyId: item.slaPolicyId, originMessageId: item.originMessageId, state: item.state, events };
  });
}

/** Ids of items that are not closed: the work the SLA scan always re-checks. */
export async function listOpenItemIds(organizationId: string, limit = 5_000): Promise<string[]> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx.trackedItem.findMany({ where: { state: { not: "CLOSED" } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit });
    return rows.map((r) => r.id);
  });
}
