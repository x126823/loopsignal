import { withTenant } from "@/lib/db";
import { parseFieldKey } from "@/lib/crypto/fields";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { getAdapter, type AdapterRegistry } from "@/modules/integrations";
import { gmailAdapterFor } from "@/modules/sources";
import { ingestEvent, sha256 } from "./ingest";

export interface SyncDeps {
  hub: QueueHub;
  adapterFor?: AdapterRegistry;
  pageSize?: number;
  /** Pages per job. A longer backlog continues in a follow-up job so one job stays short. */
  maxPages?: number;
  now?: () => Date;
  fieldKey?: Buffer;
}

export interface SyncSummary {
  status: "SYNCED" | "SKIPPED" | "CURSOR_MOVED";
  reason?: "SOURCE_NOT_FOUND" | "SOURCE_DISABLED" | "CONNECTION_INACTIVE";
  pages: number;
  events: number;
  messagesCreated: number;
  messagesExisting: number;
  /** Times the provider said our position was lost and the sync restarted from a bounded window (Gmail history gap). */
  resyncs: number;
  malformed: number;
  payloadConflicts: number;
  hasMore: boolean;
}

const TX_TIMEOUT_MS = 30_000;

/** Providers without credentials come from the integrations registry; Gmail is built for its connection from stored credentials. */
const defaultAdapterFor: AdapterRegistry = (provider, context) => {
  if (provider === "GMAIL") {
    if (!context) throw new Error("A Gmail adapter needs its connection");
    return gmailAdapterFor(context);
  }
  return getAdapter(provider);
};

/**
 * Pull new events for one monitored source and ingest them. Every step is safe to replay:
 *
 *   per page:  1. fetch from the provider (outside any transaction)
 *              2. ingest the whole page in ONE transaction (all or nothing)
 *              3. enqueue `analyze-message` for each message (deterministic job id, so repeats are no-ops)
 *              4. advance the source cursor with a compare-and-set
 *
 * A crash or error anywhere re-fetches the same page next time: ingestion dedupes, enqueueing is idempotent, and
 * the cursor only moves after the page is stored and queued, so no message can be stranded without an analysis job.
 */
export async function syncSource(input: { organizationId: string; monitoredSourceId: string }, deps: SyncDeps): Promise<SyncSummary> {
  const { organizationId, monitoredSourceId } = input;
  const adapterFor = deps.adapterFor ?? defaultAdapterFor;
  const pageSize = deps.pageSize ?? 25;
  const maxPages = deps.maxPages ?? 20;
  const now = deps.now ?? (() => new Date());
  const fieldKey = deps.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  const summary: SyncSummary = { status: "SYNCED", pages: 0, events: 0, messagesCreated: 0, messagesExisting: 0, resyncs: 0, malformed: 0, payloadConflicts: 0, hasMore: false };

  const source = await withTenant({ organizationId }, (tx) => tx.monitoredSource.findUnique({ where: { id: monitoredSourceId }, include: { connection: true } }));
  const skip = (reason: NonNullable<SyncSummary["reason"]>): SyncSummary => ({ ...summary, status: "SKIPPED", reason });
  if (!source) return skip("SOURCE_NOT_FOUND");
  if (!source.enabled) return skip("SOURCE_DISABLED");
  if (source.connection.status !== "ACTIVE") return skip("CONNECTION_INACTIVE");

  const adapter = await adapterFor(source.connection.provider, { organizationId, connectionId: source.connectionId });
  const ref = { kind: source.kind, externalId: source.externalId };
  let cursor = source.cursor;

  for (let page = 0; page < maxPages; page++) {
    const fetched = await adapter.fetch(ref, cursor, pageSize);
    if (fetched.notice === "RESYNC") {
      summary.resyncs++;
      log("warn", "ingest.resync", { organizationId, monitoredSourceId });
    }

    const results = await withTenant({ organizationId }, async (tx) => {
      const out = [];
      for (const event of fetched.events) out.push(await ingestEvent(tx, { organizationId, monitoredSourceId, event, adapter, fieldKey }));
      return out;
    }, { timeoutMs: TX_TIMEOUT_MS });

    for (const r of results) {
      if (r.result === "MESSAGE_CREATED") summary.messagesCreated++;
      else if (r.result === "MESSAGE_EXISTS") summary.messagesExisting++;
      else if (r.result === "MALFORMED") summary.malformed++;
      else summary.payloadConflicts++;
      if (r.result === "MESSAGE_CREATED" || r.result === "MESSAGE_EXISTS") {
        const job = { organizationId, messageId: r.messageId };
        await deps.hub.enqueue(QUEUES.analyzeMessage, job, jobIds.analyzeMessage(job)); // idempotent
      }
    }
    summary.pages++;
    summary.events += fetched.events.length;

    const { count } = await withTenant({ organizationId }, (tx) =>
      tx.monitoredSource.updateMany({ where: { id: monitoredSourceId, cursor }, data: { cursor: fetched.nextCursor, lastSyncedAt: now() } }));
    if (count !== 1) return { ...summary, status: "CURSOR_MOVED" }; // another worker advanced it; stop, no harm done
    cursor = fetched.nextCursor;
    summary.hasMore = fetched.hasMore;
    if (!fetched.hasMore) break;
  }

  if (summary.hasMore) {
    const job = { organizationId, monitoredSourceId };
    await deps.hub.enqueue("ingest-source", job, jobIds.ingestSource(job, `c-${sha256(cursor ?? "").slice(0, 16)}`));
  }
  log("info", "ingest.synced", {
    organizationId, monitoredSourceId, pages: summary.pages, events: summary.events, created: summary.messagesCreated,
    existing: summary.messagesExisting, resyncs: summary.resyncs, malformed: summary.malformed, conflicts: summary.payloadConflicts, hasMore: summary.hasMore,
  });
  return summary;
}

/**
 * Queue a sync for every enabled source of an organization whose connection is active (optionally only those whose
 * external id starts with `externalIdPrefix`). `key` distinguishes triggers.
 */
export async function enqueueOrganizationSync(organizationId: string, hub: QueueHub, key: string, opts: { externalIdPrefix?: string; provider?: "GMAIL" | "GOOGLE_CHAT" | "SYNTHETIC" } = {}): Promise<string[]> {
  const sources = await withTenant({ organizationId }, (tx) =>
    tx.monitoredSource.findMany({
      where: { enabled: true, connection: { status: "ACTIVE", ...(opts.provider ? { provider: opts.provider } : {}) }, ...(opts.externalIdPrefix ? { externalId: { startsWith: opts.externalIdPrefix } } : {}) },
    }));
  const ids: string[] = [];
  for (const s of sources) {
    const job = { organizationId, monitoredSourceId: s.id };
    await hub.enqueue("ingest-source", job, jobIds.ingestSource(job, key));
    ids.push(s.id);
  }
  return ids;
}
