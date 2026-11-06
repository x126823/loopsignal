import { decryptField, encryptField } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";

/**
 * Key rotation for stored message content: re-encrypt every message body and raw payload of one organization from `from` to `to`.
 * Idempotent and resumable: a blob that already opens with the new key is left alone, so an interrupted run is simply run again.
 * A blob that opens with neither key is counted as failed and left untouched (never overwritten). Raw payloads go through the
 * maintenance function, the only path past their append-only guard, which changes nothing but the encrypted bytes.
 */
export interface RekeyCounts { rewritten: number; alreadyCurrent: number; failed: number }
const empty = (): RekeyCounts => ({ rewritten: 0, alreadyCurrent: 0, failed: 0 });

/** Returns the blob under the new key, "current" if it already is, or null when neither key opens it. */
function reencrypt(blob: Uint8Array, aad: string, from: Buffer, to: Buffer): Uint8Array<ArrayBuffer> | "current" | null {
  try {
    return encryptField(decryptField(blob, from, aad), to, aad);
  } catch {
    try {
      decryptField(blob, to, aad);
      return "current";
    } catch {
      return null;
    }
  }
}

export async function rekeyMessageContent(organizationId: string, from: Buffer, to: Buffer, opts: { batchSize?: number } = {}): Promise<{ bodies: RekeyCounts; rawEvents: RekeyCounts }> {
  const batchSize = opts.batchSize ?? 200;
  const bodies = empty();
  const rawEvents = empty();

  let after: string | undefined;
  for (;;) {
    const done = await withTenant({ organizationId }, async (tx) => {
      const rows = await tx.message.findMany({ where: after ? { id: { gt: after } } : {}, orderBy: { id: "asc" }, take: batchSize, select: { id: true, bodyText: true } });
      for (const m of rows) {
        const next = reencrypt(m.bodyText, `${organizationId}:Message.bodyText`, from, to);
        if (next === null) bodies.failed++;
        else if (next === "current") bodies.alreadyCurrent++;
        else {
          await tx.message.update({ where: { organizationId_id: { organizationId, id: m.id } }, data: { bodyText: next } });
          bodies.rewritten++;
        }
      }
      after = rows.at(-1)?.id;
      return rows.length < batchSize;
    }, { timeoutMs: 60_000 });
    if (done) break;
  }

  after = undefined;
  for (;;) {
    const done = await withTenant({ organizationId }, async (tx) => {
      const rows = await tx.rawEvent.findMany({ where: after ? { id: { gt: after } } : {}, orderBy: { id: "asc" }, take: batchSize, select: { id: true, payload: true } });
      for (const r of rows) {
        const next = reencrypt(r.payload, `${organizationId}:RawEvent.payload`, from, to);
        if (next === null) rawEvents.failed++;
        else if (next === "current") rawEvents.alreadyCurrent++;
        else {
          await tx.$queryRaw`SELECT retention_rekey_raw_event(${organizationId}::uuid, ${r.id}::uuid, ${next}::bytea)`;
          rawEvents.rewritten++;
        }
      }
      after = rows.at(-1)?.id;
      return rows.length < batchSize;
    }, { timeoutMs: 60_000 });
    if (done) break;
  }
  return { bodies, rawEvents };
}
