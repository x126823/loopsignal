import { listAllOrganizationIds, withTenant } from "@/lib/db";
import { log } from "@/lib/log";
import { recordAudit, verifyAuditChain } from "@/modules/audit";

/**
 * Verify every organization's audit hash chain and leave the result in the chain itself (`audit.chain_verified`), so the status
 * screen can show when it was last checked and what it found. A broken chain is logged at error level: it means rows were
 * altered or deleted outside the application (see the runbook). One organization's failure never stops the others.
 */
export interface AuditVerification { organizations: number; intact: number; broken: number; failed: number }

/** `only` limits the check to those organizations (the scheduled job never passes it). */
export async function verifyAllAuditChains(opts: { only?: string[] } = {}): Promise<AuditVerification> {
  const out: AuditVerification = { organizations: 0, intact: 0, broken: 0, failed: 0 };
  for (const organizationId of (await listAllOrganizationIds()).filter((id) => !opts.only || opts.only.includes(id))) {
    out.organizations++;
    try {
      await withTenant({ organizationId }, async (tx) => {
        const status = await verifyAuditChain(tx, organizationId);
        await recordAudit(tx, {
          organizationId, actorType: "SYSTEM", action: "audit.chain_verified", entityType: "Organization", entityId: organizationId,
          metadata: status.intact ? { intact: true } : { intact: false, firstBadSeq: status.firstBadSeq ?? 0 },
        });
        if (status.intact) out.intact++;
        else {
          out.broken++;
          log("error", "audit.chain_broken", { organizationId, firstBadSeq: status.firstBadSeq ?? 0 });
        }
      }, { timeoutMs: 120_000 });
    } catch (e) {
      out.failed++;
      log("error", "audit.verify_failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return out;
}
