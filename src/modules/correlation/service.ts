// Cross-channel correlation. The system FINDS and SCORES candidates; only a person decides (rule 9, and the AI-recommends,
// humans-approve rule). Nothing here changes item state or metrics: a confirmed match attaches a thread to an item (a link, not
// a transition), a rejection lets the message start its own item, and a split detaches a confirmed thread again. Every decision
// is audited in the same transaction as the change.
import type { Prisma } from "../../../generated/prisma/client";
import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, can, ForbiddenError, type Principal } from "@/modules/identity";
import { listThreadMessageRefs, loadMessageContext, loadMessageFeatures } from "@/modules/ingestion";
import {
  canResolveReviewTasks, closeReviewTasksFor, linkThreadToItem, listOpenItemsForCorrelation, loadItemHeader, queueReviewTask, unlinkThreadFromItem,
} from "@/modules/lifecycle";
import { scorePair, SHOW_THRESHOLD, type Signal } from "./score";

const SUBJECT_TYPE = "Message";

export interface Match {
  targetItemId: string;
  /** The tracked item's first message, so a caller can show or judge the pair. */
  targetOriginMessageId: string;
  score: number;
  signals: Signal[];
}

/** What the analyzer step (run by the worker, never by this module) concluded about a match. Advisory only. */
export interface Verdict {
  sameMatter: "yes" | "no" | "unsure";
  confidence: number;
  /** The recorded analysis (its cited quotes live there, with the rest of the analysis record, not in this rationale). */
  analysisRunId: string;
}

export interface Rationale {
  v: 1;
  signals: Signal[];
  verdict?: Verdict;
}

export interface CandidateState {
  id: string;
  targetItemId: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
}

/** Existing candidates for a message, so a message is never asked about twice and a rejected pair is never asked again. */
export async function listSubjectCandidates(organizationId: string, subjectMessageId: string): Promise<CandidateState[]> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx.correlationCandidate.findMany({ where: { subjectType: SUBJECT_TYPE, subjectId: subjectMessageId } });
    return rows.map((r) => ({ id: r.id, targetItemId: r.targetItemId, status: r.status }));
  });
}

/** A pending candidate for any message in this thread (so a second message in the same chat thread joins the open question). */
export async function findPendingForThread(organizationId: string, threadId: string): Promise<CandidateState | null> {
  const ids = (await listThreadMessageRefs(organizationId, threadId)).map((m) => m.id);
  if (ids.length === 0) return null;
  return withTenant({ organizationId }, async (tx) => {
    const r = await tx.correlationCandidate.findFirst({ where: { subjectType: SUBJECT_TYPE, subjectId: { in: ids }, status: "PENDING" }, orderBy: { createdAt: "asc" } });
    return r && { id: r.id, targetItemId: r.targetItemId, status: r.status };
  });
}

/**
 * The best open item this inbound message may belong to, or null. Deterministic and read-only. Items on the message's own thread
 * or in the same source are never considered, nor are pairs a person already rejected. Only the single best match is returned.
 */
export async function findBestMatch(organizationId: string, subjectMessageId: string, opts: { fieldKey?: Buffer } = {}): Promise<Match | null> {
  const [subject] = await loadMessageFeatures(organizationId, [subjectMessageId], opts);
  if (!subject) return null;
  const rejected = new Set((await listSubjectCandidates(organizationId, subjectMessageId)).filter((c) => c.status === "REJECTED").map((c) => c.targetItemId));
  const targets = (await listOpenItemsForCorrelation(organizationId, { excludeThreadId: subject.threadId })).filter((t) => !rejected.has(t.id));
  const origins = new Map((await loadMessageFeatures(organizationId, targets.map((t) => t.originMessageId), opts)).map((m) => [m.id, m]));

  let best: Match | null = null;
  for (const t of targets) {
    const origin = origins.get(t.originMessageId);
    if (!origin) continue;
    const s = scorePair(subject, origin);
    if (s.excluded || s.score < SHOW_THRESHOLD) continue;
    if (!best || s.score > best.score || (s.score === best.score && t.id > best.targetItemId)) best = { targetItemId: t.id, targetOriginMessageId: t.originMessageId, score: s.score, signals: s.signals };
  }
  return best;
}

/** Record a candidate and open ONE review task for it. Idempotent: a replay returns the same candidate. */
export async function queueCandidate(organizationId: string, req: { subjectMessageId: string; match: Match; verdict?: Verdict }): Promise<{ candidateId: string; created: boolean }> {
  const rationale: Rationale = { v: 1, signals: req.match.signals, ...(req.verdict ? { verdict: req.verdict } : {}) };
  const out = await withTenant({ organizationId }, async (tx) => {
    const { count } = await tx.correlationCandidate.createMany({
      data: [{ organizationId, subjectType: SUBJECT_TYPE, subjectId: req.subjectMessageId, targetItemId: req.match.targetItemId, score: req.match.score, rationale: rationale as unknown as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    const row = await tx.correlationCandidate.findUniqueOrThrow({
      where: { organizationId_subjectType_subjectId_targetItemId: { organizationId, subjectType: SUBJECT_TYPE, subjectId: req.subjectMessageId, targetItemId: req.match.targetItemId } },
    });
    if (count === 1) {
      await recordAudit(tx, {
        organizationId, actorType: "SYSTEM", actorId: "correlation", action: "correlation.candidate_queued", entityType: "CorrelationCandidate", entityId: row.id,
        metadata: { targetItemId: req.match.targetItemId, score: req.match.score, analyzerVerdict: req.verdict?.sameMatter ?? null },
      });
    }
    return { candidateId: row.id, created: count === 1 };
  });
  if (out.created) await queueReviewTask(organizationId, { type: "CORRELATION", refType: "CorrelationCandidate", refId: out.candidateId });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decisions (people only)
// ---------------------------------------------------------------------------------------------------------------------

export type DecisionOutcome =
  | { outcome: "CONFIRMED"; itemId: string; linkedMessages: number }
  | { outcome: "REJECTED"; itemId: string }
  | { outcome: "SPLIT"; itemId: string }
  | { outcome: "REFUSED"; reason: "NOT_FOUND" | "ALREADY_DECIDED" | "TARGET_CLOSED" | "NOT_CONFIRMED" | "THREAD_HAS_HISTORY" };

const ctxOf = (p: Principal) => ({ organizationId: p.organizationId, userId: p.userId });

/** Deciding needs the review role AND permission to act on the item the message would join. Throws ForbiddenError otherwise. */
function assertMayDecide(principal: Principal, teamId: string): void {
  if (!canResolveReviewTasks(principal)) throw new ForbiddenError("item:act");
  assertCan(principal, "item:act", { organizationId: principal.organizationId, teamId });
}

async function decide(principal: Principal, candidateId: string, kind: "CONFIRM" | "REJECT"): Promise<DecisionOutcome> {
  const org = principal.organizationId;
  const peek = await withTenant(ctxOf(principal), (tx) => tx.correlationCandidate.findUnique({ where: { id: candidateId } }));
  if (!peek) return { outcome: "REFUSED", reason: "NOT_FOUND" };
  const subject = await loadMessageContext(org, peek.subjectId);
  if (!subject) return { outcome: "REFUSED", reason: "NOT_FOUND" };

  return withTenant(ctxOf(principal), async (tx) => {
    const cand = await tx.correlationCandidate.findUnique({ where: { id: candidateId } });
    if (!cand) return { outcome: "REFUSED", reason: "NOT_FOUND" } as const;
    const item = await loadItemHeader(tx, cand.targetItemId);
    if (!item) return { outcome: "REFUSED", reason: "NOT_FOUND" } as const;
    assertMayDecide(principal, item.teamId);
    if (cand.status !== "PENDING") return { outcome: "REFUSED", reason: "ALREADY_DECIDED" } as const;
    if (kind === "CONFIRM" && item.state === "CLOSED") return { outcome: "REFUSED", reason: "TARGET_CLOSED" } as const;

    // Exactly one of several simultaneous deciders wins.
    const { count } = await tx.correlationCandidate.updateMany({
      where: { id: cand.id, status: "PENDING" },
      data: { status: kind === "CONFIRM" ? "CONFIRMED" : "REJECTED", decidedBy: principal.userId, decidedAt: new Date() },
    });
    if (count !== 1) return { outcome: "REFUSED", reason: "ALREADY_DECIDED" } as const;

    let linked = 0;
    if (kind === "CONFIRM") linked = (await linkThreadToItem(tx, { organizationId: org, itemId: item.id, threadId: subject.threadId })).messageIds.length;
    await closeReviewTasksFor(tx, { type: "CORRELATION", refType: "CorrelationCandidate", refId: cand.id, status: "RESOLVED", resolution: kind === "CONFIRM" ? "Confirmed: same matter" : "Rejected: separate matter" });
    await recordAudit(tx, {
      organizationId: org, actorType: "USER", actorId: principal.userId, action: kind === "CONFIRM" ? "correlation.confirmed" : "correlation.rejected",
      entityType: "CorrelationCandidate", entityId: cand.id,
      metadata: { targetItemId: item.id, attachedThreadId: subject.threadId, score: cand.score, ...(kind === "CONFIRM" ? { linkedMessages: linked } : {}) },
    });
    return kind === "CONFIRM" ? ({ outcome: "CONFIRMED", itemId: item.id, linkedMessages: linked } as const) : ({ outcome: "REJECTED", itemId: item.id } as const);
  });
}

/** A person says the message is about the same matter: its thread is attached to the item. No second item is created. */
export const confirmCandidate = (principal: Principal, req: { candidateId: string }): Promise<DecisionOutcome> => decide(principal, req.candidateId, "CONFIRM");
/** A person says it is a separate matter: the message goes on to start its own item. */
export const rejectCandidate = (principal: Principal, req: { candidateId: string }): Promise<DecisionOutcome> => decide(principal, req.candidateId, "REJECT");

/**
 * Undo a confirmation: detach the thread and let its message start its own item. Refused when messages from that thread already
 * drove the item's lifecycle (history is never rewritten); in that case use the item's normal reopen and close decisions.
 */
export async function splitCandidate(principal: Principal, req: { candidateId: string }): Promise<DecisionOutcome> {
  const org = principal.organizationId;
  const peek = await withTenant(ctxOf(principal), (tx) => tx.correlationCandidate.findUnique({ where: { id: req.candidateId } }));
  if (!peek) return { outcome: "REFUSED", reason: "NOT_FOUND" };
  const subject = await loadMessageContext(org, peek.subjectId);
  if (!subject) return { outcome: "REFUSED", reason: "NOT_FOUND" };

  return withTenant(ctxOf(principal), async (tx) => {
    const cand = await tx.correlationCandidate.findUnique({ where: { id: req.candidateId } });
    if (!cand) return { outcome: "REFUSED", reason: "NOT_FOUND" } as const;
    const item = await loadItemHeader(tx, cand.targetItemId);
    if (!item) return { outcome: "REFUSED", reason: "NOT_FOUND" } as const;
    assertMayDecide(principal, item.teamId);
    if (cand.status !== "CONFIRMED") return { outcome: "REFUSED", reason: "NOT_CONFIRMED" } as const;

    const un = await unlinkThreadFromItem(tx, { itemId: item.id, threadId: subject.threadId });
    if (un.outcome === "BLOCKED") return { outcome: "REFUSED", reason: un.reason } as const;
    await tx.correlationCandidate.update({ where: { id: cand.id }, data: { status: "REJECTED", decidedBy: principal.userId, decidedAt: new Date(), followUpAt: null } });
    await recordAudit(tx, {
      organizationId: org, actorType: "USER", actorId: principal.userId, action: "correlation.split", entityType: "CorrelationCandidate", entityId: cand.id,
      metadata: { targetItemId: item.id, attachedThreadId: subject.threadId, unlinkedMessages: un.removed },
    });
    return { outcome: "SPLIT", itemId: item.id } as const;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Follow-up after a decision
// ---------------------------------------------------------------------------------------------------------------------

export interface FollowUpDeps {
  /** Queue an analysis of one message under the given job id. */
  enqueueAnalysis: (messageId: string, jobId: string) => Promise<void>;
  jobId: (messageId: string, candidateId: string) => string;
}

export type FollowUpOutcome = { outcome: "QUEUED"; messages: number } | { outcome: "SKIPPED"; reason: "NOT_FOUND" | "UNDECIDED" | "ALREADY_DONE" };

/**
 * Do the work a decision calls for, exactly once: after a rejection or split the message is analyzed again (it now starts its own
 * item); after a confirmation, our replies that arrived in the thread before the decision are analyzed against the item. Safe to
 * replay: the outcome is stamped on the candidate only after every job was queued.
 */
export async function runFollowUp(organizationId: string, candidateId: string, deps: FollowUpDeps): Promise<FollowUpOutcome> {
  const cand = await withTenant({ organizationId }, (tx) => tx.correlationCandidate.findUnique({ where: { id: candidateId } }));
  if (!cand) return { outcome: "SKIPPED", reason: "NOT_FOUND" };
  if (cand.status === "PENDING") return { outcome: "SKIPPED", reason: "UNDECIDED" };
  if (cand.followUpAt) return { outcome: "SKIPPED", reason: "ALREADY_DONE" };
  const subject = await loadMessageContext(organizationId, cand.subjectId);

  let messageIds: string[] = [];
  if (subject) {
    messageIds = cand.status === "REJECTED"
      ? [subject.id]
      : (await listThreadMessageRefs(organizationId, subject.threadId)).filter((m) => m.direction !== "INBOUND" && m.sentAt.getTime() >= subject.sentAt.getTime()).map((m) => m.id);
  }
  for (const id of messageIds) await deps.enqueueAnalysis(id, deps.jobId(id, cand.id));
  await withTenant({ organizationId }, (tx) => tx.correlationCandidate.updateMany({ where: { id: cand.id, followUpAt: null }, data: { followUpAt: new Date() } }));
  return { outcome: "QUEUED", messages: messageIds.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads for people
// ---------------------------------------------------------------------------------------------------------------------

export interface CandidateView {
  id: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  score: number;
  signals: Signal[];
  verdict: Verdict | null;
  createdAt: Date;
  subject: { messageId: string; threadId: string; sentAt: Date; subject: string | null; senderName: string | null; direction: string; provider: string; text: string };
  target: { itemId: string; title: string; state: string; teamId: string };
  canDecide: boolean;
}

/**
 * Candidates a person may look at, newest first. Content is shown only to someone who may view BOTH the item the message would
 * join and the team the message arrived for. Returns message text: never log the result (rule 10).
 */
export async function listCandidates(principal: Principal, opts: { status: "PENDING" | "CONFIRMED"; itemId?: string; fieldKey?: Buffer }): Promise<CandidateView[]> {
  const org = principal.organizationId;
  const rows = await withTenant(ctxOf(principal), (tx) =>
    tx.correlationCandidate.findMany({ where: { status: opts.status, ...(opts.itemId ? { targetItemId: opts.itemId } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 }));
  if (rows.length === 0) return [];
  const [features, headers] = await Promise.all([
    loadMessageFeatures(org, rows.map((r) => r.subjectId), opts.fieldKey ? { fieldKey: opts.fieldKey } : {}),
    withTenant(ctxOf(principal), async (tx) => Promise.all([...new Set(rows.map((r) => r.targetItemId))].map((id) => loadItemHeader(tx, id)))),
  ]);
  const msg = new Map(features.map((f) => [f.id, f]));
  const item = new Map(headers.flatMap((h) => (h ? [[h.id, h] as const] : [])));

  const out: CandidateView[] = [];
  for (const r of rows) {
    const m = msg.get(r.subjectId);
    const t = item.get(r.targetItemId);
    if (!m || !t) continue;
    const ctx = await loadMessageContext(org, m.id);
    const view = can(principal, "item:view", { organizationId: org, teamId: t.teamId }) && (!ctx?.teamId || can(principal, "item:view", { organizationId: org, teamId: ctx.teamId }));
    if (!view) continue;
    const rationale = r.rationale as Partial<Rationale> | null;
    out.push({
      id: r.id, status: r.status, score: r.score, createdAt: r.createdAt,
      signals: Array.isArray(rationale?.signals) ? rationale.signals : [], verdict: rationale?.verdict ?? null,
      subject: { messageId: m.id, threadId: m.threadId, sentAt: m.sentAt, subject: m.subject, senderName: m.senderName, direction: m.direction, provider: m.provider, text: m.text },
      target: { itemId: t.id, title: t.title, state: t.state, teamId: t.teamId },
      canDecide: canResolveReviewTasks(principal) && can(principal, "item:act", { organizationId: org, teamId: t.teamId }),
    });
  }
  return out;
}

export interface AwaitingFollowUp {
  candidateId: string;
  status: "CONFIRMED" | "REJECTED";
  decidedAt: Date;
  targetItemId: string;
}

/** Decisions whose follow-up could not be queued (for a retry button). Ids and times only. */
export async function listAwaitingFollowUp(principal: Principal): Promise<AwaitingFollowUp[]> {
  if (!canResolveReviewTasks(principal)) return [];
  const rows = await withTenant(ctxOf(principal), (tx) => tx.correlationCandidate.findMany({ where: { status: { not: "PENDING" }, followUpAt: null }, orderBy: { decidedAt: "asc" }, take: 50 }));
  return rows.flatMap((r) => (r.status !== "PENDING" && r.decidedAt ? [{ candidateId: r.id, status: r.status, decidedAt: r.decidedAt, targetItemId: r.targetItemId }] : []));
}
