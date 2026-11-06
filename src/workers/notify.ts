// Raising notifications from background work. Every function here is best-effort: a failure to notify is logged (ids only) and
// swallowed, because it must never fail an analysis or a scan whose real work already succeeded. Replays are safe: each event
// has a stable dedupe key, so the same event never notifies a person twice.
import { log } from "@/lib/log";
import { loadItemForSla } from "@/modules/lifecycle";
import { createNotifications } from "@/modules/notifications";
import type { TimerRef } from "@/modules/sla";
import { listTeamActors } from "@/modules/tenancy";

async function safely(what: string, ids: Record<string, string>, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    log("warn", "notify.failed", { what, ...ids, errorName: e instanceof Error ? e.name : "unknown" });
  }
}

/** The owner if there is one; otherwise the team's leads; otherwise anyone who may act on the team. */
async function slaRecipients(organizationId: string, item: { teamId: string; ownerUserId: string | null }): Promise<string[]> {
  if (item.ownerUserId) return [item.ownerUserId];
  const leads = await listTeamActors(organizationId, item.teamId, { leadsOnly: true });
  return leads.length > 0 ? leads : listTeamActors(organizationId, item.teamId);
}

export async function notifySlaTimers(result: { warned: readonly TimerRef[]; breached: readonly TimerRef[] }): Promise<void> {
  const one = (kind: "warned" | "breached") => async (t: TimerRef) =>
    safely(`sla_${kind}`, { organizationId: t.organizationId, itemId: t.itemId, timerId: t.timerId }, async () => {
      const item = await loadItemForSla(t.organizationId, t.itemId);
      if (!item) return;
      await createNotifications(t.organizationId, {
        type: kind === "warned" ? "sla_warning" : "sla_breach", recipients: await slaRecipients(t.organizationId, item),
        payload: { itemId: t.itemId, timerId: t.timerId, timerType: t.type, cycle: t.cycle }, dedupeKey: `sla:${t.timerId}:${kind}`,
      });
    });
  for (const t of result.warned) await one("warned")(t);
  for (const t of result.breached) await one("breached")(t);
}

export async function notifyApprovalRequested(req: { organizationId: string; itemId: string; teamId: string; approvalRequestId: string; transition: string }): Promise<void> {
  if (req.transition !== "RESOLUTION_CONFIRMED" && req.transition !== "CLOSED" && req.transition !== "REOPENED") return;
  await safely("approval_requested", { organizationId: req.organizationId, itemId: req.itemId }, async () => {
    await createNotifications(req.organizationId, {
      type: "approval_requested", recipients: await listTeamActors(req.organizationId, req.teamId),
      payload: { itemId: req.itemId, approvalRequestId: req.approvalRequestId, transition: req.transition as "RESOLUTION_CONFIRMED" | "CLOSED" | "REOPENED" },
      dedupeKey: `approval:${req.approvalRequestId}`,
    });
  });
}

export async function notifyCorrelationCandidate(req: { organizationId: string; candidateId: string; targetItemId: string }): Promise<void> {
  await safely("review_correlation", { organizationId: req.organizationId, candidateId: req.candidateId }, async () => {
    const item = await loadItemForSla(req.organizationId, req.targetItemId);
    if (!item) return;
    await createNotifications(req.organizationId, {
      type: "review_correlation", recipients: await listTeamActors(req.organizationId, item.teamId),
      payload: { itemId: req.targetItemId, candidateId: req.candidateId }, dedupeKey: `candidate:${req.candidateId}`,
    });
  });
}

export async function notifyOwnershipNeeded(req: { organizationId: string; itemId: string; teamId: string }): Promise<void> {
  await safely("review_ownership", { organizationId: req.organizationId, itemId: req.itemId }, async () => {
    await createNotifications(req.organizationId, {
      type: "review_ownership", recipients: await listTeamActors(req.organizationId, req.teamId),
      payload: { itemId: req.itemId }, dedupeKey: `ownership:${req.itemId}`,
    });
  });
}
