import { parseFieldKey } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { anonymizeParticipant, eraseMessageContent, messageIdsOfParticipant, purgeRawEventsOfMessages, tombstoneFor } from "@/modules/ingestion";
import { redactEvidenceForMessages } from "@/modules/intelligence";

/**
 * Erase one person's content (a subject-rights request), administrators only. Unlike retention it ignores the age and the state of any
 * item: everything this person wrote is removed. What stays is the lifecycle record: the message rows with their ids, times and
 * directions, the items, the events and the audit log, none of which hold message text. What goes: their message bodies, the raw
 * payloads behind them, the quotes copied into analysis runs, subjects of their messages, and their name and address.
 *
 * Not covered, by design: what OTHER people wrote about them, replies that quote them, and item titles (a title is shown to the people
 * who work the item and may contain a name). A runbook step covers those.
 */
export interface ErasureResult { messages: number; rawEvents: number; evidenceRuns: number }

export async function erasePerson(principal: Principal, input: { participantId: string }, deps: { now?: () => Date; fieldKey?: Buffer } = {}): Promise<ErasureResult | null> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const organizationId = principal.organizationId;
  const now = (deps.now ?? (() => new Date()))();
  const tombstone = tombstoneFor(organizationId, deps.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY));
  return withTenant({ organizationId, userId: principal.userId }, async (tx) => {
    const ids = await messageIdsOfParticipant(tx, input.participantId);
    const rawEvents = await purgeRawEventsOfMessages(tx, organizationId, ids);
    await eraseMessageContent(tx, organizationId, ids, { tombstone, now });
    const evidenceRuns = await redactEvidenceForMessages(tx, organizationId, ids);
    if (!(await anonymizeParticipant(tx, organizationId, input.participantId))) return null;
    await recordAudit(tx, {
      organizationId, actorType: "USER", actorId: principal.userId, action: "participant.erased", entityType: "Participant", entityId: input.participantId,
      metadata: { messages: ids.length, rawEvents, evidenceRuns },
    });
    return { messages: ids.length, rawEvents, evidenceRuns };
  }, { timeoutMs: 60_000 });
}
