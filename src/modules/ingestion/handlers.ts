import { ingestSourceJob, UnrecoverableError } from "@/lib/queue";
import { UnsupportedProviderError } from "@/modules/integrations";
import { syncSource, type SyncDeps, type SyncSummary } from "./sync";

/**
 * BullMQ handler for `ingest-source`. A payload that fails validation, or a provider with no adapter, can never
 * succeed, so those are unrecoverable (straight to the dead-letter queue). Everything else is transient: BullMQ
 * retries with backoff, and because every step is replay-safe a retry never duplicates anything.
 */
export async function handleIngestSourceJob(data: unknown, deps: SyncDeps): Promise<SyncSummary> {
  const parsed = ingestSourceJob.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError("Invalid ingest-source job payload");
  try {
    return await syncSource(parsed.data, deps);
  } catch (e) {
    if (e instanceof UnsupportedProviderError) throw new UnrecoverableError("No adapter for this provider");
    throw e;
  }
}
