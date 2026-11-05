import { DelayedError, UnrecoverableError, analyzeMessageJob } from "@/lib/queue";
import type { Job } from "bullmq";
import { log } from "@/lib/log";
import { listThreadMessageRefs, loadMessageContext } from "@/modules/ingestion";
import {
  acknowledgmentDetector, attachRunsToItem, intentClassifier, ownershipResolver, progressAnalyzer, ProviderError, resolutionAnalyzer, runAnalyzer, substantiveResponseAnalyzer, transitionTarget,
  type AnalysisOutcome, type AnalyzerDefinition, type LLMProvider, type PipelineDeps,
} from "@/modules/intelligence";
import { createItem, findThreadItem, propose, queueReviewTask, type EngineOptions, type Outcome } from "@/modules/lifecycle";
import { listTeamCandidates } from "@/modules/tenancy";
import { withTenant } from "@/lib/db";
import { acceptedOwner, decideProgress, decideReply, decideResolution, nextBudgetWindow, shouldTrack, type Ok } from "./analysis-plan";
import type { ItemState } from "../../generated/prisma/enums";

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
  | { status: "ACKNOWLEDGED" | "RESPONDED" | "IN_PROGRESS" | "RESOLUTION_PROPOSED"; itemId: string }
  /** A customer message looks like a confirmation. Only a suggestion: an approval is queued for a human. */
  | { status: "CONFIRMATION_SUGGESTED"; itemId: string }
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

    const subject = { id, direction: ctx.direction };
    const proposeAs = async (item: { id: string }, to: ItemState, out: Ok<unknown>, analyzer: string, reason?: string) =>
      withTenant({ organizationId: org }, (tx) =>
        propose(tx, {
          organizationId: org, itemId: item.id, to, occurredAt: ctx.sentAt, messageId: id, confidence: out.confidence, evidence: out.evidence,
          ...(reason ? { reason } : {}), actor: asAnalyzer(analyzer, out),
        }, d.engine));

    // A reply from our side on an open item. One message can advance the item several steps (for example a first reply that
    // answers AND says it is fixed), so each stage re-reads the item and the next stage runs on its new state.
    if (open && ctx.direction !== "INBOUND") {
      let item = open;
      let applied: AnalyzeSummary | null = null;
      const ids = [...new Set([open.originMessageId, id])];
      const refresh = async () => (await findThreadItem(org, ctx.threadId)) ?? item;

      // Stage 1: acknowledgment versus substantive response (rule 5).
      if (item.state === "RECEIVED" || item.state === "ACKNOWLEDGED" || item.state === "REOPENED") {
        const sub = await run(substantiveResponseAnalyzer, ids, { itemId: item.id });
        const ack = item.state === "ACKNOWLEDGED" ? null : await run(acknowledgmentDetector, ids, { itemId: item.id });
        for (const o of [sub, ack]) if (o && o.outcome === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", reason: o.reason };
        const subOk = sub.outcome === "OK" ? sub : null;
        const ackOk = ack && ack.outcome === "OK" ? ack : null;
        const decision = decideReply(item.state, subject, subOk, ackOk);
        if (decision.kind === "CONTRADICTION") {
          await queueReviewTask(org, { type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: item.id });
          log("warn", "analyze.contradiction", { organizationId: org, messageId: id, itemId: item.id });
          return { status: "NEEDS_REVIEW", reason: "ACK_AND_SUBSTANTIVE_CONTRADICT" };
        }
        if (decision.kind !== "NONE") {
          const chosen = decision.kind === "RESPONDED" ? subOk! : ackOk!;
          const outcome = await proposeAs(item, transitionTarget(chosen.recommendedAction)!, chosen, decision.kind === "RESPONDED" ? substantiveResponseAnalyzer.name : acknowledgmentDetector.name);
          applied = fromEngine(outcome, item.id, decision.kind);
          item = await refresh();
        }
      } else if (item.state !== "RESPONDED" && item.state !== "IN_PROGRESS") {
        return { status: "SKIPPED", reason: "ITEM_NOT_AWAITING_REPLY" };
      }

      // Stage 2: has the work been declared fixed (a PROPOSAL, never a resolution), or is it merely underway?
      if (item.state === "RESPONDED" || item.state === "IN_PROGRESS") {
        const res = await run(resolutionAnalyzer, ids, { itemId: item.id });
        if (res.outcome === "NEEDS_REVIEW") return applied ?? { status: "NEEDS_REVIEW", reason: res.reason };
        const verdict = decideResolution(item.state, subject, res.outcome === "OK" ? res : null);
        if (verdict.kind === "PROPOSE_RESOLUTION" && res.outcome === "OK") {
          const outcome = await proposeAs(item, "RESOLUTION_PROPOSED", res, resolutionAnalyzer.name);
          return fromEngine(outcome, item.id, "RESOLUTION_PROPOSED");
        }
        if (item.state === "RESPONDED") {
          const prog = await run(progressAnalyzer, ids, { itemId: item.id });
          if (prog.outcome === "NEEDS_REVIEW") return applied ?? { status: "NEEDS_REVIEW", reason: prog.reason };
          if (prog.outcome === "OK" && decideProgress(item.state, subject, prog).kind === "IN_PROGRESS") {
            const outcome = await proposeAs(item, "IN_PROGRESS", prog, progressAnalyzer.name);
            return fromEngine(outcome, item.id, "IN_PROGRESS");
          }
        }
      }
      return applied ?? { status: "NO_CHANGE", itemId: item.id };
    }

    // A customer message while a resolution is proposed: a confirmation is only ever SUGGESTED to a human (rule 2), and a
    // rejection sends the item back to work.
    if (open && open.state === "RESOLUTION_PROPOSED") {
      const refs = await listThreadMessageRefs(org, ctx.threadId);
      const lastOurs = [...refs].reverse().find((m) => m.direction !== "INBOUND" && m.sentAt.getTime() <= ctx.sentAt.getTime());
      const ids = [...new Set([open.originMessageId, ...(lastOurs ? [lastOurs.id] : []), id])];
      const res = await run(resolutionAnalyzer, ids, { itemId: open.id });
      if (res.outcome === "NEEDS_REVIEW") return { status: "NEEDS_REVIEW", reason: res.reason };
      const verdict = decideResolution(open.state, subject, res.outcome === "OK" ? res : null);
      if (verdict.kind === "SUGGEST_CONFIRMATION" && res.outcome === "OK") {
        const outcome = await proposeAs(open, "RESOLUTION_CONFIRMED", res, resolutionAnalyzer.name, "Customer appears to confirm the resolution");
        return outcome.outcome === "APPROVAL_REQUIRED" ? { status: "CONFIRMATION_SUGGESTED", itemId: open.id } : fromEngine(outcome, open.id, "IN_PROGRESS");
      }
      if (verdict.kind === "BACK_TO_IN_PROGRESS" && res.outcome === "OK") {
        return fromEngine(await proposeAs(open, "IN_PROGRESS", res, resolutionAnalyzer.name, "Customer says the resolution did not work"), open.id, "IN_PROGRESS");
      }
      return { status: "NO_CHANGE", itemId: open.id };
    }

    if (open) return { status: "SKIPPED", reason: "INBOUND_ON_OPEN_ITEM" };
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

function fromEngine(outcome: Outcome, itemId: string, kind: "RESPONDED" | "ACKNOWLEDGED" | "IN_PROGRESS" | "RESOLUTION_PROPOSED" | "REOPENED"): AnalyzeSummary {
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
