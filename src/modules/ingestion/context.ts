import { withTenant } from "@/lib/db";

export interface MessageContext {
  id: string;
  threadId: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
  subject: string | null;
  /** Team the message's monitored source is routed to, if any. */
  teamId: string | null;
}

/** Everything the analysis step needs to know about a message, without its (encrypted) body. */
export async function loadMessageContext(organizationId: string, messageId: string): Promise<MessageContext | null> {
  return withTenant({ organizationId }, async (tx) => {
    const m = await tx.message.findUnique({ where: { id: messageId }, include: { monitoredSource: true } });
    if (!m) return null;
    return { id: m.id, threadId: m.threadId, direction: m.direction, sentAt: m.sentAt, subject: m.subject, teamId: m.monitoredSource.teamId };
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
