// Scheduled maintenance: retention (remove content that is due) and audit-chain verification. Both run once a day for every
// organization, are idempotent, and isolate failures per organization. MAINTENANCE_JOBS_ENABLED=false stops the schedules (the incident
// switch); it never changes what a job does when it runs.
import { listAllOrganizationIds } from "@/lib/db";
import { log } from "@/lib/log";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { runRetention, verifyAllAuditChains, type AuditVerification, type RetentionDeps } from "@/modules/retention";

export const MAINTENANCE_EVERY_MS = 24 * 3_600_000;

export async function registerMaintenanceSchedules(hub: QueueHub, everyMs: number = MAINTENANCE_EVERY_MS): Promise<void> {
  await hub.schedule(QUEUES.retention, "retention-schedule", everyMs, {});
  await hub.schedule(QUEUES.auditVerify, "audit-verify-schedule", everyMs, {});
}

export interface RetentionScan { organizations: number; rawEvents: number; messages: number; failures: number }

/** `only` limits the pass to those organizations (the scheduled job never passes it: it visits every organization). */
export async function handleRetention(deps: RetentionDeps & { only?: string[] } = {}): Promise<RetentionScan> {
  const out: RetentionScan = { organizations: 0, rawEvents: 0, messages: 0, failures: 0 };
  for (const organizationId of (await listAllOrganizationIds()).filter((id) => !deps.only || deps.only.includes(id))) {
    out.organizations++;
    try {
      const r = await runRetention(organizationId, deps);
      out.rawEvents += r.rawEvents;
      out.messages += r.messages;
    } catch (e) {
      out.failures++; // one organization's trouble must not stop the others
      log("error", "retention.failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return out;
}

export const handleAuditVerify = (): Promise<AuditVerification> => verifyAllAuditChains();
