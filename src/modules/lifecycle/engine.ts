import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import type { ItemState, MessageLinkRole } from "../../../generated/prisma/enums";
import type { TenantTx } from "@/lib/db";
import { decryptField, parseFieldKey } from "@/lib/crypto/fields";
import { getEnv } from "@/lib/env";
import { recordAudit } from "@/modules/audit";
import { assertCan, type PolicyOptions, type Principal } from "@/modules/identity";
import { asLifecycleWriter } from "./guard";
import { deriveMetrics } from "./metrics";
import { DEFAULT_CONFIDENCE_THRESHOLD, HUMAN_DECISION_STATES, ruleFor, type TransitionRule } from "./transitions";
import {
  LifecycleConflictError,
  type Actor,
  type AutomatedActor,
  type CreateItemOutcome,
  type CreateItemRequest,
  type EngineOptions,
  type Outcome,
  type ReviewReason,
  type TransitionRequest,
} from "./types";

/**
 * The lifecycle engine: the only writer of TrackedItem state and the four metrics (rule 1).
 *
 * Every function takes the caller's tenant transaction, so the state change, its LifecycleEvent and its AuditLog row
 * commit together or not at all (rule 3). Deterministic problems return a typed outcome without writing anything;
 * only a lost race throws LifecycleConflictError (the transaction rolls back and the caller may retry).
 * Message content is untrusted: analyzer evidence is checked against the real message body and anything invalid or
 * low-confidence goes to a human review queue instead of moving state (rule 6).
 */

const CLOCK_SKEW_MS = 5 * 60_000;

const ROLE_FOR_STATE: Partial<Record<ItemState, MessageLinkRole>> = {
  ACKNOWLEDGED: "ACK", RESPONDED: "RESPONSE", IN_PROGRESS: "PROGRESS", RESOLUTION_PROPOSED: "RESOLUTION",
};

const settingsSchema = z.object({
  approvalMinRole: z.enum(["MEMBER", "TEAM_LEAD", "ORG_ADMIN"]).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

interface OrgPolicy extends PolicyOptions {
  confidenceThreshold: number;
}

/** Per-organization lifecycle settings live at Organization.settings.lifecycle. Invalid settings fall back to defaults. */
async function loadPolicy(tx: TenantTx, organizationId: string): Promise<OrgPolicy> {
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const raw = (org?.settings as { lifecycle?: unknown } | null)?.lifecycle ?? {};
  const parsed = settingsSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : {};
  return { approvalMinRole: s.approvalMinRole ?? "MEMBER", confidenceThreshold: s.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD };
}

function actorColumns(actor: Actor): { actorType: "USER" | "SYSTEM" | "ANALYZER"; actorId: string | null; analysisRunId: string | null } {
  if (actor.type === "USER") return { actorType: "USER", actorId: actor.principal.userId, analysisRunId: null };
  if (actor.type === "ANALYZER") return { actorType: "ANALYZER", actorId: actor.analyzer, analysisRunId: actor.analysisRunId };
  return { actorType: "SYSTEM", actorId: actor.id ?? null, analysisRunId: null };
}

const fieldKey = (opts: EngineOptions) => opts.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);

type Item = NonNullable<Awaited<ReturnType<TenantTx["trackedItem"]["findUnique"]>>>;

/** Validate an analyzer recommendation. Returns why it must go to review, or null when it is sound. */
async function checkAnalyzerOutput(
  tx: TenantTx, req: TransitionRequest, actor: Extract<AutomatedActor, { type: "ANALYZER" }>, policy: OrgPolicy,
  message: { bodyText: Uint8Array } | null, opts: EngineOptions,
): Promise<ReviewReason | null> {
  const run = await tx.analysisRun.findUnique({ where: { organizationId_id: { organizationId: req.organizationId, id: actor.analysisRunId } } });
  if (!run) return "UNKNOWN_ANALYSIS_RUN";
  if (typeof req.confidence !== "number" || Number.isNaN(req.confidence) || req.confidence < 0 || req.confidence > 1) return "MISSING_CONFIDENCE";
  if (req.confidence < policy.confidenceThreshold) return "LOW_CONFIDENCE";
  if (!req.evidence?.length || !message) return "MISSING_EVIDENCE";
  const body = decryptField(message.bodyText, fieldKey(opts), `${req.organizationId}:Message.bodyText`);
  for (const { quote } of req.evidence) {
    if (!quote || !body.includes(quote)) return "EVIDENCE_NOT_VERBATIM";
  }
  return null;
}

async function queueReview(tx: TenantTx, item: Item, reason: ReviewReason, to: ItemState): Promise<Outcome> {
  const open = await tx.reviewTask.findFirst({ where: { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: item.id, status: "OPEN" } });
  const task = open ?? (await tx.reviewTask.create({ data: { organizationId: item.organizationId, type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: item.id } }));
  if (!item.needsReview) await tx.trackedItem.update({ where: { id: item.id }, data: { needsReview: true } }); // not a guarded column
  await recordAudit(tx, {
    organizationId: item.organizationId, actorType: "SYSTEM", action: "item.review_queued", entityType: "TrackedItem", entityId: item.id,
    metadata: { reason, proposedState: to, reviewTaskId: task.id },
  });
  return { outcome: "NEEDS_REVIEW", reviewTaskId: task.id, reason };
}

async function queueApproval(tx: TenantTx, item: Item, to: ItemState, actor: AutomatedActor, reason?: string): Promise<Outcome> {
  const existing = await tx.approvalRequest.findFirst({ where: { itemId: item.id, requestedTransition: to, status: "PENDING" } });
  if (existing) return { outcome: "APPROVAL_REQUIRED", approvalRequestId: existing.id }; // replay-safe
  const created = await tx.approvalRequest.create({
    data: { organizationId: item.organizationId, itemId: item.id, requestedTransition: to, reason: reason ?? null },
  });
  await recordAudit(tx, {
    organizationId: item.organizationId, actorType: actor.type, actorId: actor.type === "ANALYZER" ? actor.analyzer : actor.id,
    action: "item.approval_requested", entityType: "TrackedItem", entityId: item.id,
    metadata: { requestedTransition: to, fromState: item.state, approvalRequestId: created.id },
  });
  return { outcome: "APPROVAL_REQUIRED", approvalRequestId: created.id };
}

async function run(tx: TenantTx, req: TransitionRequest, opts: EngineOptions): Promise<Outcome> {
  const now = (opts.now ?? (() => new Date()))();
  const item = await tx.trackedItem.findUnique({ where: { id: req.itemId } });
  if (!item || item.organizationId !== req.organizationId) return { outcome: "REJECTED", reason: "NOT_FOUND" };
  return runOnItem(tx, item, req, opts, now);
}

async function runOnItem(tx: TenantTx, item: Item, req: TransitionRequest, opts: EngineOptions, now: Date): Promise<Outcome> {
  const { actor } = req;
  if (req.expectedVersion !== undefined && req.expectedVersion !== item.version) return { outcome: "REJECTED", reason: "STALE_VERSION" };

  // Replay safety: the same analyzer run already produced this transition.
  if (actor.type === "ANALYZER") {
    const prior = await tx.lifecycleEvent.findFirst({ where: { itemId: item.id, analysisRunId: actor.analysisRunId, toState: req.to } });
    if (prior) {
      return { outcome: "APPLIED", itemId: item.id, fromState: prior.fromState ?? "RECEIVED", toState: prior.toState, version: prior.seq, eventId: prior.id, idempotent: true };
    }
  }
  if (item.state === req.to) return { outcome: "NOOP", reason: "ALREADY_IN_STATE" };

  const rule = ruleFor(item.state, req.to);
  if (!rule) return { outcome: "REJECTED", reason: "ILLEGAL_TRANSITION" };

  if (req.occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return { outcome: "REJECTED", reason: "FUTURE_TIMESTAMP" };
  const last = await tx.lifecycleEvent.findFirst({ where: { itemId: item.id }, orderBy: { seq: "desc" } });
  if (last && req.occurredAt.getTime() < last.createdAt.getTime()) return { outcome: "REJECTED", reason: "OUT_OF_ORDER" };

  // One open item per thread (rule 9): a closed item cannot be reopened while a newer one is open.
  if (rule.to === "REOPENED") {
    const other = await tx.trackedItem.findFirst({ where: { threadId: item.threadId, state: { not: "CLOSED" }, id: { not: item.id } } });
    if (other) return { outcome: "REJECTED", reason: "THREAD_HAS_OPEN_ITEM" };
  }

  let message: { bodyText: Uint8Array } | null = null;
  if (req.messageId) {
    message = await tx.message.findUnique({ where: { id: req.messageId } });
    if (!message) return { outcome: "REJECTED", reason: "MESSAGE_NOT_FOUND" };
  }

  const policy = await loadPolicy(tx, item.organizationId);

  if (actor.type === "USER") {
    if (!rule.human) return { outcome: "REJECTED", reason: "INVALID_ACTOR" };
    // Throws ForbiddenError for wrong org, no team role, or a role below the configured approval bar.
    assertCan(actor.principal, rule.action, { organizationId: item.organizationId, teamId: item.teamId }, policy);
    return applyTransition(tx, item, rule, req, actor, last?.cycle ?? 1);
  }

  if (actor.type === "ANALYZER") {
    const problem = await checkAnalyzerOutput(tx, req, actor, policy, message, opts);
    if (problem) return queueReview(tx, item, problem, req.to);
  }
  if (rule.automated) return applyTransition(tx, item, rule, req, actor, last?.cycle ?? 1);
  if (rule.suggestible) return queueApproval(tx, item, req.to, actor, req.reason); // never applied from inference (rule 2)
  return { outcome: "REJECTED", reason: "INVALID_ACTOR" };
}

async function applyTransition(
  tx: TenantTx, item: Item, rule: TransitionRule, req: TransitionRequest, actor: Actor, lastCycle: number,
): Promise<Outcome> {
  const seq = item.version + 1;
  const cycle = rule.to === "REOPENED" ? lastCycle + 1 : lastCycle;
  const cols = actorColumns(actor);

  let eventId: string;
  try {
    const event = await tx.lifecycleEvent.create({
      data: {
        organizationId: item.organizationId, itemId: item.id, seq, cycle, fromState: rule.from, toState: rule.to,
        actorType: cols.actorType, actorId: cols.actorId, analysisRunId: cols.analysisRunId,
        evidence: req.evidence?.length ? (req.evidence as unknown as Prisma.InputJsonValue) : undefined,
        reason: req.reason ?? null, createdAt: req.occurredAt,
      },
    });
    eventId = event.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new LifecycleConflictError();
    throw e;
  }

  // Rule 4: derive from the events (never write timestamps directly).
  const events = await tx.lifecycleEvent.findMany({ where: { itemId: item.id }, orderBy: { seq: "asc" } });
  const d = deriveMetrics(events);
  const { count } = await asLifecycleWriter(tx, () =>
    tx.trackedItem.updateMany({
      where: { id: item.id, version: item.version },
      data: {
        state: d.state, version: d.version, reopenCount: d.reopenCount,
        ackAt: d.ackAt, firstSubstantiveResponseAt: d.firstSubstantiveResponseAt, resolvedAt: d.resolvedAt, closedAt: d.closedAt,
      },
    }),
  );
  if (count !== 1) throw new LifecycleConflictError();

  if (actor.type === "USER" && HUMAN_DECISION_STATES.has(rule.to)) {
    const pending = await tx.approvalRequest.findFirst({ where: { itemId: item.id, requestedTransition: rule.to, status: "PENDING" } });
    const decision = { status: "APPROVED" as const, decidedBy: actor.principal.userId, decidedAt: req.occurredAt, reason: req.reason ?? null };
    if (pending) await tx.approvalRequest.update({ where: { id: pending.id }, data: decision });
    else await tx.approvalRequest.create({ data: { organizationId: item.organizationId, itemId: item.id, requestedTransition: rule.to, ...decision } });
  }
  // Pending requests that are no longer reachable from the new state are superseded.
  for (const p of await tx.approvalRequest.findMany({ where: { itemId: item.id, status: "PENDING" } })) {
    if (!ruleFor(rule.to, p.requestedTransition)) {
      await tx.approvalRequest.update({ where: { id: p.id }, data: { status: "EXPIRED", reason: "superseded" } });
    }
  }
  if (req.messageId) {
    const linked = await tx.itemMessageLink.findUnique({ where: { itemId_messageId: { itemId: item.id, messageId: req.messageId } } });
    if (!linked) {
      await tx.itemMessageLink.create({
        data: { organizationId: item.organizationId, itemId: item.id, messageId: req.messageId, role: ROLE_FOR_STATE[rule.to] ?? "OTHER" },
      });
    }
  }

  await recordAudit(tx, {
    organizationId: item.organizationId, actorType: cols.actorType, actorId: cols.actorId ?? undefined,
    action: "item.transitioned", entityType: "TrackedItem", entityId: item.id,
    metadata: {
      fromState: rule.from, toState: rule.to, cycle, version: seq,
      ...(cols.analysisRunId ? { analysisRunId: cols.analysisRunId } : {}),
      ...(req.messageId ? { messageId: req.messageId } : {}),
    },
  });
  return { outcome: "APPLIED", itemId: item.id, fromState: rule.from, toState: rule.to, version: seq, eventId };
}

// ---------------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------------

/** Create the item for an actionable message, at RECEIVED. Replay-safe: an open item for the thread is returned as EXISTS. */
export async function createItem(tx: TenantTx, req: CreateItemRequest, opts: EngineOptions = {}): Promise<CreateItemOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  if (req.occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return { outcome: "REJECTED", reason: "FUTURE_TIMESTAMP" };
  if (!(await tx.message.findUnique({ where: { id: req.originMessageId } }))) return { outcome: "REJECTED", reason: "MESSAGE_NOT_FOUND" };

  const open = await tx.trackedItem.findFirst({ where: { threadId: req.threadId, state: { not: "CLOSED" } } });
  if (open) return { outcome: "EXISTS", itemId: open.id }; // one open item per thread (rule 9)

  const policy = await loadPolicy(tx, req.organizationId);
  const lowConfidence = req.actor.type === "ANALYZER" && !(typeof req.confidence === "number" && req.confidence >= policy.confidenceThreshold);
  const cols = actorColumns(req.actor);

  let itemId: string;
  try {
    itemId = await asLifecycleWriter(tx, async () => {
      const item = await tx.trackedItem.create({
        data: {
          organizationId: req.organizationId, teamId: req.teamId, originMessageId: req.originMessageId, threadId: req.threadId,
          title: req.title, priority: req.priority ?? "NORMAL", ownerUserId: req.ownerUserId ?? null, slaPolicyId: req.slaPolicyId ?? null,
          state: "RECEIVED", version: 1, needsReview: lowConfidence, createdAt: req.occurredAt,
        },
      });
      return item.id;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new LifecycleConflictError();
    throw e;
  }
  await tx.lifecycleEvent.create({
    data: {
      organizationId: req.organizationId, itemId, seq: 1, cycle: 1, fromState: null, toState: "RECEIVED", actorType: cols.actorType,
      actorId: cols.actorId, analysisRunId: cols.analysisRunId, reason: req.reason ?? "Actionable message received", createdAt: req.occurredAt,
    },
  });
  await tx.itemMessageLink.create({ data: { organizationId: req.organizationId, itemId, messageId: req.originMessageId, role: "ORIGIN" } });
  if (req.ownerUserId) {
    await tx.itemOwnership.create({ data: { organizationId: req.organizationId, itemId, userId: req.ownerUserId, assignedAt: req.occurredAt } });
  }
  if (lowConfidence) {
    await tx.reviewTask.create({ data: { organizationId: req.organizationId, type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: itemId } });
  }
  await recordAudit(tx, {
    organizationId: req.organizationId, actorType: cols.actorType, actorId: cols.actorId ?? undefined,
    action: "item.created", entityType: "TrackedItem", entityId: itemId,
    metadata: { toState: "RECEIVED", needsReview: lowConfidence, ...(cols.analysisRunId ? { analysisRunId: cols.analysisRunId } : {}) },
  });
  return { outcome: "CREATED", itemId, needsReview: lowConfidence };
}

/** An automated actor (SYSTEM or an ANALYZER recommendation) proposes a transition. The engine decides what happens. */
export async function propose(tx: TenantTx, req: TransitionRequest & { actor: AutomatedActor }, opts: EngineOptions = {}): Promise<Outcome> {
  if ((req.actor as Actor).type === "USER") return { outcome: "REJECTED", reason: "INVALID_ACTOR" }; // humans use apply()
  return run(tx, req, opts);
}

/** An authorized human performs a transition. Throws ForbiddenError when the principal may not. */
export async function apply(tx: TenantTx, req: TransitionRequest & { actor: Extract<Actor, { type: "USER" }> }, opts: EngineOptions = {}): Promise<Outcome> {
  if ((req.actor as Actor).type !== "USER") return { outcome: "REJECTED", reason: "INVALID_ACTOR" };
  return run(tx, req, opts);
}

export type DecisionOutcome =
  | { outcome: "DECIDED"; approvalRequestId: string; status: "APPROVED" | "REJECTED"; transition?: Outcome }
  | { outcome: "REJECTED"; reason: "NOT_FOUND" | "NOT_PENDING" | "ILLEGAL_TRANSITION" };

/**
 * A human approves or rejects a pending ApprovalRequest. Approving performs the requested transition as that human.
 * Rejecting a pending confirmation sends the item back to IN_PROGRESS so it has a way forward.
 */
export async function decideApproval(
  tx: TenantTx,
  req: { organizationId: string; approvalRequestId: string; decision: "APPROVE" | "REJECT"; principal: Principal; occurredAt: Date; reason?: string; expectedVersion?: number },
  opts: EngineOptions = {},
): Promise<DecisionOutcome> {
  const approval = await tx.approvalRequest.findUnique({ where: { id: req.approvalRequestId } });
  if (!approval || approval.organizationId !== req.organizationId) return { outcome: "REJECTED", reason: "NOT_FOUND" };
  if (approval.status !== "PENDING") return { outcome: "REJECTED", reason: "NOT_PENDING" };
  const actor = { type: "USER" as const, principal: req.principal };
  const base = { organizationId: req.organizationId, itemId: approval.itemId, occurredAt: req.occurredAt, actor, ...(req.expectedVersion !== undefined ? { expectedVersion: req.expectedVersion } : {}) };

  if (req.decision === "APPROVE") {
    const transition = await run(tx, { ...base, to: approval.requestedTransition, ...(req.reason ? { reason: req.reason } : {}) }, opts);
    if (transition.outcome === "APPLIED") return { outcome: "DECIDED", approvalRequestId: approval.id, status: "APPROVED", transition };
    if (transition.outcome === "NOOP" || (transition.outcome === "REJECTED" && transition.reason === "ILLEGAL_TRANSITION")) {
      await tx.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED", reason: "superseded" } });
      return { outcome: "REJECTED", reason: "ILLEGAL_TRANSITION" };
    }
    return { outcome: "DECIDED", approvalRequestId: approval.id, status: "REJECTED", transition };
  }

  const item = await tx.trackedItem.findUnique({ where: { id: approval.itemId } });
  if (!item) return { outcome: "REJECTED", reason: "NOT_FOUND" };
  const policy = await loadPolicy(tx, req.organizationId);
  const needed = ruleFor(item.state, approval.requestedTransition)?.action ?? "item:act";
  assertCan(req.principal, needed, { organizationId: item.organizationId, teamId: item.teamId }, policy);
  await tx.approvalRequest.update({
    where: { id: approval.id }, data: { status: "REJECTED", decidedBy: req.principal.userId, decidedAt: req.occurredAt, reason: req.reason ?? null },
  });
  await recordAudit(tx, {
    organizationId: item.organizationId, actorType: "USER", actorId: req.principal.userId, action: "item.approval_rejected",
    entityType: "TrackedItem", entityId: item.id, metadata: { requestedTransition: approval.requestedTransition, approvalRequestId: approval.id },
  });
  if (approval.requestedTransition === "RESOLUTION_CONFIRMED" && item.state === "RESOLUTION_PROPOSED") {
    const transition = await run(tx, { ...base, to: "IN_PROGRESS", reason: req.reason ?? "Resolution rejected" }, opts);
    return { outcome: "DECIDED", approvalRequestId: approval.id, status: "REJECTED", transition };
  }
  return { outcome: "DECIDED", approvalRequestId: approval.id, status: "REJECTED" };
}

export type OwnerOutcome =
  | { outcome: "ASSIGNED"; ownerUserId: string | null }
  | { outcome: "NOOP" }
  | { outcome: "REJECTED"; reason: "NOT_FOUND" | "NOT_A_MEMBER" };

/** Assign or clear the item's owner. Ownership history is kept in ItemOwnership. Requires item:act on the team. */
export async function assignOwner(
  tx: TenantTx,
  req: { organizationId: string; itemId: string; userId: string | null; principal: Principal; occurredAt: Date },
): Promise<OwnerOutcome> {
  const item = await tx.trackedItem.findUnique({ where: { id: req.itemId } });
  if (!item || item.organizationId !== req.organizationId) return { outcome: "REJECTED", reason: "NOT_FOUND" };
  assertCan(req.principal, "item:act", { organizationId: item.organizationId, teamId: item.teamId });
  if ((item.ownerUserId ?? null) === req.userId) return { outcome: "NOOP" };
  if (req.userId) {
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: item.organizationId, userId: req.userId } } });
    if (!member) return { outcome: "REJECTED", reason: "NOT_A_MEMBER" };
  }
  await tx.itemOwnership.updateMany({ where: { itemId: item.id, endedAt: null }, data: { endedAt: req.occurredAt } });
  if (req.userId) {
    await tx.itemOwnership.create({
      data: { organizationId: item.organizationId, itemId: item.id, userId: req.userId, assignedBy: req.principal.userId, assignedAt: req.occurredAt },
    });
  }
  await tx.trackedItem.update({ where: { id: item.id }, data: { ownerUserId: req.userId } }); // not a guarded column
  await recordAudit(tx, {
    organizationId: item.organizationId, actorType: "USER", actorId: req.principal.userId, action: "item.owner_assigned",
    entityType: "TrackedItem", entityId: item.id, metadata: { previousOwner: item.ownerUserId, owner: req.userId },
  });
  return { outcome: "ASSIGNED", ownerUserId: req.userId };
}

/** Recompute an item's state and metrics from its events and report any difference from the stored columns. */
export async function verifyItemMetrics(tx: TenantTx, itemId: string): Promise<{ consistent: boolean; differences: string[] }> {
  const item = await tx.trackedItem.findUnique({ where: { id: itemId } });
  if (!item) return { consistent: false, differences: ["item not found"] };
  const events = await tx.lifecycleEvent.findMany({ where: { itemId }, orderBy: { seq: "asc" } });
  const d = deriveMetrics(events);
  const differences: string[] = [];
  const check = (name: string, stored: unknown, derived: unknown) => {
    const norm = (v: unknown) => (v instanceof Date ? v.getTime() : v);
    if (norm(stored) !== norm(derived)) differences.push(name);
  };
  check("state", item.state, d.state);
  check("version", item.version, d.version);
  check("reopenCount", item.reopenCount, d.reopenCount);
  check("ackAt", item.ackAt, d.ackAt);
  check("firstSubstantiveResponseAt", item.firstSubstantiveResponseAt, d.firstSubstantiveResponseAt);
  check("resolvedAt", item.resolvedAt, d.resolvedAt);
  check("closedAt", item.closedAt, d.closedAt);
  events.forEach((e, i) => {
    if (e.seq !== i + 1) differences.push(`seq gap at ${i + 1}`);
    if (e.fromState !== (i === 0 ? null : events[i - 1]!.toState)) differences.push(`broken chain at seq ${e.seq}`);
  });
  return { consistent: differences.length === 0, differences };
}
