import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { latestAuditEntry } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { getRetention, type Retention } from "./settings";

export interface RetentionStatus {
  settings: Retention;
  lastPurge: { at: Date; rawEvents: number; messages: number } | null;
  lastVerification: { at: Date; intact: boolean } | null;
  /** Whether signed audit anchors are being taken. Without them, deleted newest audit rows would not be detected. */
  anchorsConfigured: boolean;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** What an administrator needs to see: the windows, the last purge, and the last audit-chain check. */
export async function getRetentionStatus(principal: Principal): Promise<RetentionStatus> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const settings = await getRetention(principal.organizationId);
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const purge = await latestAuditEntry(tx, "retention.purged");
    const check = await latestAuditEntry(tx, "audit.chain_verified");
    return {
      anchorsConfigured: getEnv().AUDIT_ANCHOR_KEY !== undefined,
      settings,
      lastPurge: purge ? { at: purge.at, rawEvents: num(purge.metadata["rawEvents"]), messages: num(purge.metadata["messages"]) } : null,
      lastVerification: check ? { at: check.at, intact: check.metadata["intact"] === true } : null,
    };
  });
}
