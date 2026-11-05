// Public API of the ingestion module. Other modules import only from here.
// Fetch/receive, store raw events, normalize, dedupe, enqueue analysis. Replay-safe at every step.
export { canonicalJson, ingestEvent, type IngestParams, type IngestResult } from "./ingest";
export { enqueueOrganizationSync, syncSource, type SyncDeps, type SyncSummary } from "./sync";
export { handleIngestSourceJob } from "./handlers";
export { listThreadMessageRefs, loadMessageContext, loadThreadMessages, type MessageContext, type ThreadMessageRef, type ThreadMessageView } from "./context";
