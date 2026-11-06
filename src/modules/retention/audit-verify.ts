import { raiseAlert } from "@/lib/alerts";
import { listAllOrganizationIds, withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { recordAudit, verifyAuditChain } from "@/modules/audit";
import { appendAnchors, currentAnchors, readAnchorFile, verifyAnchors } from "./anchors";

/**
 * Verify every organization's audit hash chain and leave the result in the chain itself (`audit.chain_verified`), so the status
 * screen can show when it was last checked and what it found. A broken chain is logged at error level and raised as an alert: it means
 * rows were altered or deleted outside the application (see the runbook). One organization's failure never stops the others.
 *
 * With AUDIT_ANCHOR_KEY set it also takes a signed anchor of each healthy chain's head (logged, and appended to AUDIT_ANCHOR_FILE if
 * that is set) and, when the file exists, checks the chain against every earlier anchor in it. That is what reveals deleted NEWEST rows,
 * which the chain alone cannot. A chain that fails either check is never anchored.
 */
export interface AuditVerification { organizations: number; intact: number; broken: number; failed: number; anchorMismatches: number }

export async function verifyAllAuditChains(opts: { only?: string[] } = {}): Promise<AuditVerification> {
  const out: AuditVerification = { organizations: 0, intact: 0, broken: 0, failed: 0, anchorMismatches: 0 };
  const env = getEnv();
  const key = env.AUDIT_ANCHOR_KEY;
  const file = env.AUDIT_ANCHOR_FILE;
  const saved = key && file ? readAnchorFile(file) : null;
  if (saved && saved.malformed > 0) log("error", "audit.anchor_file_malformed", { lines: saved.malformed });

  for (const organizationId of (await listAllOrganizationIds()).filter((id) => !opts.only || opts.only.includes(id))) {
    out.organizations++;
    try {
      let anchorFailures = 0;
      if (key && saved) {
        const check = await verifyAnchors(key, saved.anchors.filter((a) => a.organizationId === organizationId));
        anchorFailures = check.failures.length;
        if (check.invalid > 0) log("error", "audit.anchor_invalid", { organizationId, anchors: check.invalid });
      }
      let chainBroken = false;
      await withTenant({ organizationId }, async (tx) => {
        const status = await verifyAuditChain(tx, organizationId);
        const intact = status.intact && anchorFailures === 0;
        chainBroken = !status.intact;
        await recordAudit(tx, {
          organizationId, actorType: "SYSTEM", action: "audit.chain_verified", entityType: "Organization", entityId: organizationId,
          metadata: intact ? { intact: true } : { intact: false, ...(status.intact ? {} : { firstBadSeq: status.firstBadSeq ?? 0 }), ...(anchorFailures ? { anchorMismatches: anchorFailures } : {}) },
        });
        if (!status.intact) {
          out.broken++;
          log("error", "audit.chain_broken", { organizationId, firstBadSeq: status.firstBadSeq ?? 0 });
          void raiseAlert("audit.chain_broken", { organizationId, firstBadSeq: status.firstBadSeq ?? 0 });
        }
        if (anchorFailures > 0) {
          out.anchorMismatches++;
          log("error", "audit.anchor_mismatch", { organizationId, anchors: anchorFailures });
          void raiseAlert("audit.anchor_mismatch", { organizationId, anchors: anchorFailures });
        }
        if (intact) out.intact++;
      }, { timeoutMs: 120_000 });

      // Anchor only a chain that passed both checks.
      if (key && !chainBroken && anchorFailures === 0) {
        const anchors = await currentAnchors(key, { only: [organizationId] });
        for (const a of anchors) log("info", "audit.anchor", { organizationId: a.organizationId, seq: a.seq, hash: a.hash, at: a.at, mac: a.mac });
        if (file) {
          try { appendAnchors(file, anchors); } catch { log("error", "audit.anchor_not_stored", { organizationId }); }
        }
      }
    } catch (e) {
      out.failed++;
      log("error", "audit.verify_failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
      void raiseAlert("audit.verify_failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return out;
}
