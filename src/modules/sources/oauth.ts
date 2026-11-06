import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { GMAIL_READONLY_SCOPE } from "@/modules/integrations";
import { gmailEnabled, GmailDisabledError, redirectUri, resolveDeps, type SourcesDeps } from "./config";
import { saveCredentials } from "./credentials";

/**
 * The OAuth consent flow (authorization code + PKCE).
 *
 *  - Only an organization admin can connect a mailbox.
 *  - `state` is signed (HMAC with AUTH_SECRET), expires after 10 minutes, and names the admin and organization who started
 *    it, so a callback opened by someone else, in another organization, or replayed later is refused.
 *  - A random nonce in `state` must match an HttpOnly cookie set at the start, so the callback only completes in the browser
 *    that began it (login-CSRF protection). The PKCE verifier travels in that same cookie, never in a URL.
 *  - The only scope requested is gmail.readonly, and a grant without it is refused.
 */
export const OAUTH_COOKIE = "loopsignal_gmail_oauth";
const STATE_TTL_MS = 10 * 60_000;

export type OAuthFailure = "state_invalid" | "state_expired" | "wrong_user" | "denied" | "no_refresh_token" | "scope_missing" | "team_not_found";
export class OAuthError extends Error {
  constructor(readonly code: OAuthFailure) {
    super(`Gmail connection failed: ${code}`);
    this.name = "OAuthError";
  }
}

const statePayload = z.object({ o: z.string().uuid(), u: z.string().uuid(), t: z.string().uuid(), n: z.string().min(16), x: z.number() }).strict();

const sign = (payload: string): string => createHmac("sha256", getEnv().AUTH_SECRET).update(`gmail-oauth:${payload}`).digest("base64url");
const sha256Base64Url = (v: string): string => createHash("sha256").update(v).digest("base64url");

export function makeState(p: { organizationId: string; userId: string; teamId: string; nonce: string }, nowMs: number): string {
  const payload = Buffer.from(JSON.stringify({ o: p.organizationId, u: p.userId, t: p.teamId, n: p.nonce, x: nowMs + STATE_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readState(state: string, nowMs: number): z.infer<typeof statePayload> {
  const [payload, mac, extra] = state.split(".");
  if (!payload || !mac || extra !== undefined) throw new OAuthError("state_invalid");
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new OAuthError("state_invalid");
  let parsed;
  try { parsed = statePayload.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { throw new OAuthError("state_invalid"); }
  if (!parsed.success) throw new OAuthError("state_invalid");
  if (parsed.data.x < nowMs) throw new OAuthError("state_expired");
  return parsed.data;
}

export async function beginGmailConnect(principal: Principal, input: { teamId: string }, deps: SourcesDeps = {}): Promise<{ url: string; cookieValue: string; maxAgeSec: number }> {
  if (!gmailEnabled()) throw new GmailDisabledError();
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const { client, now } = resolveDeps(deps);
  const team = await withTenant({ organizationId: principal.organizationId, userId: principal.userId }, (tx) => tx.team.findFirst({ where: { id: input.teamId } }));
  if (!team) throw new OAuthError("team_not_found");

  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const state = makeState({ organizationId: principal.organizationId, userId: principal.userId, teamId: team.id, nonce }, now().getTime());
  return {
    url: client.buildAuthUrl({ redirectUri: redirectUri(), state, codeChallenge: sha256Base64Url(verifier) }),
    cookieValue: `${nonce}.${verifier}`,
    maxAgeSec: STATE_TTL_MS / 1000,
  };
}

export interface ConnectedMailbox { connectionId: string; monitoredSourceId: string; reconnected: boolean }

export async function completeGmailConnect(
  principal: Principal,
  input: { code: string | null; state: string | null; providerError: string | null; cookieValue: string | null },
  deps: SourcesDeps = {},
): Promise<ConnectedMailbox> {
  if (!gmailEnabled()) throw new GmailDisabledError();
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const { client, now, fieldKey } = resolveDeps(deps);

  if (!input.state) throw new OAuthError("state_invalid");
  const state = readState(input.state, now().getTime());
  if (state.u !== principal.userId || state.o !== principal.organizationId) throw new OAuthError("wrong_user");
  const [nonce, verifier] = (input.cookieValue ?? "").split(".");
  if (!nonce || !verifier || nonce.length !== state.n.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(state.n))) throw new OAuthError("state_invalid");
  if (input.providerError || !input.code) throw new OAuthError("denied");

  const grant = await client.exchangeCode({ code: input.code, redirectUri: redirectUri(), codeVerifier: verifier });
  if (!grant.refreshToken) throw new OAuthError("no_refresh_token"); // without one the connection would die within the hour
  if (!grant.scopes.includes(GMAIL_READONLY_SCOPE)) throw new OAuthError("scope_missing");
  const profile = await client.getProfile(grant.accessToken);
  const mailbox = profile.emailAddress.toLowerCase();
  const tokens = { accessToken: grant.accessToken, refreshToken: grant.refreshToken };
  const expiresAt = new Date(now().getTime() + grant.expiresInSec * 1000);

  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    const organizationId = principal.organizationId;
    const team = await tx.team.findFirst({ where: { id: state.t } });
    if (!team) throw new OAuthError("team_not_found");
    const existing = await tx.monitoredSource.findFirst({ where: { kind: "MAILBOX", externalId: mailbox, connection: { provider: "GMAIL" } }, include: { connection: true } });
    let connectionId: string;
    let monitoredSourceId: string;
    if (existing) {
      // Reconnecting a mailbox (after an error or a disconnect) keeps its source and sync position, so nothing is read twice.
      connectionId = existing.connectionId;
      monitoredSourceId = existing.id;
      await tx.sourceConnection.update({ where: { organizationId_id: { organizationId, id: connectionId } }, data: { status: "ACTIVE", scopes: grant.scopes, ownerUserId: principal.userId } });
      await tx.monitoredSource.update({ where: { organizationId_id: { organizationId, id: monitoredSourceId } }, data: { enabled: true, teamId: team.id } });
    } else {
      const connection = await tx.sourceConnection.create({ data: { organizationId, provider: "GMAIL", ownerUserId: principal.userId, scopes: grant.scopes, status: "ACTIVE" } });
      const source = await tx.monitoredSource.create({ data: { organizationId, connectionId: connection.id, kind: "MAILBOX", externalId: mailbox, teamId: team.id } });
      connectionId = connection.id;
      monitoredSourceId = source.id;
    }
    await saveCredentials(tx, { organizationId, connectionId, tokens, accessTokenExpiresAt: expiresAt, fieldKey });
    await recordAudit(tx, {
      organizationId, actorType: "USER", actorId: principal.userId, action: "connection.gmail_connected", entityType: "SourceConnection", entityId: connectionId,
      metadata: { monitoredSourceId, teamId: team.id, reconnected: Boolean(existing), scopes: grant.scopes },
    });
    return { connectionId, monitoredSourceId, reconnected: Boolean(existing) };
  });
}
