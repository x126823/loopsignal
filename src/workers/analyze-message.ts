import { DelayedError, UnrecoverableError, analyzeMessageJob } from "@/lib/queue";
import type { Job } from "bullmq";
import { log } from "@/lib/log";
import { listThreadMessageRefs, loadMessageContext } from "@/modules/ingestion";
import {
  acknowledgmentDetector, attachRunsToItem, intentClassifier, ownershipResolver, ProviderError, runAnalyzer, substantiveResponseAnalyzer, transitionTarget,
  type AnalysisOutcome, type AnalyzerDefinition, type LLMProvider, type PipelineDeps,
} from "@/modules/intelligence";
import { createItem, findThreadItem, propose, queueReviewTask, type EngineOptions, type Outcome } from "@/modules/lifecycle";
import { listTeamCandidates } from "@/modules/tenancy";
import { withTenant } from "@/lib/db";
import { acceptedOwner, decideReply, nextBudgetWindow, shouldTrack, type Ok } from "./analysis-plan";

export interface AnalyzeDeps {
  provider: LLMProvider;
  pipeline?: Partial<PipelineDeps>;
  engine?: EngineOptions;
  now?: () => Date;
}

export type AnalyzeSummary =
  | { status: "SKIPPED"; reason: "MESSAGE_NOT_FOUND" | "OUR_OWN_MESSAGE_NO_ITEM" | "INBOUND_ON_OPEN_ITEM" | "ITEM_NOT_AWAITING_REPLY" }
  | { status: "NOT_ACTIONABLE" }
  | { status: "ITEM_CREATED"; itemId: string; ownerAssigned: boolean; caughtUp: number }
  | { status: "ITEM_EXISTS"; itemId: string }
  | { status: "REOPEN_SUGGESTED"; itemId: string }
  | { status: "ACKNOWLEDGED" | "RESPONDED"; itemId: string }
  | { status: "NO_CHANGE"; itemId: string }
  | { status: "NEEDS_REVIEW"; reason: string }
  /** The organization's LLM budget is spent. The job is delayed until the window rolls over. */
  | { status: "DEFERRED"; retryAt: Date };

class Deferred extends Error {
  constructor(readonly retryAt: Date) {
    super("deferred");
  }
}

/**
 * Handle one `analyze-message` job: decide what the message means and hand recommendations to the lifecycle engine.
 *
 *  - A new inbound message on a thread with no item: classify intent; if actionable, resolve an owner and create the item.
 *  - An inbound message on a thread whose item is CLOSED: if actionable, SUGGEST reopening (the engine queues an approval).
 *  - Our own reply on an open item: decide acknowledgment vs substantive response (rule 5) and propose the transition.
 * Analyzers only recommend; this is the only place those recommendations meet the engine, and the engine decides. Every step
 * is replay-safe (cached analyses, idempotent engine calls), so a retried job never duplicates anything. The job payload and
 * every log line carry ids only, never message content.
 */
export async function handleAnalyzeMessage(data: unknown, deps: AnalyzeDeps): Promise<AnalyzeSummary> {
  const parsed = analyzeMessageJob.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError("Invalid analyze-message job payload");
  const { organizationId, messageId } = parsed.data;
  const now = (deps.now ?? (() => new Date()))();

  try {
    return await analyze(organizationId, messageId, deps);
  } catch (e) {
    if (e instanceof Deferred) return { status: "DEFERRED", retryAt: e.retryAt };
    if (e instanceof ProviderError) {
      if (!e.retryable) throw new UnrecoverableError(`Provider rejected the request (${e.code})`);
      throw e;
    }
    log("error", "analyze.failed", { organizationId, messageId, errorName: e instanceof Error ? e.name : "unknown", at: now.toISOString() });
    throw e;
  }

  async function analyze(org: string, id: string, d: AnalyzeDeps): Promise<AnalyzeSummary> {
    const ctx = await loadMessageContext(org, id);
    if (!ctx) return { status: "SKIPPED", reason: "MESSAGE_NOT_FOUND" };
    const existing = await findThreadItem(org, ctx.threadId);
    const open = existing && existing.state !== "CLOSED" ? existing : null;
    const pipelineDeps: PipelineDeps = { provider: d.provider, ...d.pipeline };

    const run = async <R>(def: AnalyzerDefinition<R>, messageIds: string[], extra: { itemId?: string; candidates?: { id: string; name: string; handle: string }[] } = {}): Promise<AnalysisOutcome<R>> => {
      const out = await runAnalyzer(def, { organizationId: org, messageIds, subjectMessageId: id, ...extra }, pipelineDeps);
      if (out.outcome === "BUDGET_EXCEEDED") throw new Deferred(nextBudgetWindow(now));
      return out;
    };
    const asAnalyzer = (name: string, out: Ok<unknown>) => ({ type: "ANALYZER" as const, analyzer: name, analysisRunId: out.analysisRunId });

    // A reply from our side on an open item: acknowledgment versus substantive response.
    if (open && ctx.direction !== "INBOUND") {
      if (open.state !== "RECEIVED" && open.state !== "ACKNOWLEDGED" && open.state !== "REOPENED") return { status: "SKIPPED", reason: "ITEM_NOT_AWAITING_REPLY" };
      const ids = [...new Set([open.originMessageId, id])];
      const sub = await run(substantiveResponseAnalyzer, ids, { itemId: open.id });
      const ack = open.state === "ACKNOWLEDGED" ? null : await run(acknowledgmentDetector, ids, { itemId: open.id });
      for (const o of [sub, ack]) if (o && o.outcome === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", reason: o.reason };

      const subOk = sub.outcome === "OK" ? sub : null;
      const ackOk = ack && ack.outcome === "OK" ? ack : null;
      const decision = decideReply(open.state, { id, direction: ctx.direction }, subOk, ackOk);
      if (decision.kind === "CONTRADICTION") {
        await queueReviewTask(org, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: open.id });
        log("warn", "analyze.contradiction", { organizationId: org, messageId: id, itemId: open.id });
        return { status: "NEEDS_REVIEW", reason: "ACK_AND_SUBSTANTIVE_CONTRADICT" };
      }
      if (decision.kind === "NONE") return { status: "NO_CHANGE", itemId: open.id };

      const chosen = decision.kind === "RESPONDED" ? subOk! : ackOk!;
      const to = transitionTarget(chosen.recommendedAction)!;
      const outcome = await withTenant({ organizationId: org }, (tx) =>
        propose(tx, {
          organizationId: org, itemId: open.id, to, occurredAt: ctx.sentAt, messageId: id, confidence: chosen.confidence, evidence: chosen.evidence,
          actor: asAnalyzer(decision.kind === "RESPONDED" ? substantiveResponseAnalyzer.name : acknowledgmentDetector.name, chosen),
        }, d.engine));
      return fromEngine(outcome, open.id, decision.kind);
    }

    if (open) return { status: "SKIPPED", reason: "INBOUND_ON_OPEN_ITEM" }; // progress and resolution analyzers arrive in Sprint 7
    if (ctx.direction !== "INBOUND") return { status: "SKIPPED", reason: "OUR_OWN_MESSAGE_NO_ITEM" };

    // An inbound message with no open item: is it something we must act on?
    const intent = await run(intentClassifier, [id]);
    if (intent.outcome === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", reason: intent.reason };
    if (intent.outcome !== "OK" || !shouldTrack(intent)) return { status: "NOT_ACTIONABLE" };

    // After a closure, a new actionable message only SUGGESTS reopening; a human decides (rule 2).
    if (existing && existing.closedAt && ctx.sentAt > existing.closedAt) {
      const outcome = await withTenant({ organizationId: org }, (tx) =>
        propose(tx, {
          organizationId: org, itemId: existing.id, to: "REOPENED", occurredAt: ctx.sentAt, messageId: id, confidence: intent.confidence, evidence: intent.evidence,
          reason: "New actionable message after closure", actor: asAnalyzer(intentClassifier.name, intent),
        }, d.engine));
      await attachRunsToItem(org, [intent.analysisRunId], existing.id);
      return outcome.outcome === "APPROVAL_REQUIRED" ? { status: "REOPEN_SUGGESTED", itemId: existing.id } : fromEngine(outcome, existing.id, "REOPENED");
    }

    const teamId = ctx.teamId;
    if (!teamId) {
      await queueReviewTask(org, { type: "OWNERSHIP", refType: "Message", refId: id }); // no team to route to: a human must triage
      return { status: "NEEDS_REVIEW", reason: "SOURCE_HAS_NO_TEAM" };
    }

    // Resolve an owner at creation. A confident, valid, explicitly named team member is assigned; anything else goes to a human.
    const candidates = await listTeamCandidates(org, teamId);
    let ownerUserId: string | undefined;
    let ownerRun: string | undefined;
    if (candidates.length > 0) {
      const owner = await run(ownershipResolver, [id], { candidates });
      if (owner.outcome === "OK") {
        ownerRun = owner.analysisRunId;
        ownerUserId = acceptedOwner(owner, candidates, id) ?? undefined;
      }
    }

    const created = await withTenant({ organizationId: org }, (tx) =>
      createItem(tx, {
        organizationId: org, teamId, originMessageId: id, threadId: ctx.threadId, title: (ctx.subject ?? "(no subject)").slice(0, 200), priority: intent.result.priority,
        ...(ownerUserId ? { ownerUserId } : {}), occurredAt: ctx.sentAt, actor: asAnalyzer(intentClassifier.name, intent), confidence: intent.confidence,
      }, d.engine));
    if (created.outcome === "EXISTS") return { status: "ITEM_EXISTS", itemId: created.itemId };
    if (created.outcome === "REJECTED") return { status: "NEEDS_REVIEW", reason: created.reason };

    await attachRunsToItem(org, [intent.analysisRunId, ...(ownerRun ? [ownerRun] : [])], created.itemId);
    if (!ownerUserId) await queueReviewTask(org, { type: "OWNERSHIP", refType: "TrackedItem", refId: created.itemId });

    // Jobs for one thread can run in any order. A reply of ours whose job ran BEFORE the item existed was skipped, so now
    // that the item exists, evaluate the thread's later replies in order. Replays are idempotent, so a reply that also has
    // its own job simply finds the work already done.
    const origin = ctx.sentAt.getTime();
    const later = (await listThreadMessageRefs(org, ctx.threadId)).filter((m) => m.id !== id && m.direction !== "INBOUND" && m.sentAt.getTime() >= origin);
    for (const m of later) await analyze(org, m.id, d);

    log("info", "analyze.item_created", { organizationId: org, messageId: id, itemId: created.itemId, ownerAssigned: Boolean(ownerUserId), needsReview: created.needsReview, caughtUp: later.length });
    return { status: "ITEM_CREATED", itemId: created.itemId, ownerAssigned: Boolean(ownerUserId), caughtUp: later.length };
  }
}

function fromEngine(outcome: Outcome, itemId: string, kind: "RESPONDED" | "ACKNOWLEDGED" | "REOPENED"): AnalyzeSummary {
  if (outcome.outcome === "APPLIED") return kind === "REOPENED" ? { status: "NO_CHANGE", itemId } : { status: kind, itemId };
  if (outcome.outcome === "NOOP") return { status: "NO_CHANGE", itemId };
  if (outcome.outcome === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", reason: outcome.reason };
  if (outcome.outcome === "APPROVAL_REQUIRED") return { status: "REOPEN_SUGGESTED", itemId };
  return { status: "NEEDS_REVIEW", reason: outcome.reason }; // REJECTED: stale or illegal; a later message will re-evaluate
}


/**
 * BullMQ processor for `analyze-message`. When the organization's daily LLM budget is spent the job is delayed until the
 * window rolls over, without using up a retry attempt. Returns ids and a status only, never content.
 */
export function analyzeProcessor(deps: AnalyzeDeps) {
  return async (job: Job<{ organizationId: string; messageId: string }>, token?: string): Promise<AnalyzeSummary> => {
    const summary = await handleAnalyzeMessage(job.data, deps);
    if (summary.status === "DEFERRED") {
      await job.moveToDelayed(summary.retryAt.getTime(), token);
      throw new DelayedError();
    }
    return summary;
  };
}
