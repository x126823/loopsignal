import type { TenantTx } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto/fields";

/**
 * Removing stored content, for retention and for erasure. Ingestion owns Message and RawEvent, so the data-level work lives here; the
 * `retention` module decides what is due and orchestrates (and audits) it.
 *
 *  - A message keeps its row, ids and metadata (it is part of the lifecycle record); its body becomes an encrypted tombstone, its hash
 *    is cleared (a hash of removed text could still confirm a guess) and `contentPurgedAt` records when.
 *  - A raw payload is deleted outright, through the maintenance functions that are the only way past the append-only guard.
 */
export const TOMBSTONE = "[removed by retention]";

export const tombstoneFor = (organizationId: string, fieldKey: Buffer): Uint8Array<ArrayBuffer> => encryptField(TOMBSTONE, fieldKey, `${organizationId}:Message.bodyText`);

/** Ids of messages whose content is due for removal by age (never while an item they belong to is open). Oldest first. */
export async function listExpiredMessageIds(tx: TenantTx, organizationId: string, cutoff: Date, limit: number): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT retention_expired_message_ids(${organizationId}::uuid, ${cutoff}::timestamptz, ${limit}::int) AS id`;
  return rows.map((r) => r.id);
}

/** Replace the bodies of these messages with the tombstone. Already-purged messages are left alone. Returns the ids actually changed. */
export async function purgeMessageContent(tx: TenantTx, organizationId: string, messageIds: string[], opts: { tombstone: Uint8Array<ArrayBuffer>; now: Date; subject?: string }): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const todo = await tx.message.findMany({ where: { id: { in: messageIds }, contentPurgedAt: null }, select: { id: true } });
  if (todo.length === 0) return [];
  await tx.message.updateMany({
    where: { id: { in: todo.map((m) => m.id) } },
    data: { bodyText: opts.tombstone, bodyHash: "", contentPurgedAt: opts.now, ...(opts.subject !== undefined ? { subject: opts.subject } : {}) },
  });
  return todo.map((m) => m.id);
}

/** Delete raw payloads older than `cutoff` (never those behind a message in an open item). Returns how many were deleted. */
export async function purgeExpiredRawEvents(tx: TenantTx, organizationId: string, cutoff: Date, limit: number): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`SELECT retention_purge_raw_events(${organizationId}::uuid, ${cutoff}::timestamptz, ${limit}::int) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** Delete the raw payloads behind specific messages, whatever their age (an erasure). */
export async function purgeRawEventsOfMessages(tx: TenantTx, organizationId: string, messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  const rows = await tx.$queryRaw<Array<{ n: number }>>`SELECT retention_purge_raw_events_for_messages(${organizationId}::uuid, ${messageIds}::uuid[]) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** Ids of every message this person wrote, in any channel. */
export async function messageIdsOfParticipant(tx: TenantTx, participantId: string): Promise<string[]> {
  return (await tx.message.findMany({ where: { senderParticipantId: participantId }, select: { id: true } })).map((m) => m.id);
}

/** Erase what identifies a person in the participant record. Returns false when there is no such participant. */
export async function anonymizeParticipant(tx: TenantTx, organizationId: string, participantId: string): Promise<boolean> {
  const p = await tx.participant.findFirst({ where: { id: participantId } });
  if (!p) return false;
  await tx.participant.update({ where: { organizationId_id: { organizationId, id: p.id } }, data: { address: `erased:${p.id}`, displayName: null, userId: null } });
  return true;
}

/** Remove a person's content from specific messages (an erasure): bodies become tombstones and the subject is blanked, even if the body was already purged. */
export async function eraseMessageContent(tx: TenantTx, organizationId: string, messageIds: string[], opts: { tombstone: Uint8Array<ArrayBuffer>; now: Date }): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const purged = await purgeMessageContent(tx, organizationId, messageIds, { ...opts, subject: "[erased]" });
  await tx.message.updateMany({ where: { id: { in: messageIds } }, data: { subject: "[erased]" } });
  return purged;
}

export interface ExportedMessage {
  id: string;
  provider: string;
  direction: string;
  sentAt: string;
  subject: string | null;
  /** The message text, or the tombstone text if retention or an erasure already removed it. */
  body: string;
  threadId: string;
  contentRemovedAt: string | null;
}
export interface ExportedParticipant { id: string; address: string; displayName: string | null; linkedUserId: string | null; recordedAt: string }

/**
 * Everything held about one person in message data (a subject-access request): their participant record and every message they wrote,
 * decrypted. Sensitive by nature: the caller authorizes, audits, and decides where the result goes. Oldest first, at most `limit` messages
 * (`truncated` says whether there were more).
 */
export async function exportParticipantData(tx: TenantTx, organizationId: string, participantId: string, fieldKey: Buffer, limit = 5_000): Promise<{ participant: ExportedParticipant; messages: ExportedMessage[]; truncated: boolean } | null> {
  const p = await tx.participant.findFirst({ where: { id: participantId } });
  if (!p) return null;
  const rows = await tx.message.findMany({ where: { senderParticipantId: p.id }, orderBy: [{ sentAt: "asc" }, { id: "asc" }], take: limit + 1 });
  return {
    participant: { id: p.id, address: p.address, displayName: p.displayName, linkedUserId: p.userId, recordedAt: p.createdAt.toISOString() },
    messages: rows.slice(0, limit).map((m) => ({
      id: m.id, provider: m.provider, direction: m.direction, sentAt: m.sentAt.toISOString(), subject: m.subject, threadId: m.threadId,
      body: decryptField(m.bodyText, fieldKey, `${organizationId}:Message.bodyText`), contentRemovedAt: m.contentPurgedAt?.toISOString() ?? null,
    })),
    truncated: rows.length > limit,
  };
}
