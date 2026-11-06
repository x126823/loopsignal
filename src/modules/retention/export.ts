import { parseFieldKey } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { exportParticipantData, type ExportedMessage, type ExportedParticipant } from "@/modules/ingestion";
import { listItemsStartedFromMessages } from "@/modules/lifecycle";

/**
 * Subject access: everything held about one person, for an administrator to hand to them (the counterpart of erasure). It contains
 * message text, so it is returned to the caller and never logged; the audit row records that an export happened and how much, not what.
 * What is included: their participant record, every message they wrote (decrypted, or the removal marker if retention or an erasure
 * already took the text), and the items those messages started. Not included, by design: what OTHER people wrote about them or to them,
 * and the audit log (ids and metadata about actions, not about them).
 */
export interface PersonExport {
  exportedAt: string;
  organizationId: string;
  participant: ExportedParticipant;
  messages: ExportedMessage[];
  itemsStarted: Array<{ id: string; title: string; state: string; createdAt: string }>;
  truncated: boolean;
  notIncluded: string[];
}

export async function exportPerson(principal: Principal, input: { participantId: string }, deps: { now?: () => Date; fieldKey?: Buffer; limit?: number } = {}): Promise<PersonExport | null> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const organizationId = principal.organizationId;
  const key = deps.fieldKey ?? parseFieldKey(getEnv().FIELD_ENCRYPTION_KEY);
  const data = await withTenant({ organizationId, userId: principal.userId }, (tx) => exportParticipantData(tx, organizationId, input.participantId, key, deps.limit), { timeoutMs: 60_000 });
  if (!data) return null;
  const items = await listItemsStartedFromMessages(organizationId, data.messages.map((m) => m.id));
  await withTenant({ organizationId, userId: principal.userId }, (tx) => recordAudit(tx, {
    organizationId, actorType: "USER", actorId: principal.userId, action: "participant.exported", entityType: "Participant", entityId: data.participant.id,
    metadata: { messages: data.messages.length, items: items.length, truncated: data.truncated },
  }));
  return {
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(), organizationId, participant: data.participant, messages: data.messages,
    itemsStarted: items.map((i) => ({ id: i.id, title: i.title, state: i.state, createdAt: i.createdAt.toISOString() })), truncated: data.truncated,
    notIncluded: ["messages other people wrote to or about this person", "replies that quote them", "the audit log (ids and metadata about actions)", "backups taken earlier"],
  };
}
