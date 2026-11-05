import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client";
import { decryptField, parseFieldKey } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/modules/lifecycle";
import { execute, prepare, type CoreMessage, type FailureReason } from "./core";
import type { PromptCandidate } from "./prompt";
import { analyzerOutputSchema, type AnalyzerDefinition, type EvidenceItem, type RecommendedAction } from "./schemas";
import type { LLMProvider } from "./types";

export type { FailureReason } from "./core";

export interface AnalyzeRequest {
  organizationId: string;
  /** Messages the analyzer may see and cite (for example a thread). Their text is decrypted here, never passed in. */
  messageIds: string[];
  /** The message that triggered the analysis. Stored on the AnalysisRun. */
  subjectMessageId: string;
  itemId?: string;
  /** People the analyzer may choose from (for example team members). Part of the input hash and the untrusted block. */
  candidates?: PromptCandidate[];
}

export interface PipelineDeps {
  provider: LLMProvider;
  fieldKey?: Buffer;
  confidenceThreshold?: number;
  /** Per-organization LLM tokens per UTC day. Organization.settings.llm.dailyTokenBudget takes precedence. */
  dailyTokenBudget?: number;
  now?: () => Date;
  limits?: { maxMessages?: number; maxCharsPerMessage?: number; maxTotalChars?: number };
}

export type AnalysisOutcome<R> =
  | {
      outcome: "OK";
      analysisRunId: string;
      cached: boolean;
      result: R;
      confidence: number;
      evidence: EvidenceItem[];
      recommendedAction: RecommendedAction;
      requiresHumanApproval: boolean;
    }
  /** Nothing usable came back. A review task was queued and no state can move on this basis (rule 6). */
  | { outcome: "NEEDS_REVIEW"; reason: FailureReason; analysisRunId: string | null; reviewTaskId: string | null }
  /** The organization's daily LLM budget is spent. No call was made; retry after the window rolls over. */
  | { outcome: "BUDGET_EXCEEDED"; used: number; budget: number };

const DEFAULT_LIMITS = { maxMessages: 20, maxCharsPerMessage: 20_000, maxTotalChars: 60_000 };

/**
 * The guard pipeline every analyzer call goes through. Order matters:
 *   load + decrypt -> size limits -> redact -> input hash -> cache -> budget -> delimit -> provider call
 *   -> Zod validation (one bounded retry) -> evidence guard -> force human approval -> persist AnalysisRun.
 * No database transaction is held open across the model call. The model's output is never trusted: it is validated,
 * its evidence is checked against the original text, its approval flag is overridden where required, and failures
 * are recorded WITHOUT the raw output (which could echo content). Analyzers only recommend; nothing here, or in any
 * analyzer, writes lifecycle state.
 */
export async function runAnalyzer<R>(def: AnalyzerDefinition<R>, req: AnalyzeRequest, deps: PipelineDeps): Promise<AnalysisOutcome<R>> {
  const { organizationId } = req;
  const fieldKey = deps.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  const now = (deps.now ?? (() => new Date()))();
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const envelope = analyzerOutputSchema(def.resultSchema);

  // 1. Load and decrypt the messages, and read this organization's LLM usage today.
  const loaded = await withTenant({ organizationId }, async (tx) => {
    const rows = await tx.message.findMany({ where: { id: { in: req.messageIds } } });
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const usage = await tx.analysisRun.aggregate({ _sum: { tokensIn: true, tokensOut: true }, where: { createdAt: { gte: dayStart } } });
    return { rows, settings: org?.settings, used: (usage._sum.tokensIn ?? 0) + (usage._sum.tokensOut ?? 0) };
  });
  const byId = new Map(loaded.rows.map((r) => [r.id, r]));
  const uniqueIds = [...new Set(req.messageIds)];
  if (!byId.has(req.subjectMessageId) || uniqueIds.some((id) => !byId.has(id))) {
    return { outcome: "NEEDS_REVIEW", reason: "MESSAGE_NOT_FOUND", analysisRunId: null, reviewTaskId: null };
  }

  const originals = new Map<string, string>();
  const ordered = uniqueIds.map((id) => byId.get(id)!).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id.localeCompare(b.id));
  for (const m of ordered) originals.set(m.id, decryptField(m.bodyText, fieldKey, `${organizationId}:Message.bodyText`));

  const persistFailure = (reason: FailureReason, tokens = { tokensIn: 0, tokensOut: 0 }, extra: Record<string, unknown> = {}) =>
    recordFailure(def, req, deps.provider, reason, tokens, extra);

  // 2. Size limits. Oversized input is rejected, never silently truncated.
  const total = [...originals.values()].reduce((n, t) => n + t.length, 0);
  if (ordered.length > limits.maxMessages || total > limits.maxTotalChars || [...originals.values()].some((t) => t.length > limits.maxCharsPerMessage)) {
    return persistFailure("INPUT_TOO_LARGE");
  }

  // 3-4. Redact, hash and delimit (shared with golden-set evaluation).
  const coreMessages: CoreMessage[] = ordered.map((m) => ({ id: m.id, direction: m.direction, sentAt: m.sentAt, text: originals.get(m.id)! }));
  const prepared = prepare(def, coreMessages, req.candidates ?? [], deps.provider, fieldKey);
  const { inputHash } = prepared;

  // 5. Cache.
  const cached = await withTenant({ organizationId }, (tx) =>
    tx.analysisRun.findUnique({ where: { organizationId_analyzer_inputHash_promptVersion: { organizationId, analyzer: def.name, inputHash, promptVersion: def.promptVersion } } }));
  if (cached && cached.status === "OK") {
    const parsed = envelope.safeParse(cached.output);
    if (parsed.success) return okOutcome(cached.id, true, parsed.data);
  }

  // 6. Budget (a soft cap: concurrent calls can overshoot by their own size).
  const budget = orgBudget(loaded.settings) ?? deps.dailyTokenBudget ?? getEnv().LLM_DAILY_TOKEN_BUDGET;
  if (loaded.used >= budget) {
    log("warn", "analysis.budget_exceeded", { organizationId, analyzer: def.name, used: loaded.used, budget });
    return { outcome: "BUDGET_EXCEEDED", used: loaded.used, budget };
  }

  // 7-10. Call, validate, guard evidence, force approval.
  const run = await execute(def, prepared, deps.provider, threshold);
  if (run.kind === "failed") return persistFailure(run.reason, { tokensIn: run.tokensIn, tokensOut: run.tokensOut }, run.extra);

  const out = run.output;
  const { tokensIn, tokensOut } = run;
  const saved = await withTenant({ organizationId }, async (tx) => {
    const { count } = await tx.analysisRun.createMany({
      data: [{
        organizationId, analyzer: def.name, itemId: req.itemId ?? null, messageId: req.subjectMessageId, provider: deps.provider.name,
        model: deps.provider.model, promptVersion: def.promptVersion, inputHash, output: out as unknown as Prisma.InputJsonValue,
        confidence: out.confidence, evidence: out.evidence as unknown as Prisma.InputJsonValue, recommendedAction: out.recommendedAction,
        requiresHumanApproval: out.requiresHumanApproval, status: "OK", tokensIn, tokensOut,
      }],
      skipDuplicates: true, // a concurrent identical run may have won; use its row
    });
    const row = await tx.analysisRun.findUniqueOrThrow({ where: { organizationId_analyzer_inputHash_promptVersion: { organizationId, analyzer: def.name, inputHash, promptVersion: def.promptVersion } } });
    return { id: row.id, cached: count === 0 };
  });
  log("info", "analysis.completed", { organizationId, analyzer: def.name, status: "OK", cached: saved.cached, tokensIn, tokensOut, attempts: run.attempts });
  return okOutcome(saved.id, saved.cached, out);
}

function okOutcome<R>(id: string, cached: boolean, o: { result: R; confidence: number; evidence: EvidenceItem[]; recommendedAction: RecommendedAction; requiresHumanApproval: boolean }): AnalysisOutcome<R> {
  return { outcome: "OK", analysisRunId: id, cached, result: o.result, confidence: o.confidence, evidence: o.evidence, recommendedAction: o.recommendedAction, requiresHumanApproval: o.requiresHumanApproval };
}

function orgBudget(settings: unknown): number | undefined {
  const v = (settings as { llm?: { dailyTokenBudget?: unknown } } | null)?.llm?.dailyTokenBudget;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Record a failed analysis and queue a human review task. The raw model output is deliberately NOT stored: it can
 * contain echoed message content. The row gets a unique input hash so failures never block a later successful run
 * for the same input (the cache key is unique); the real hash is not needed to diagnose a failure.
 */
async function recordFailure<R>(
  def: AnalyzerDefinition<R>, req: AnalyzeRequest, provider: LLMProvider, reason: FailureReason,
  tokens: { tokensIn: number; tokensOut: number }, extra: Record<string, unknown>,
): Promise<AnalysisOutcome<R>> {
  const status = reason === "SCHEMA_FAILED" ? "SCHEMA_FAILED" : "REJECTED_GUARD";
  const saved = await withTenant({ organizationId: req.organizationId }, async (tx) => {
    const run = await tx.analysisRun.create({
      data: {
        organizationId: req.organizationId, analyzer: def.name, itemId: req.itemId ?? null, messageId: req.subjectMessageId, provider: provider.name,
        model: provider.model, promptVersion: def.promptVersion, inputHash: `failed-${randomUUID()}`, output: { reason, ...extra } as Prisma.InputJsonValue,
        evidence: [], requiresHumanApproval: true, status, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut,
      },
    });
    const task = await tx.reviewTask.create({ data: { organizationId: req.organizationId, type: "SCHEMA_FAILURE", refType: "AnalysisRun", refId: run.id } });
    return { runId: run.id, taskId: task.id };
  });
  log("warn", "analysis.failed", { organizationId: req.organizationId, analyzer: def.name, reason, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut });
  return { outcome: "NEEDS_REVIEW", reason, analysisRunId: saved.runId, reviewTaskId: saved.taskId };
}

/**
 * Link analysis runs to the item they led to, so that "why is this person the owner?" and "what did the classifier say?"
 * are answerable from the item. Only runs that are not yet linked are touched.
 */
export async function attachRunsToItem(organizationId: string, runIds: string[], itemId: string): Promise<number> {
  if (runIds.length === 0) return 0;
  return withTenant({ organizationId }, async (tx) => (await tx.analysisRun.updateMany({ where: { id: { in: runIds }, itemId: null }, data: { itemId } })).count);
}
