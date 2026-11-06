import { deadLetterName, type QueueHub } from "./queues";
import { deadLetterRecord, JOB_SCHEMAS, QUEUES, type DeadLetterRecord, type QueueName } from "./jobs";

/**
 * Operating on dead-letter queues (docs/runbooks/queues.md). A dead letter holds ids and the error CLASS only, never a message or an error
 * text (those can echo content), so it is safe to list and to attach to a ticket. Retrying re-queues the original job through the same
 * validated path as any other job, under a fresh id, and removes the dead letter only after the new job was accepted.
 */
const NAMES = Object.values(QUEUES) as QueueName[];

export interface DeadLetterView extends DeadLetterRecord { deadId: string }

export async function listDeadLetters(hub: QueueHub, only?: QueueName): Promise<DeadLetterView[]> {
  const out: DeadLetterView[] = [];
  for (const name of only ? [only] : NAMES) {
    const jobs = await hub.queue(deadLetterName(name)).getJobs(["waiting", "completed", "delayed", "failed"], 0, 200);
    for (const job of jobs) {
      const parsed = deadLetterRecord.safeParse(job.data);
      if (parsed.success) out.push({ ...parsed.data, deadId: String(job.id) });
    }
  }
  return out.sort((a, b) => a.failedAt.localeCompare(b.failedAt));
}

export type RetryOutcome = "REQUEUED" | "NOT_FOUND" | "INVALID";

export async function retryDeadLetter(hub: QueueHub, queue: QueueName, deadId: string, now: () => number = Date.now): Promise<RetryOutcome> {
  const dead = hub.queue(deadLetterName(queue));
  const job = await dead.getJob(deadId);
  if (!job) return "NOT_FOUND";
  const record = deadLetterRecord.safeParse(job.data);
  if (!record.success || !JOB_SCHEMAS[queue].safeParse(record.data.data).success) return "INVALID";
  await hub.enqueue(queue, record.data.data, `retry-${deadId}-${now()}`.replace(/:/g, "-")); // validated again, deterministic-looking but unique
  await job.remove();
  return "REQUEUED";
}
