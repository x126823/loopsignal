import { decryptField, parseFieldKey } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";

export interface MessageContext {
  id: string;
  threadId: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
  subject: string | null;
  /** The monitored source the message arrived through. */
  monitoredSourceId: string;
  /** Team the message's monitored source is routed to, if any. */
  teamId: string | null;
}

/** Everything the analysis step needs to know about a message, without its (encrypted) body. */
export async function loadMessageContext(organizationId: string, messageId: string): Promise<MessageContext | null> {
  return withTenant({ organizationId }, async (tx) => {
    const m = await tx.message.findUnique({ where: { id: messageId }, include: { monitoredSource: true } });
    if (!m) return null;
    return { id: m.id, threadId: m.threadId, direction: m.direction, sentAt: m.sentAt, subject: m.subject, monitoredSourceId: m.monitoredSourceId, teamId: m.monitoredSource.teamId };
  });
}

export interface ThreadMessageRef {
  id: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
}

/** A thread's messages in the order they were sent (oldest first), without their bodies. */
export async function listThreadMessageRefs(organizationId: string, threadId: string): Promise<ThreadMessageRef[]> {
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx.message.findMany({ where: { threadId }, orderBy: [{ sentAt: "asc" }, { id: "asc" }], select: { id: true, direction: true, sentAt: true } });
    return rows;
  });
}

export interface ThreadMessageView {
  id: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
  subject: string | null;
  senderAddress: string | null;
  senderName: string | null;
  /** Decrypted body. The CALLER must already have authorized the principal to view the thread's item. */
  text: string;
}

/**
 * A thread's messages with their text decrypted, oldest first, for display to someone already authorized to view the
 * item. This returns content, so it must only be called after an item-level `item:view` check, and its result must never be
 * logged (rule 10).
 */
export async function loadThreadMessages(organizationId: string, threadId: string, opts: { fieldKey?: Buffer } = {}): Promise<ThreadMessageView[]> {
  const key = opts.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx.message.findMany({ where: { threadId }, orderBy: [{ sentAt: "asc" }, { id: "asc" }] });
    const senders = await tx.participant.findMany({ where: { id: { in: rows.flatMap((r) => (r.senderParticipantId ? [r.senderParticipantId] : [])) } } });
    const byId = new Map(senders.map((s) => [s.id, s]));
    return rows.map((r) => ({
      id: r.id, direction: r.direction, sentAt: r.sentAt, subject: r.subject,
      senderAddress: r.senderParticipantId ? (byId.get(r.senderParticipantId)?.address ?? null) : null,
      senderName: r.senderParticipantId ? (byId.get(r.senderParticipantId)?.displayName ?? null) : null,
      text: decryptField(r.bodyText, key, `${organizationId}:Message.bodyText`),
    }));
  });
}

export interface MessageFeaturesView {
  id: string;
  threadId: string;
  monitoredSourceId: string;
  provider: "GMAIL" | "GOOGLE_CHAT" | "SYNTHETIC";
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
  subject: string | null;
  senderAddress: string | null;
  senderName: string | null;
  /** Decrypted body, for in-memory scoring only. Never log it, store it, or put it in a job payload (rule 10). */
  text: string;
}

/** Messages with their text decrypted, for the correlation scorer. Missing ids are simply absent from the result. */
export async function loadMessageFeatures(organizationId: string, messageIds: string[], opts: { fieldKey?: Buffer } = {}): Promise<MessageFeaturesView[]> {
  if (messageIds.length === 0) return [];
  const key = opts.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  return withTenant({ organizationId }, async (tx) => {
    const rows = await tx.message.findMany({ where: { id: { in: messageIds } } });
    const senders = await tx.participant.findMany({ where: { id: { in: rows.flatMap((r) => (r.senderParticipantId ? [r.senderParticipantId] : [])) } } });
    const byId = new Map(senders.map((s) => [s.id, s]));
    return rows.map((r) => ({
      id: r.id, threadId: r.threadId, monitoredSourceId: r.monitoredSourceId, provider: r.provider, direction: r.direction, sentAt: r.sentAt, subject: r.subject,
      senderAddress: r.senderParticipantId ? (byId.get(r.senderParticipantId)?.address ?? null) : null,
      senderName: r.senderParticipantId ? (byId.get(r.senderParticipantId)?.displayName ?? null) : null,
      text: decryptField(r.bodyText, key, `${organizationId}:Message.bodyText`),
    }));
  });
}
