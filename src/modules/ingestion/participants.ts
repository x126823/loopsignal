import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";

/**
 * Who is on our team, for channels that cannot say. Gmail knows which messages the mailbox owner sent; a Chat space gives only an opaque
 * person id, so an organization admin links those ids to LoopSignal users. Messages from a linked person are recorded as OUR team's
 * (see ingestEvent), which is what lets a reply in Chat count as an acknowledgment or a response. It applies to messages ingested
 * after the link: history is never rewritten.
 */
export interface ChatPerson { id: string; displayName: string | null; userId: string | null }

/** People who have written in Chat spaces, with who (if anyone) they are linked to. Admins only. */
export async function listChatPeople(principal: Principal): Promise<ChatPerson[]> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const seen = await tx.message.findMany({ where: { provider: "GOOGLE_CHAT" }, distinct: ["senderParticipantId"], select: { senderParticipantId: true }, take: 200 });
    const ids = seen.map((m) => m.senderParticipantId).filter((id): id is string => id !== null);
    const people = await tx.participant.findMany({ where: { id: { in: ids } }, orderBy: { displayName: "asc" } });
    return people.map((p) => ({ id: p.id, displayName: p.displayName, userId: p.userId }));
  });
}

export type LinkOutcome = "LINKED" | "UNLINKED" | "UNCHANGED" | "NOT_FOUND" | "NOT_A_MEMBER";

/** Link a Chat person to a member of the organization, or unlink them (`userId: null`). */
export async function linkChatPerson(principal: Principal, input: { participantId: string; userId: string | null }): Promise<LinkOutcome> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const organizationId = principal.organizationId;
  return withTenant({ organizationId, userId: principal.userId }, async (tx): Promise<LinkOutcome> => {
    const person = await tx.participant.findFirst({ where: { id: input.participantId, address: { startsWith: "users/" } } });
    const isChat = person && (await tx.message.findFirst({ where: { provider: "GOOGLE_CHAT", senderParticipantId: person.id }, select: { id: true } }));
    if (!person || !isChat) return "NOT_FOUND";
    if (input.userId !== null && !(await tx.membership.findFirst({ where: { userId: input.userId } }))) return "NOT_A_MEMBER";
    if (person.userId === input.userId) return "UNCHANGED";
    await tx.participant.update({ where: { organizationId_id: { organizationId, id: person.id } }, data: { userId: input.userId } });
    await recordAudit(tx, {
      organizationId, actorType: "USER", actorId: principal.userId, action: input.userId ? "participant.linked" : "participant.unlinked", entityType: "Participant", entityId: person.id,
      metadata: input.userId ? { linkedUserId: input.userId } : {},
    });
    return input.userId ? "LINKED" : "UNLINKED";
  });
}
