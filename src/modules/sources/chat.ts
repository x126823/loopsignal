import { randomBytes } from "node:crypto";
import { decryptField, encryptField } from "@/lib/crypto/fields";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import {
  CHAT_APP_MESSAGES_READONLY_SCOPE, createChatAdapter, createChatClient, createServiceAccountTokens, googleEndpoints, parseServiceAccountKey, ProviderAuthError, ProviderSourceUnavailableError, SPACE_NAME,
  UnsupportedProviderError, type AdapterContext, type ChatClient, type ChatTokens, type FetchPage, type ProviderAdapter, type RawProviderEvent, type ServiceAccountTokens, type SourceRef,
} from "@/modules/integrations";
import { resolveDeps, type SourcesDeps } from "./config";

/**
 * Google Chat connections (decision record: docs/GOOGLE_CHAT.md).
 *
 * One product-wide Chat app (a service account) is added to spaces by customers and reads them as itself. Because one app serves every
 * customer, being able to read a space proves nothing about WHICH organization it belongs to. So a space is bound to an organization
 * only after a PROOF: an admin requests a claim, someone posts the one-time code in that space, and reading the space finds it. A space
 * is bound to at most one organization at a time (checked under a lock, so two organizations cannot bind it simultaneously).
 */
export const chatEnabled = (): boolean => getEnv().GOOGLE_CHAT_ENABLED === "true";

export class ChatDisabledError extends Error {
  constructor() {
    super("The Google Chat integration is not enabled");
    this.name = "ChatDisabledError";
  }
}

export type ClaimFailure = "invalid_space" | "team_not_found" | "already_bound";
export class ChatClaimError extends Error {
  constructor(readonly code: ClaimFailure) {
    super(`Chat space request refused: ${code}`);
    this.name = "ChatClaimError";
  }
}

// ---- the app's own credentials --------------------------------------------------------------------------------------------------------

interface ChatResolved { client: ChatClient; tokens: ChatTokens; now: () => Date }
let sharedTokens: { id: string; tokens: ServiceAccountTokens } | undefined;

function appTokens(): ChatTokens {
  const env = getEnv();
  const json = env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON;
  const tokenUrl = googleEndpoints(env.GOOGLE_TEST_BASE_URL).token;
  const id = `${tokenUrl}|${json?.length ?? 0}|${json?.slice(-40) ?? ""}`;
  if (sharedTokens?.id !== id) {
    let key;
    try {
      key = parseServiceAccountKey(json ?? "");
    } catch {
      throw new ProviderAuthError("invalid_grant"); // a missing or malformed key file is a credential failure (its message is never shown)
    }
    sharedTokens = { id, tokens: createServiceAccountTokens({ key, tokenUrl, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE] }) };
  }
  return sharedTokens.tokens;
}

export interface ChatDeps extends SourcesDeps {
  chat?: ChatClient;
  chatTokens?: ChatTokens;
}

function resolveChat(deps: ChatDeps = {}): ChatResolved {
  return {
    client: deps.chat ?? createChatClient({ chatBase: googleEndpoints(getEnv().GOOGLE_TEST_BASE_URL).chat }),
    tokens: deps.chatTokens ?? appTokens(),
    now: deps.now ?? (() => new Date()),
  };
}

/** The Chat adapter for one connection. When the app's own credentials are refused, every space becomes unavailable (and an error is logged). */
export function chatAdapterFor(_ctx: AdapterContext, deps: ChatDeps = {}): ProviderAdapter {
  if (!chatEnabled()) throw new UnsupportedProviderError("GOOGLE_CHAT");
  const { client, tokens, now } = resolveChat(deps);
  const inner = createChatAdapter({
    client, now, backfillDays: getEnv().GOOGLE_CHAT_BACKFILL_DAYS,
    tokens: { getToken: async () => tokens.getToken(), invalidate: () => tokens.invalidate() },
  });
  return {
    provider: "GOOGLE_CHAT",
    normalize: (event: RawProviderEvent) => inner.normalize(event),
    async fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage> {
      try {
        return await inner.fetch(source, cursor, limit);
      } catch (e) {
        if (!(e instanceof ProviderAuthError)) throw e;
        log("error", "chat.app_credentials_rejected", { code: e.code });
        throw new ProviderSourceUnavailableError();
      }
    },
  };
}

// ---- claiming a space ---------------------------------------------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: it is read off a screen and typed
const CODE_PATTERN = /\bLS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g;
const CLAIM_TTL_MS = 24 * 3_600_000;
const SKEW_MS = 10 * 60_000;
const VERIFY_MAX_PAGES = 5;

export const makeClaimCode = (): string => {
  const pick = (n: number) => Array.from(randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `LS-${pick(4)}-${pick(4)}`;
};
const codeAad = (organizationId: string) => `${organizationId}:SourceClaim.code`;

/** `spaces/<id>`, a bare id, or a chat.google.com link to the space. Anything else is refused. */
export function parseSpace(input: string): string {
  const raw = input.trim();
  const fromUrl = /^https:\/\/chat\.google\.com\/(?:room|space|app\/chat)\/([A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/.exec(raw)?.[1];
  const candidate = fromUrl ? `spaces/${fromUrl}` : raw.startsWith("spaces/") ? raw : `spaces/${raw}`;
  if (!SPACE_NAME.test(candidate)) throw new ChatClaimError("invalid_space");
  return candidate;
}

export interface StartedClaim { claimId: string; space: string; code: string; expiresAt: Date }

/** Ask to bind a space. Returns the one-time code to post in that space. A new request for the same space replaces the previous one. */
export async function startSpaceClaim(principal: Principal, input: { space: string; teamId: string }, deps: ChatDeps = {}): Promise<StartedClaim> {
  if (!chatEnabled()) throw new ChatDisabledError();
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const space = parseSpace(input.space);
  const now = deps.now ?? (() => new Date());
  const { fieldKey } = resolveDeps(deps);
  const organizationId = principal.organizationId;
  const code = makeClaimCode();
  const expiresAt = new Date(now().getTime() + CLAIM_TTL_MS);

  return withTenant({ organizationId, userId: principal.userId }, async (tx) => {
    if (!(await tx.team.findFirst({ where: { id: input.teamId } }))) throw new ChatClaimError("team_not_found");
    const bound = await tx.monitoredSource.findFirst({ where: { kind: "SPACE", externalId: space, enabled: true, connection: { provider: "GOOGLE_CHAT" } } });
    if (bound) throw new ChatClaimError("already_bound");
    await tx.sourceClaim.updateMany({ where: { provider: "GOOGLE_CHAT", externalId: space, status: "PENDING" }, data: { status: "SUPERSEDED" } });
    const claim = await tx.sourceClaim.create({
      data: { organizationId, provider: "GOOGLE_CHAT", externalId: space, teamId: input.teamId, code: encryptField(code, fieldKey, codeAad(organizationId)), createdByUserId: principal.userId, expiresAt },
    });
    await recordAudit(tx, { organizationId, actorType: "USER", actorId: principal.userId, action: "connection.chat_claim_started", entityType: "SourceClaim", entityId: claim.id, metadata: { teamId: input.teamId } });
    return { claimId: claim.id, space, code, expiresAt };
  });
}

export type VerifyOutcome =
  | { outcome: "VERIFIED"; monitoredSourceId: string }
  | { outcome: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED" | "CODE_NOT_SEEN" | "APP_NOT_IN_SPACE" | "ALREADY_BOUND" };

/**
 * Look in the space for the claim's code and, if it is there, bind the space to this organization. Reading happens as the Chat app, so
 * "the app is not in the space" is a distinct, fixable answer. Message text is only compared in memory: it is never stored or logged.
 */
export async function verifySpaceClaim(principal: Principal, claimId: string, deps: ChatDeps = {}): Promise<VerifyOutcome> {
  if (!chatEnabled()) throw new ChatDisabledError();
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const { client, tokens, now } = resolveChat(deps);
  const { fieldKey } = resolveDeps(deps);
  const organizationId = principal.organizationId;
  const ctx = { organizationId, userId: principal.userId };

  const claim = await withTenant(ctx, (tx) => tx.sourceClaim.findFirst({ where: { id: claimId, provider: "GOOGLE_CHAT" } }));
  if (!claim) return { outcome: "NOT_FOUND" };
  if (claim.status !== "PENDING") return { outcome: "NOT_PENDING" };
  if (claim.expiresAt.getTime() < now().getTime()) return { outcome: "EXPIRED" };
  const code = decryptField(claim.code, fieldKey, codeAad(organizationId));

  let seen = false;
  try {
    const after = new Date(claim.createdAt.getTime() - SKEW_MS).toISOString();
    let pageToken: string | undefined;
    for (let page = 0; page < VERIFY_MAX_PAGES && !seen; page++) {
      const r = await client.listMessages(await tokens.getToken(), claim.externalId, { afterCreateTime: after, pageToken, pageSize: 100 });
      seen = r.messages.some((m) => (m.text ?? "").match(CODE_PATTERN)?.includes(code));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
  } catch (e) {
    if (e instanceof ProviderSourceUnavailableError) return { outcome: "APP_NOT_IN_SPACE" };
    if (e instanceof ProviderAuthError) {
      log("error", "chat.app_credentials_rejected", { code: e.code });
      return { outcome: "APP_NOT_IN_SPACE" };
    }
    throw e;
  }
  if (!seen) return { outcome: "CODE_NOT_SEEN" };

  return withTenant(ctx, async (tx): Promise<VerifyOutcome> => {
    const rows = await tx.$queryRaw<Array<{ elsewhere: boolean }>>`SELECT chat_space_bound_elsewhere(${claim.externalId}, ${organizationId}::uuid) AS elsewhere`;
    if (rows[0]?.elsewhere !== false) return { outcome: "ALREADY_BOUND" }; // taken elsewhere (or no clear answer: fail closed)
    let connection = await tx.sourceConnection.findFirst({ where: { provider: "GOOGLE_CHAT" } });
    if (!connection) connection = await tx.sourceConnection.create({ data: { organizationId, provider: "GOOGLE_CHAT", ownerUserId: principal.userId, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE], status: "ACTIVE" } });
    else if (connection.status !== "ACTIVE") await tx.sourceConnection.update({ where: { organizationId_id: { organizationId, id: connection.id } }, data: { status: "ACTIVE" } });
    const existing = await tx.monitoredSource.findFirst({ where: { connectionId: connection.id, kind: "SPACE", externalId: claim.externalId } });
    const source = existing
      ? await tx.monitoredSource.update({ where: { organizationId_id: { organizationId, id: existing.id } }, data: { enabled: true, teamId: claim.teamId } })
      : await tx.monitoredSource.create({ data: { organizationId, connectionId: connection.id, kind: "SPACE", externalId: claim.externalId, teamId: claim.teamId } });
    await tx.sourceClaim.update({ where: { organizationId_id: { organizationId, id: claim.id } }, data: { status: "VERIFIED", verifiedAt: now() } });
    await recordAudit(tx, {
      organizationId, actorType: "USER", actorId: principal.userId, action: "connection.chat_space_bound", entityType: "MonitoredSource", entityId: source.id,
      metadata: { claimId: claim.id, teamId: claim.teamId, rebound: Boolean(existing) },
    });
    return { outcome: "VERIFIED", monitoredSourceId: source.id };
  });
}

export type RemoveOutcome = "REMOVED" | "ALREADY_REMOVED" | "NOT_FOUND";

/** Stop reading a space and free it for anyone to claim. Messages already collected stay. */
export async function removeChatSpace(principal: Principal, monitoredSourceId: string): Promise<RemoveOutcome> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const organizationId = principal.organizationId;
  return withTenant({ organizationId, userId: principal.userId }, async (tx) => {
    const source = await tx.monitoredSource.findFirst({ where: { id: monitoredSourceId, kind: "SPACE", connection: { provider: "GOOGLE_CHAT" } } });
    if (!source) return "NOT_FOUND";
    if (!source.enabled) return "ALREADY_REMOVED";
    await tx.monitoredSource.update({ where: { organizationId_id: { organizationId, id: source.id } }, data: { enabled: false } });
    await recordAudit(tx, { organizationId, actorType: "USER", actorId: principal.userId, action: "connection.chat_space_removed", entityType: "MonitoredSource", entityId: source.id, metadata: {} });
    return "REMOVED";
  });
}

export interface ChatSpacesView {
  spaces: Array<{ id: string; space: string; teamId: string | null; enabled: boolean; lastSyncedAt: Date | null }>;
  pending: Array<{ id: string; space: string; teamId: string; code: string; expiresAt: Date }>;
}

/** Bound spaces and open claims (with their codes, which only organization admins can see). */
export async function listChatSpaces(principal: Principal, deps: ChatDeps = {}): Promise<ChatSpacesView> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const { fieldKey } = resolveDeps(deps);
  const now = deps.now ?? (() => new Date());
  const organizationId = principal.organizationId;
  return withTenant({ organizationId, userId: principal.userId }, async (tx) => {
    const sources = await tx.monitoredSource.findMany({ where: { kind: "SPACE", connection: { provider: "GOOGLE_CHAT" } }, orderBy: { createdAt: "desc" } });
    const claims = await tx.sourceClaim.findMany({ where: { provider: "GOOGLE_CHAT", status: "PENDING", expiresAt: { gt: now() } }, orderBy: { createdAt: "desc" } });
    return {
      spaces: sources.map((s) => ({ id: s.id, space: s.externalId, teamId: s.teamId, enabled: s.enabled, lastSyncedAt: s.lastSyncedAt })),
      pending: claims.map((c) => ({ id: c.id, space: c.externalId, teamId: c.teamId, code: decryptField(c.code, fieldKey, codeAad(organizationId)), expiresAt: c.expiresAt })),
    };
  });
}

/** Key rotation for open and past claim codes: re-encrypt from `from` to `to`. Idempotent; a blob neither key opens is counted as failed and left alone. */
export async function rekeyClaims(organizationId: string, from: Buffer, to: Buffer): Promise<{ rewritten: number; alreadyCurrent: number; failed: number }> {
  const out = { rewritten: 0, alreadyCurrent: 0, failed: 0 };
  await withTenant({ organizationId }, async (tx) => {
    for (const row of await tx.sourceClaim.findMany()) {
      try {
        const plain = decryptField(row.code, from, codeAad(organizationId));
        await tx.sourceClaim.update({ where: { organizationId_id: { organizationId, id: row.id } }, data: { code: encryptField(plain, to, codeAad(organizationId)) } });
        out.rewritten++;
      } catch {
        try {
          decryptField(row.code, to, codeAad(organizationId));
          out.alreadyCurrent++;
        } catch {
          out.failed++;
        }
      }
    }
  });
  return out;
}
