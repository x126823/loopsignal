import { z } from "zod";
import { createGoogleHttp, type GoogleHttpOptions } from "./google-http";
import { ProviderApiError, ProviderCursorExpiredError } from "./types";

/**
 * Minimal Google OAuth + Gmail REST client: plain fetch, every response validated with Zod, no new dependency.
 *
 * Rules this file keeps (CLAUDE.md rules 6 and 10):
 *  - Responses are untrusted. Anything unexpected becomes a ProviderApiError carrying a status code only.
 *  - Error messages never contain response bodies, request bodies, tokens or addresses.
 *  - Throttling (429, 5xx, rate-limit 403) is retried with backoff and honours Retry-After; other failures are not retried.
 */

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** Base of the Gmail user resource, e.g. https://gmail.googleapis.com/gmail/v1/users/me */
  gmail: string;
  certs: string;
  /** Base of the Google Chat REST API, e.g. https://chat.googleapis.com/v1 */
  chat: string;
}

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Production endpoints, or a local fake when `testBase` is given (loopback hosts only, so a typo can never send tokens elsewhere). */
export function googleEndpoints(testBase?: string): GoogleEndpoints {
  if (testBase) {
    const url = new URL(testBase);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("The Google test endpoint must be a loopback address");
    const base = testBase.replace(/\/$/, "");
    return { auth: `${base}/authorize`, token: `${base}/token`, revoke: `${base}/revoke`, gmail: `${base}/gmail/v1/users/me`, certs: `${base}/certs`, chat: `${base}/chat/v1` };
  }
  return {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
    certs: "https://www.googleapis.com/oauth2/v3/certs",
    chat: "https://chat.googleapis.com/v1",
  };
}

export interface GoogleClientOptions extends GoogleHttpOptions {
  endpoints: GoogleEndpoints;
  clientId: string;
  clientSecret: string;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
  token_type: z.string().optional(),
});
const profileResponse = z.object({ emailAddress: z.string().email(), historyId: z.string().regex(/^\d+$/) });
const messageListResponse = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).default([]),
  nextPageToken: z.string().min(1).optional(),
});
const historyResponse = z.object({
  history: z.array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).default([]) })).default([]),
  nextPageToken: z.string().min(1).optional(),
  historyId: z.string().regex(/^\d+$/),
});
const watchResponse = z.object({ historyId: z.string().regex(/^\d+$/), expiration: z.string().regex(/^\d+$/) });

export interface GmailPart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?: { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined } | undefined;
  parts?: GmailPart[] | undefined;
}
const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }));
export const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().regex(/^\d+$/),
  payload: partSchema,
});
export type GmailMessage = z.infer<typeof gmailMessageSchema>;

export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scopes: string[];
}

export function createGoogleClient(opts: GoogleClientOptions) {
  const { send, parse } = createGoogleHttp(opts);
  const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
  const tokenCall = async (params: Record<string, string>): Promise<TokenGrant> => {
    const body = new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, ...params });
    const { json } = await send(opts.endpoints.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const t = parse(tokenResponse, json);
    return { accessToken: t.access_token, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}), expiresInSec: t.expires_in, scopes: t.scope.split(/\s+/).filter(Boolean) };
  };
  const gmailUrl = (path: string, query: Record<string, string | undefined> = {}): string => {
    const u = new URL(`${opts.endpoints.gmail}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  return {
    /** The consent URL. `state` and the PKCE challenge are made by the caller. Offline access + consent so a refresh token is issued. */
    buildAuthUrl(p: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
      const u = new URL(opts.endpoints.auth);
      u.searchParams.set("client_id", opts.clientId);
      u.searchParams.set("redirect_uri", p.redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", GMAIL_READONLY_SCOPE);
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "false");
      u.searchParams.set("state", p.state);
      u.searchParams.set("code_challenge", p.codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
      return u.toString();
    },

    exchangeCode: (p: { code: string; redirectUri: string; codeVerifier: string }) =>
      tokenCall({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }),

    refresh: (refreshToken: string) => tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken }),

    /** Best effort: a failed revoke must not block disconnecting. Returns whether Google confirmed. */
    async revoke(token: string): Promise<boolean> {
      try {
        await send(opts.endpoints.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
        return true;
      } catch {
        return false;
      }
    },

    async getProfile(token: string): Promise<{ emailAddress: string; historyId: string }> {
      return parse(profileResponse, (await send(gmailUrl("/profile"), bearer(token))).json);
    },

    async listMessages(token: string, p: { query: string; pageToken?: string | undefined; maxResults: number }): Promise<{ ids: string[]; nextPageToken?: string }> {
      const { json } = await send(gmailUrl("/messages", { q: p.query, pageToken: p.pageToken, maxResults: String(p.maxResults) }), bearer(token));
      const r = parse(messageListResponse, json);
      return { ids: r.messages.map((m) => m.id), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
    },

    /** Null when the message no longer exists (deleted between listing and reading). */
    async getMessage(token: string, id: string): Promise<GmailMessage | null> {
      try {
        const { json } = await send(gmailUrl(`/messages/${encodeURIComponent(id)}`, { format: "full" }), bearer(token));
        return parse(gmailMessageSchema, json);
      } catch (e) {
        if (e instanceof ProviderApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** New message ids since `startHistoryId`. A 404 means the history is gone (too old): ProviderCursorExpiredError. */
    async listHistory(token: string, p: { startHistoryId: string; pageToken?: string | undefined; maxResults: number }): Promise<{ ids: string[]; historyId: string; nextPageToken?: string }> {
      try {
        const { json } = await send(gmailUrl("/history", { startHistoryId: p.startHistoryId, historyTypes: "messageAdded", pageToken: p.pageToken, maxResults: String(p.maxResults) }), bearer(token));
        const r = parse(historyResponse, json);
        const ids = [...new Set(r.history.flatMap((h) => h.messagesAdded.map((m) => m.message.id)))];
        return { ids, historyId: r.historyId, ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
      } catch (e) {
        if (e instanceof ProviderApiError && e.status === 404) throw new ProviderCursorExpiredError();
        throw e;
      }
    },

    async watch(token: string, p: { topicName: string }): Promise<{ historyId: string; expiresAt: Date }> {
      const { json } = await send(gmailUrl("/watch"), {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ topicName: p.topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "INCLUDE" }),
      });
      const r = parse(watchResponse, json);
      return { historyId: r.historyId, expiresAt: new Date(Number(r.expiration)) };
    },

    async stopWatch(token: string): Promise<void> {
      await send(gmailUrl("/stop"), { method: "POST", headers: { authorization: `Bearer ${token}` } });
    },
  };
}
export type GoogleClient = ReturnType<typeof createGoogleClient>;
