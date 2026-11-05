import { randomUUID } from "node:crypto";
import { QueueHub, QUEUES, deadLetterName } from "@/lib/queue";

/** An isolated BullMQ namespace with fast retries, so tests never touch each other's jobs or real queues. */
export function createTestHub(): QueueHub {
  return new QueueHub({
    redisUrl: process.env["REDIS_URL"]!,
    prefix: `test-${randomUUID().slice(0, 8)}`,
    jobOptions: { attempts: 5, backoff: { type: "exponential", delay: 20 } },
  });
}

export async function destroyTestHub(hub: QueueHub): Promise<void> {
  for (const name of [QUEUES.ingestSource, QUEUES.analyzeMessage, QUEUES.slaScan, QUEUES.slaRisk, QUEUES.correlationFollowUp, deadLetterName(QUEUES.ingestSource), deadLetterName(QUEUES.analyzeMessage)]) {
    await hub.queue(name).obliterate({ force: true });
  }
  await hub.close();
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const waitingJobs = (hub: QueueHub, name: string) => hub.queue(name).getJobs(["waiting", "delayed", "active", "prioritized"]);
