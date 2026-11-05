// BullMQ worker entrypoint. Workers call module APIs; modules never import from here.
// `analyze-message` jobs are produced by ingestion but have no consumer until the analyzers land (Sprint 6).
import { log } from "@/lib/log";
import { closeQueueHub, QUEUES, queueHub } from "@/lib/queue";
import { handleIngestSourceJob } from "@/modules/ingestion";

const hub = queueHub();

const ingest = hub.worker(QUEUES.ingestSource, async (job) => handleIngestSourceJob(job.data, { hub }), { concurrency: 2 });
ingest.on("completed", (job) => log("info", "job.completed", { queue: QUEUES.ingestSource, jobId: job.id ?? null }));
ingest.on("failed", (job, err) =>
  log("warn", "job.failed", { queue: QUEUES.ingestSource, jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0, errorName: err.name }));

const workers = [ingest];
log("info", "worker.started", { queues: workers.length, prefix: hub.config.prefix });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping", { signal });
  await Promise.all(workers.map((w) => w.close())); // waits for in-flight jobs
  await closeQueueHub();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
