import type { TenantTx } from "@/lib/db";
import { encryptField } from "@/lib/crypto/fields";
import { canonicalJson, sha256 } from "@/lib/hash";
import { NormalizationError, type ProviderAdapter, type RawProviderEvent } from "@/modules/integrations";

export { canonicalJson, sha256 };

export type IngestResult =
  | { result: "MESSAGE_CREATED"; messageId: string; rawEventCreated: boolean }
  | { result: "MESSAGE_EXISTS"; messageId: string; rawEventCreated: boolean }
  /** Stored raw, but it could not be normalized. A review task records it; retrying cannot help. */
  | { result: "MALFORMED"; rawEventId: string }
  /** The provider re-sent an event id with different content. The original stays; nothing changes. */
  | { result: "PAYLOAD_CONFLICT"; rawEventId: string };

export interface IngestParams {
  organizationId: string;
  monitoredSourceId: string;
  event: RawProviderEvent;
  adapter: ProviderAdapter;
  fieldKey: Buffer;
}

/**
 * Store one provider event and normalize it into a Message, idempotently (CLAUDE.md rule 9 and idempotency rule).
 *
 *  - RawEvent is written once per (org, provider, externalId), encrypted and hashed, and never changed.
 *  - Thread, Participant and Message are found-or-created on their natural unique keys.
 *  - Every insert is `ON CONFLICT DO NOTHING` followed by a read, so concurrent replays of the same event never
 *    abort the transaction and never create a duplicate.
 * Runs inside the caller's tenant transaction. Message content is never logged.
 */
export async function ingestEvent(tx: TenantTx, p: IngestParams): Promise<IngestResult> {
  const { organizationId, event } = p;
  const payloadHash = sha256(canonicalJson(event.payload));
  const rawKey = { organizationId_provider_externalId: { organizationId, provider: event.provider, externalId: event.externalId } };

  let raw = await tx.rawEvent.findUnique({ where: rawKey });
  let rawEventCreated = false;
  if (raw && raw.payloadHash !== payloadHash) return { result: "PAYLOAD_CONFLICT", rawEventId: raw.id };
  if (!raw) {
    const { count } = await tx.rawEvent.createMany({
      data: [{
        organizationId, provider: event.provider, externalId: event.externalId, payloadHash, receivedAt: event.receivedAt,
        payload: encryptField(canonicalJson(event.payload), p.fieldKey, `${organizationId}:RawEvent.payload`),
      }],
      skipDuplicates: true,
    });
    rawEventCreated = count === 1;
    raw = await tx.rawEvent.findUniqueOrThrow({ where: rawKey });
    if (raw.payloadHash !== payloadHash) return { result: "PAYLOAD_CONFLICT", rawEventId: raw.id };
  }

  let normalized;
  try {
    normalized = p.adapter.normalize(event);
  } catch (e) {
    if (!(e instanceof NormalizationError)) throw e;
    const open = await tx.reviewTask.findFirst({ where: { type: "SCHEMA_FAILURE", refType: "RawEvent", refId: raw.id, status: "OPEN" } });
    if (!open) await tx.reviewTask.create({ data: { organizationId, type: "SCHEMA_FAILURE", refType: "RawEvent", refId: raw.id } });
    return { result: "MALFORMED", rawEventId: raw.id };
  }

  const messageKey = { organizationId_provider_externalMessageId: { organizationId, provider: normalized.provider, externalMessageId: normalized.externalMessageId } };
  const existing = await tx.message.findUnique({ where: messageKey });
  if (existing) return { result: "MESSAGE_EXISTS", messageId: existing.id, rawEventCreated };

  await tx.thread.createMany({
    data: [{ organizationId, provider: normalized.provider, externalThreadId: normalized.externalThreadId }],
    skipDuplicates: true,
  });
  const thread = await tx.thread.findUniqueOrThrow({
    where: { organizationId_provider_externalThreadId: { organizationId, provider: normalized.provider, externalThreadId: normalized.externalThreadId } },
  });
  await tx.participant.createMany({
    data: [{ organizationId, address: normalized.sender.address, displayName: normalized.sender.displayName ?? null }],
    skipDuplicates: true,
  });
  const sender = await tx.participant.findUniqueOrThrow({ where: { organizationId_address: { organizationId, address: normalized.sender.address } } });

  // A message from a person who is linked to one of OUR users is our team's, whichever channel it came through (Chat gives no mailbox owner
  // to tell us). Only INBOUND is ever upgraded; INTERNAL and OUTBOUND stay as the adapter said.
  const direction = normalized.direction === "INBOUND" && sender.userId ? "OUTBOUND" : normalized.direction;

  const { count } = await tx.message.createMany({
    data: [{
      organizationId, monitoredSourceId: p.monitoredSourceId, threadId: thread.id, provider: normalized.provider,
      externalMessageId: normalized.externalMessageId, senderParticipantId: sender.id, rawEventId: raw.id, sentAt: normalized.sentAt,
      subject: normalized.subject ?? null, bodyText: encryptField(normalized.bodyText, p.fieldKey, `${organizationId}:Message.bodyText`),
      bodyHash: sha256(normalized.bodyText), direction,
    }],
    skipDuplicates: true,
  });
  const message = await tx.message.findUniqueOrThrow({ where: messageKey });
  return { result: count === 1 ? "MESSAGE_CREATED" : "MESSAGE_EXISTS", messageId: message.id, rawEventCreated };
}
