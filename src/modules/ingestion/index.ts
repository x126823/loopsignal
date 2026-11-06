// Public API of the ingestion module. Other modules import only from here.
// Fetch/receive, store raw events, normalize, dedupe, enqueue analysis. Replay-safe at every step.
export { canonicalJson, ingestEvent, type IngestParams, type IngestResult } from "./ingest";
export { enqueueOrganizationSync, syncSource, type SyncDeps, type SyncSummary } from "./sync";
export { handleIngestSourceJob } from "./handlers";
export { linkChatPerson, listChatPeople, type ChatPerson, type LinkOutcome } from "./participants";
export { listThreadMessageRefs, loadMessageContext, loadMessageFeatures, loadThreadMessages, type MessageContext, type MessageFeaturesView, type ThreadMessageRef, type ThreadMessageView } from "./context";
export { anonymizeParticipant, eraseMessageContent, listExpiredMessageIds, messageIdsOfParticipant, purgeExpiredRawEvents, purgeMessageContent, purgeRawEventsOfMessages, tombstoneFor, TOMBSTONE } from "./retention";
export { rekeyMessageContent, type RekeyCounts } from "./rekey";
