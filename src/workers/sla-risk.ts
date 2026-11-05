// The advisory SLA risk assessment. It reads the thread plus system-measured timer progress and stores a hint for people.
// It never touches timers, breaches or item state: the SLA engine and lifecycle engine own those.
import { UnrecoverableError } from "bullmq";
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { slaRiskJob } from "@/lib/queue";
import { listThreadMessageRefs, loadMessageContext } from "@/modules/ingestion";
import { ProviderError, runAnalyzer, slaRiskAnalyzer, type LLMProvider, type PipelineDeps } from "@/modules/intelligence";
import { loadItemForSla } from "@/modules/lifecycle";
import { timerProgress } from "@/modules/sla";

export interface SlaRiskDeps {
  provider: LLMProvider;
  pipeline?: Partial<PipelineDeps>;
  clock?: Clock;
}

export type SlaRiskSummary =
  | { status: "ASSESSED"; risk: "LOW" | "MEDIUM" | "HIGH"; analysisRunId: string; cached: boolean }
  | { status: "SKIPPED"; reason: "TIMER_NOT_OPEN" | "ITEM_NOT_FOUND" | "NO_MESSAGES" }
  /** The analyzer gave no usable answer, or the organization's budget is spent. Advisory, so nothing is retried or queued for review. */
  | { status: "NO_ASSESSMENT"; reason: string };

const MAX_MESSAGES = 20;

export async function handleSlaRisk(data: unknown, deps: SlaRiskDeps): Promise<SlaRiskSummary> {
  const parsed = slaRiskJob.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError("Invalid sla-risk job payload");
  const { organizationId, itemId, timerId } = parsed.data;
  try {
    const progress = await timerProgress(organizationId, itemId, timerId, { clock: deps.clock ?? systemClock });
    if (!progress) return { status: "SKIPPED", reason: "TIMER_NOT_OPEN" };
    const item = await loadItemForSla(organizationId, itemId);
    if (!item) return { status: "SKIPPED", reason: "ITEM_NOT_FOUND" };
    const origin = await loadMessageContext(organizationId, item.originMessageId);
    if (!origin) return { status: "SKIPPED", reason: "NO_MESSAGES" };

    const refs = (await listThreadMessageRefs(organizationId, origin.threadId)).slice(-MAX_MESSAGES);
    const last = refs.at(-1);
    if (!last) return { status: "SKIPPED", reason: "NO_MESSAGES" };

    const out = await runAnalyzer(slaRiskAnalyzer, {
      organizationId, messageIds: refs.map((m) => m.id), subjectMessageId: last.id, itemId,
      facts: { timerType: progress.type, percentElapsed: progress.percentElapsed },
    }, { provider: deps.provider, ...deps.pipeline });
    if (out.outcome === "BUDGET_EXCEEDED") return { status: "NO_ASSESSMENT", reason: "BUDGET_EXCEEDED" };
    if (out.outcome === "NEEDS_REVIEW") return { status: "NO_ASSESSMENT", reason: out.reason };
    return { status: "ASSESSED", risk: out.result.risk, analysisRunId: out.analysisRunId, cached: out.cached };
  } catch (e) {
    if (e instanceof ProviderError) {
      if (!e.retryable) throw new UnrecoverableError(`Provider rejected the request (${e.code})`);
      throw e;
    }
    log("error", "sla.risk_failed", { organizationId, itemId, errorName: e instanceof Error ? e.name : "unknown" });
    throw e;
  }
}
