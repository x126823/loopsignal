// BullMQ worker entrypoint. Workers call module APIs; modules never import from here.
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { closeQueueHub, QUEUES, queueHub } from "@/lib/queue";
import { handleIngestSourceJob } from "@/modules/ingestion";
import { createProviderFromEnv } from "@/modules/intelligence";
import { analyzeProcessor } from "./analyze-message";
import { handleSlaRisk } from "./sla-risk";
import { handleSlaScan, registerSlaScanSchedule } from "./sla-scan";

const hub = queueHub();
const provider = createProviderFromEnv();

const ingest = hub.worker(QUEUES.ingestSource, async (job) => handleIngestSourceJob(job.data, { hub }), { concurrency: 2 });
ingest.on("completed", (job) => log("info", "job.completed", { queue: QUEUES.ingestSource, jobId: job.id ?? null }));
ingest.on("failed", (job, err) =>
  log("warn", "job.failed", { queue: QUEUES.ingestSource, jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0, errorName: err.name }));

const analyze = hub.worker<{ organizationId: string; messageId: string }>(QUEUES.analyzeMessage, analyzeProcessor({ provider }), {
  concurrency: 2,
  limiter: { max: getEnv().ANALYZE_RATE_PER_MINUTE, duration: 60_000 },
});
analyze.on("completed", (job, result: { status?: string }) => log("info", "job.completed", { queue: QUEUES.analyzeMessage, jobId: job.id ?? null, status: result.status ?? null }));
analyze.on("failed", (job, err) =>
  log("warn", "job.failed", { queue: QUEUES.analyzeMessage, jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0, errorName: err.name }));

// SLA: one scan at a time (concurrency 1) so scans never overlap; the advisory risk jobs share the LLM rate limit.
const slaScan = hub.worker(QUEUES.slaScan, async () => {
  const r = await handleSlaScan({ hub });
  return { organizations: r.organizations, items: r.items, warned: r.warned.length, breached: r.breached.length, riskJobs: r.riskJobs, failures: r.failures };
}, { concurrency: 1 });
slaScan.on("failed", (job, err) => log("warn", "job.failed", { queue: QUEUES.slaScan, jobId: job?.id ?? null, errorName: err.name }));

const slaRisk = hub.worker(QUEUES.slaRisk, async (job) => handleSlaRisk(job.data, { provider }), {
  concurrency: 1,
  limiter: { max: getEnv().ANALYZE_RATE_PER_MINUTE, duration: 60_000 },
});
slaRisk.on("failed", (job, err) => log("warn", "job.failed", { queue: QUEUES.slaRisk, jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? 0, errorName: err.name }));

void registerSlaScanSchedule(hub).catch((e) => log("error", "sla.schedule_failed", { errorName: e instanceof Error ? e.name : "unknown" }));

const workers = [ingest, analyze, slaScan, slaRisk];
log("info", "worker.started", { queues: workers.length, prefix: hub.config.prefix, provider: provider.name, model: provider.model });

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
