// After a person decides a cross-channel candidate, queue the work that follows. Replay-safe: the candidate is stamped only after
// every analysis job was queued, and the analysis jobs themselves are idempotent.
import { UnrecoverableError } from "bullmq";
import { correlationFollowUpJob, jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { runFollowUp, type FollowUpOutcome } from "@/modules/correlation";

export async function handleCorrelationFollowUp(data: unknown, deps: { hub: QueueHub }): Promise<FollowUpOutcome> {
  const parsed = correlationFollowUpJob.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError("Invalid correlation-follow-up job payload");
  const { organizationId, candidateId } = parsed.data;
  return runFollowUp(organizationId, candidateId, {
    enqueueAnalysis: async (messageId, jobId) => { await deps.hub.enqueue(QUEUES.analyzeMessage, { organizationId, messageId }, jobId); },
    jobId: jobIds.analyzeAfterDecision,
  });
}
