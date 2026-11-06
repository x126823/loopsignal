import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { resolveDeps, type SourcesDeps } from "./config";
import { readRefreshToken, withAccessToken } from "./credentials";

export interface ConnectionView {
  id: string;
  status: "ACTIVE" | "PAUSED" | "REVOKED" | "ERROR";
  createdAt: Date;
  scopes: string[];
  watchExpiresAt: Date | null;
  sources: Array<{ id: string; mailbox: string; teamId: string | null; enabled: boolean; lastSyncedAt: Date | null }>;
}

/** Gmail connections of the organization (admins only). Credentials are never part of this view. */
export async function listGmailConnections(principal: Principal): Promise<ConnectionView[]> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const rows = await tx.sourceConnection.findMany({ where: { provider: "GMAIL" }, include: { monitoredSources: true }, orderBy: { createdAt: "desc" } });
    const creds = await tx.connectionCredential.findMany({ where: { connectionId: { in: rows.map((r) => r.id) } }, select: { connectionId: true, watchExpiresAt: true } });
    const watch = new Map(creds.map((c) => [c.connectionId, c.watchExpiresAt]));
    return rows.map((r) => ({
      id: r.id, status: r.status, createdAt: r.createdAt, scopes: r.scopes, watchExpiresAt: watch.get(r.id) ?? null,
      sources: r.monitoredSources.map((s) => ({ id: s.id, mailbox: s.externalId, teamId: s.teamId, enabled: s.enabled, lastSyncedAt: s.lastSyncedAt })),
    }));
  });
}

export type DisconnectOutcome = "DISCONNECTED" | "ALREADY_DISCONNECTED" | "NOT_FOUND";

/**
 * Remove a Gmail connection: stop the watch and revoke the grant at Google (best effort, a failure never blocks this), delete the
 * stored credentials, mark the connection REVOKED, stop syncing its mailboxes, and audit it. Messages already ingested stay,
 * because they are the record. Idempotent.
 */
export async function disconnectGmail(principal: Principal, connectionId: string, deps: SourcesDeps = {}): Promise<DisconnectOutcome> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const organizationId = principal.organizationId;
  const ctx = { organizationId, userId: principal.userId };
  const connection = await withTenant(ctx, (tx) => tx.sourceConnection.findFirst({ where: { id: connectionId, provider: "GMAIL" } }));
  if (!connection) return "NOT_FOUND";
  if (connection.status === "REVOKED") return "ALREADY_DISCONNECTED";

  const { client } = resolveDeps(deps);
  let revoked = false;
  try {
    const refreshToken = await readRefreshToken(organizationId, connectionId, deps);
    if (refreshToken) {
      await withAccessToken(organizationId, connectionId, deps, (token) => client.stopWatch(token)).catch(() => undefined);
      revoked = await client.revoke(refreshToken);
    }
  } catch {
    revoked = false; // unreadable or already-dead credentials: removing our copy is still the right outcome
  }

  await withTenant(ctx, async (tx) => {
    await tx.connectionCredential.deleteMany({ where: { connectionId } });
    await tx.sourceConnection.update({ where: { organizationId_id: { organizationId, id: connectionId } }, data: { status: "REVOKED" } });
    await tx.monitoredSource.updateMany({ where: { connectionId }, data: { enabled: false } });
    await recordAudit(tx, { organizationId, actorType: "USER", actorId: principal.userId, action: "connection.disconnected", entityType: "SourceConnection", entityId: connectionId, metadata: { revokedAtProvider: revoked } });
  });
  return "DISCONNECTED";
}
