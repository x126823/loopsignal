import { z } from "zod";
import { decryptField, encryptField } from "@/lib/crypto/fields";
import { withTenant, type TenantTx } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { ProviderAuthError } from "@/modules/integrations";
import { resolveDeps, type SourcesDeps } from "./config";

/**
 * OAuth token storage. Tokens are encrypted with AES-256-GCM, with the organization and connection bound in as AAD, so a blob
 * copied to another row or tenant fails to decrypt. They never appear in logs, audit rows, job payloads or error messages.
 * Only this module reads or writes ConnectionCredential.
 */
const tokensSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) }).strict();
type Tokens = z.infer<typeof tokensSchema>;

const aad = (organizationId: string, connectionId: string) => `${organizationId}:ConnectionCredential.tokens:${connectionId}`;
/** Refresh this long before the access token actually expires, so a call never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 120_000;

export async function saveCredentials(tx: TenantTx, p: { organizationId: string; connectionId: string; tokens: Tokens; accessTokenExpiresAt: Date; fieldKey: Buffer }): Promise<void> {
  const tokens = encryptField(JSON.stringify(p.tokens), p.fieldKey, aad(p.organizationId, p.connectionId));
  await tx.connectionCredential.upsert({
    where: { organizationId_connectionId: { organizationId: p.organizationId, connectionId: p.connectionId } },
    create: { organizationId: p.organizationId, connectionId: p.connectionId, tokens, accessTokenExpiresAt: p.accessTokenExpiresAt },
    update: { tokens, accessTokenExpiresAt: p.accessTokenExpiresAt },
  });
}

/** A usable access token for the connection, refreshing it first when it is missing or about to expire. */
export async function getAccessToken(organizationId: string, connectionId: string, deps: SourcesDeps = {}, opts: { force?: boolean } = {}): Promise<string> {
  const { client, now, fieldKey } = resolveDeps(deps);
  const row = await withTenant({ organizationId }, (tx) =>
    tx.connectionCredential.findUnique({ where: { organizationId_connectionId: { organizationId, connectionId } } }));
  if (!row) throw new ProviderAuthError("invalid_grant"); // disconnected: there is nothing to authenticate with

  const tokens = tokensSchema.parse(JSON.parse(decryptField(row.tokens, fieldKey, aad(organizationId, connectionId))));
  if (!opts.force && row.accessTokenExpiresAt.getTime() - now().getTime() > REFRESH_MARGIN_MS) return tokens.accessToken;

  const grant = await client.refresh(tokens.refreshToken); // outside any transaction; may throw ProviderAuthError
  await withTenant({ organizationId }, (tx) => saveCredentials(tx, {
    organizationId, connectionId, fieldKey,
    tokens: { accessToken: grant.accessToken, refreshToken: grant.refreshToken ?? tokens.refreshToken }, // Google may rotate the refresh token
    accessTokenExpiresAt: new Date(now().getTime() + grant.expiresInSec * 1000),
  }));
  return grant.accessToken;
}

/** Run a call with a valid access token; if Google says the token was rejected (revoked or expired early), refresh once and retry. */
export async function withAccessToken<T>(organizationId: string, connectionId: string, deps: SourcesDeps, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await getAccessToken(organizationId, connectionId, deps));
  } catch (e) {
    if (e instanceof ProviderAuthError && e.code === "unauthorized") return call(await getAccessToken(organizationId, connectionId, deps, { force: true }));
    throw e;
  }
}

/** The refresh token, for revoking it when a connection is removed. Null when there are no credentials. */
export async function readRefreshToken(organizationId: string, connectionId: string, deps: SourcesDeps = {}): Promise<string | null> {
  const { fieldKey } = resolveDeps(deps);
  const row = await withTenant({ organizationId }, (tx) =>
    tx.connectionCredential.findUnique({ where: { organizationId_connectionId: { organizationId, connectionId } } }));
  return row ? tokensSchema.parse(JSON.parse(decryptField(row.tokens, fieldKey, aad(organizationId, connectionId)))).refreshToken : null;
}

/** Thrown to the ingestion job once the connection has been marked as needing attention. Not retried: a person must reconnect. */
export class ConnectionAuthFailedError extends Error {
  constructor() {
    super("The connection's credentials were rejected");
    this.name = "ConnectionAuthFailedError";
  }
}

/** Google refused the credentials for good: stop syncing this connection, and leave an audit trail. Idempotent. */
export async function markConnectionAuthFailed(organizationId: string, connectionId: string, reason: string): Promise<void> {
  await withTenant({ organizationId }, async (tx) => {
    const { count } = await tx.sourceConnection.updateMany({ where: { id: connectionId, status: "ACTIVE" }, data: { status: "ERROR" } });
    if (count === 1) {
      await recordAudit(tx, { organizationId, actorType: "SYSTEM", action: "connection.auth_failed", entityType: "SourceConnection", entityId: connectionId, metadata: { reason } });
    }
  });
}

/**
 * Key rotation: re-encrypt this organization's stored tokens from `from` to `to`. Idempotent (a blob that already opens with the new key
 * is left alone); a blob that opens with neither is counted as failed and left untouched.
 */
export async function rekeyCredentials(organizationId: string, from: Buffer, to: Buffer): Promise<{ rewritten: number; alreadyCurrent: number; failed: number }> {
  const out = { rewritten: 0, alreadyCurrent: 0, failed: 0 };
  await withTenant({ organizationId }, async (tx) => {
    for (const row of await tx.connectionCredential.findMany()) {
      const context = aad(organizationId, row.connectionId);
      try {
        const plain = decryptField(row.tokens, from, context);
        await tx.connectionCredential.update({ where: { id: row.id }, data: { tokens: encryptField(plain, to, context) } });
        out.rewritten++;
      } catch {
        try {
          decryptField(row.tokens, to, context);
          out.alreadyCurrent++;
        } catch {
          out.failed++;
        }
      }
    }
  });
  return out;
}
