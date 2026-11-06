import { ingestSourceJob, UnrecoverableError } from "@/lib/queue";
import { log } from "@/lib/log";
import { ProviderSourceUnavailableError, UnsupportedProviderError } from "@/modules/integrations";
import { ConnectionAuthFailedError } from "@/modules/sources";
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
    // The provider refused the credentials and the connection is now marked ERROR (and audited). Nothing to retry: a person must reconnect.
    if (e instanceof ConnectionAuthFailedError) {
      return { status: "SKIPPED", reason: "CONNECTION_INACTIVE", pages: 0, events: 0, messagesCreated: 0, messagesExisting: 0, resyncs: 0, malformed: 0, payloadConflicts: 0, hasMore: false };
    }
    // The app cannot read this source right now (removed from the space, or its access is not approved). Skip quietly and try again at the
    // next scheduled sync: nothing is disabled, nothing is lost, and a retry storm would only add load.
    if (e instanceof ProviderSourceUnavailableError) {
      log("warn", "ingest.source_unavailable", { organizationId: parsed.data.organizationId, monitoredSourceId: parsed.data.monitoredSourceId });
      return { status: "SKIPPED", reason: "SOURCE_UNAVAILABLE", pages: 0, events: 0, messagesCreated: 0, messagesExisting: 0, resyncs: 0, malformed: 0, payloadConflicts: 0, hasMore: false };
    }
    if (e instanceof UnsupportedProviderError) throw new UnrecoverableError("No adapter for this provider");
    throw e;
  }
}
