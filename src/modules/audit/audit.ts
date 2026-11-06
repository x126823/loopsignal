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

export interface AuditHead { seq: bigint; hash: string }

/** The newest audit row of the organization in the transaction's context, or null if there is none. */
export async function auditHead(tx: TenantTx): Promise<AuditHead | null> {
  const row = await tx.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  return row ? { seq: row.seq, hash: row.hash } : null;
}

/** The hash of the audit row with this sequence number, or null if there is no such row. */
export async function auditHashAt(tx: TenantTx, seq: bigint): Promise<string | null> {
  return (await tx.auditLog.findFirst({ where: { seq }, select: { hash: true } }))?.hash ?? null;
}

export interface AuditSummary { at: Date; metadata: Record<string, unknown> }

/** The most recent audit entry with this action, for status screens. Read-only. The transaction must carry the organization. */
export async function latestAuditEntry(tx: TenantTx, action: string): Promise<AuditSummary | null> {
  const row = await tx.auditLog.findFirst({ where: { action }, orderBy: { seq: "desc" }, select: { createdAt: true, metadata: true } });
  return row ? { at: row.createdAt, metadata: (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<string, unknown> } : null;
}
