import type { TenantTx } from "@/lib/db";

export type AuditActorType = "USER" | "SYSTEM" | "ANALYZER";

export interface AuditEntry {
  organizationId: string;
  actorType: AuditActorType;
  actorId?: string;
  /** Dotted verb, e.g. "membership.role_changed". */
  action: string;
  entityType: string;
  entityId?: string;
  /** Ids and non-sensitive attributes only. Message content, tokens and secrets are rejected (rule 10). */
  metadata?: Record<string, unknown>;
}

const FORBIDDEN_KEY = /body|content|subject|token|secret|password|authorization|credential|cookie|apikey|api_key/i;
const MAX_METADATA_BYTES = 8_192;

/** Throws if metadata could carry message content or secrets. Keys are checked recursively. */
export function assertSafeMetadata(value: unknown, path = "metadata"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeMetadata(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`Audit metadata key not allowed: ${path}.${key}`);
      assertSafeMetadata(v, `${path}.${key}`);
    }
  }
}

/**
 * Append an audit row inside the caller's transaction, so the audit entry commits or rolls back together
 * with the change it records (rule 3). The database assigns seq, prevHash and hash.
 */
export async function recordAudit(tx: TenantTx, entry: AuditEntry): Promise<void> {
  const metadata = entry.metadata ?? {};
  assertSafeMetadata(metadata);
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) throw new Error("Audit metadata too large");
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: metadata as object,
    },
  });
}

export interface ChainStatus {
  intact: boolean;
  /** First sequence number that fails verification. */
  firstBadSeq?: number;
}

/** Verify the organization's hash chain. The transaction must carry organizationId in its tenant context. */
export async function verifyAuditChain(tx: TenantTx, organizationId: string): Promise<ChainStatus> {
  const rows = await tx.$queryRaw<Array<{ bad: bigint | null }>>`SELECT audit_verify_chain(${organizationId}::uuid) AS bad`;
  const bad = rows[0]?.bad ?? null;
  return bad === null ? { intact: true } : { intact: false, firstBadSeq: Number(bad) };
}
