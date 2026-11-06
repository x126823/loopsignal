import { parseFieldKey } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { recordAudit } from "@/modules/audit";
import { listExpiredMessageIds, purgeExpiredRawEvents, purgeMessageContent, tombstoneFor } from "@/modules/ingestion";
import { redactEvidenceForMessages } from "@/modules/intelligence";
import { getRetention } from "./settings";

/**
 * One retention pass for one organization. Safe to repeat and to interrupt: every batch is its own transaction and removing what is
 * already removed changes nothing. The rules (the SQL functions encode them): content of an item that is still open is never touched;
 * a raw payload goes `rawEventDays` after it arrived; a message body (and the quotes copied from it into analysis runs) goes
 * `messageDays` after its item closed, or after it arrived if it belongs to no item. Lifecycle events and the audit log are not touched.
 */
export interface RetentionRun { rawEvents: number; messages: number; evidenceRuns: number; batches: number; complete: boolean }
export interface RetentionDeps { now?: () => Date; fieldKey?: Buffer; batchSize?: number; maxBatches?: number }

const DAY = 86_400_000;

export async function runRetention(organizationId: string, deps: RetentionDeps = {}): Promise<RetentionRun> {
  const now = (deps.now ?? (() => new Date()))();
  const fieldKey = deps.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  const batchSize = deps.batchSize ?? 500;
  const maxBatches = deps.maxBatches ?? 40;
  const windows = await getRetention(organizationId);
  const rawCutoff = new Date(now.getTime() - windows.rawEventDays * DAY);
  const messageCutoff = new Date(now.getTime() - windows.messageDays * DAY);
  const tombstone = tombstoneFor(organizationId, fieldKey);
  const ctx = { organizationId };
  const out: RetentionRun = { rawEvents: 0, messages: 0, evidenceRuns: 0, batches: 0, complete: true };

  for (let i = 0; i < maxBatches; i++) {
    const n = await withTenant(ctx, (tx) => purgeExpiredRawEvents(tx, organizationId, rawCutoff, batchSize), { timeoutMs: 30_000 });
    out.batches++;
    out.rawEvents += n;
    if (n < batchSize) break;
    if (i === maxBatches - 1) out.complete = false;
  }
  for (let i = 0; i < maxBatches; i++) {
    const changed = await withTenant(ctx, async (tx) => {
      const ids = await listExpiredMessageIds(tx, organizationId, messageCutoff, batchSize);
      const purged = await purgeMessageContent(tx, organizationId, ids, { tombstone, now });
      out.evidenceRuns += await redactEvidenceForMessages(tx, organizationId, purged);
      return { purged: purged.length, listed: ids.length };
    }, { timeoutMs: 30_000 });
    out.batches++;
    out.messages += changed.purged;
    if (changed.listed < batchSize) break;
    if (i === maxBatches - 1) out.complete = false;
  }

  if (out.rawEvents > 0 || out.messages > 0) {
    await withTenant(ctx, (tx) => recordAudit(tx, {
      organizationId, actorType: "SYSTEM", action: "retention.purged", entityType: "Organization", entityId: organizationId,
      metadata: { rawEvents: out.rawEvents, messages: out.messages, evidenceRuns: out.evidenceRuns, rawEventDays: windows.rawEventDays, messageDays: windows.messageDays, complete: out.complete },
    }));
  }
  log("info", "retention.run", { organizationId, rawEvents: out.rawEvents, messages: out.messages, evidenceRuns: out.evidenceRuns, complete: out.complete });
  return out;
}
