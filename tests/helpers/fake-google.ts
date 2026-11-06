import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake of the parts of Google the Gmail integration touches (OAuth consent and token endpoints, the Gmail REST API, the signing
 * keys for Pub/Sub push tokens). Everything is synthetic and in memory: no network, no real credentials, no real mail. It also
 * exposes /__control endpoints so a browser test in another process can add mail and steer the next consent.
 * It never logs request bodies, and it records only method, path and whether a bearer token was valid.
 */
export interface FakeMessage {
  id: string;
  threadId: string;
  labels: string[];
  from: string;
  to?: string;
  subject: string;
  text?: string;
  html?: string;
  attachmentName?: string;
  internalDate: number;
  /** Extra raw headers, e.g. an RFC 2047 encoded Subject. Overrides the plain ones above when names match. */
  headers?: Array<{ name: string; value: string }>;
}

interface Mailbox { messages: FakeMessage[]; history: Array<{ id: number; messageId: string }>; historyId: number; minHistoryId: number }
interface Failure { status: number; remaining: number; headers?: Record<string, string> }

export const KID = "fake-key-1";
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export class FakeGoogle {
  clientId = "fake-client-id";
  clientSecret = "fake-client-secret";
  /** Mailbox the next consent will grant access to. */
  nextMailbox = "support@synthetic.test";
  /** What the next consent does: "grant" (default), "deny", "no_refresh" (no refresh token) or "wrong_scope" (read scope missing). */
  nextConsent: "grant" | "deny" | "no_refresh" | "wrong_scope" = "grant";
  accessTokenTtlSec = 3600;
  watchTtlMs = 7 * 24 * 3_600_000;
  readonly mailboxes = new Map<string, Mailbox>();
  readonly requests: Array<{ method: string; path: string; authorized: boolean }> = [];
  readonly watches: Array<{ mailbox: string; topic: string }> = [];
  readonly revoked = new Set<string>();

  private server: Server | undefined;
  private keys!: { privateKey: KeyObject; jwk: Record<string, unknown> };
  private codes = new Map<string, { mailbox: string; challenge: string; redirectUri: string; refresh: boolean; scope: string }>();
  private accessTokens = new Map<string, { mailbox: string; expires: number }>();
  private refreshTokens = new Map<string, string>(); // refresh token -> mailbox
  private failures: Array<{ match: RegExp; failure: Failure }> = [];
  private hooks: Array<{ match: RegExp; fn: () => void }> = [];
  private counter = 0;
  /** Mail is dated relative to when the fake started, so it is always in the past whatever the machine's clock says. */
  private epoch = Date.now() - 2 * 3_600_000;
  baseUrl = "";

  async start(port = 0): Promise<this> {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.keys = { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" } };
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }));
    this.server.keepAliveTimeout = 65_000; // outlive the clients' idle sockets, so a reused connection is never one we already closed
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---- test controls ----------------------------------------------------------------------------------------------
  mailbox(address: string): Mailbox {
    const key = address.toLowerCase();
    let m = this.mailboxes.get(key);
    if (!m) this.mailboxes.set(key, (m = { messages: [], history: [], historyId: 1000, minHistoryId: 1000 }));
    return m;
  }
  addMessage(address: string, msg: Partial<FakeMessage> & Pick<FakeMessage, "from" | "subject">): FakeMessage {
    const mb = this.mailbox(address);
    const full: FakeMessage = { id: `m${++this.counter}-${randomUUID().slice(0, 8)}`, threadId: `t${this.counter}-${randomUUID().slice(0, 8)}`, labels: ["INBOX"], text: "Hello, please help.", internalDate: this.epoch + this.counter * 1_000, ...msg };
    mb.messages.push(full);
    mb.history.push({ id: ++mb.historyId, messageId: full.id });
    return full;
  }
  /** Forget history before now, so a stored historyId becomes unusable (Gmail answers 404). */
  expireHistory(address: string): void {
    const mb = this.mailbox(address);
    mb.minHistoryId = mb.historyId + 1;
    mb.history = [];
    mb.historyId += 1;
  }
  /** Make requests whose path matches fail with `status` the next `times` times. */
  failNext(match: RegExp, status: number, times = 1, headers?: Record<string, string>): void { this.failures.push({ match, failure: { status, remaining: times, ...(headers ? { headers } : {}) } }); }
  clearFailures(): void { this.failures = []; this.hooks = []; }
  /** Run `fn` once, right after a request whose path matches has been answered (e.g. mail arriving while a listing is in flight). */
  afterNext(match: RegExp, fn: () => void): void { this.hooks.push({ match, fn }); }
  /** Every issued access token stops working (they "expired" early); refresh tokens still work. */
  expireAccessTokens(): void { this.accessTokens.clear(); }
  revokeRefreshTokens(address?: string): void {
    for (const [t, m] of this.refreshTokens) if (!address || m === address.toLowerCase()) this.refreshTokens.delete(t);
  }
  count(pathPart: string): number { return this.requests.filter((r) => r.path.includes(pathPart)).length; }
  /** A Pub/Sub-style signed token. Override claims to make invalid ones. */
  pushToken(claims: Partial<{ aud: string; email: string; exp: number; iss: string; email_verified: boolean }> = {}, opts: { kid?: string; tamper?: boolean } = {}): string {
    const header = b64({ alg: "RS256", typ: "JWT", kid: opts.kid ?? KID });
    const payload = b64({ iss: "https://accounts.google.com", aud: "https://app.example.test/api/gmail/push", email: "pubsub@synthetic-project.iam.gserviceaccount.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.keys.privateKey).toString("base64url");
    return `${header}.${opts.tamper ? b64({ iss: "https://accounts.google.com", aud: "x", email: "x", exp: 9_999_999_999 }) : payload}.${signature}`;
  }

  // ---- server -----------------------------------------------------------------------------------------------------
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const raw = method === "GET" ? "" : await new Promise<string>((resolve) => { let s = ""; req.on("data", (c: Buffer) => (s += c)); req.on("end", () => resolve(s)); });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
      const i = this.hooks.findIndex((h) => h.match.test(path));
      if (i >= 0) this.hooks.splice(i, 1)[0]!.fn();
    };

    if (path.startsWith("/__control")) return this.control(path, raw, json);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const token = bearer ? this.accessTokens.get(bearer) : undefined;
    const authorized = Boolean(token && token.expires > Date.now());
    this.requests.push({ method, path: path + (url.search ? "?…" : ""), authorized });

    const injected = this.failures.find((f) => f.failure.remaining > 0 && f.match.test(path));
    if (injected) { injected.failure.remaining--; return json(injected.failure.status, { error: { errors: [{ reason: injected.failure.status === 403 ? "rateLimitExceeded" : "backendError" }] } }, injected.failure.headers); }

    if (path === "/authorize") return this.authorize(url, res);
    if (path === "/token") return this.tokenEndpoint(new URLSearchParams(raw), json);
    if (path === "/revoke") { const t = new URLSearchParams(raw).get("token") ?? ""; this.revoked.add(t); this.refreshTokens.delete(t); this.accessTokens.delete(t); return json(200, {}); }
    if (path === "/certs") return json(200, { keys: [this.keys.jwk] });

    if (!path.startsWith("/gmail/v1/users/me")) return json(404, {});
    if (!authorized) return json(401, { error: { code: 401 } });
    const mb = this.mailbox(token!.mailbox);
    const sub = path.slice("/gmail/v1/users/me".length);
    if (sub === "/profile") return json(200, { emailAddress: token!.mailbox, historyId: String(mb.historyId), messagesTotal: mb.messages.length });
    if (sub === "/messages") {
      const visible = mb.messages.filter((m) => m.labels.some((l) => l === "INBOX" || l === "SENT") && !m.labels.some((l) => l === "SPAM" || l === "TRASH")).sort((a, b) => b.internalDate - a.internalDate);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = visible.slice(start, start + size);
      return json(200, { ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}), ...(start + size < visible.length ? { nextPageToken: String(start + size) } : {}) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(sub);
    if (one) { const m = mb.messages.find((x) => x.id === decodeURIComponent(one[1]!)); return m ? json(200, this.render(m, mb)) : json(404, { error: { code: 404 } }); }
    if (sub === "/history") {
      const startId = Number(url.searchParams.get("startHistoryId"));
      if (!Number.isFinite(startId) || startId < mb.minHistoryId) return json(404, { error: { code: 404 } });
      const entries = mb.history.filter((h) => h.id > startId);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = entries.slice(offset, offset + size);
      return json(200, { history: page.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.messageId } }] })), historyId: String(mb.historyId), ...(offset + size < entries.length ? { nextPageToken: String(offset + size) } : {}) });
    }
    if (sub === "/watch") {
      const body = JSON.parse(raw || "{}") as { topicName?: string };
      this.watches.push({ mailbox: token!.mailbox, topic: body.topicName ?? "" });
      return json(200, { historyId: String(mb.historyId), expiration: String(Date.now() + this.watchTtlMs) });
    }
    if (sub === "/stop") return json(204, {});
    return json(404, {});
  }

  private render(m: FakeMessage, mb: Mailbox) {
    const headers = [{ name: "From", value: m.from }, { name: "To", value: m.to ?? "support@synthetic.test" }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.internalDate).toUTCString() }];
    for (const h of m.headers ?? []) { const i = headers.findIndex((x) => x.name.toLowerCase() === h.name.toLowerCase()); if (i >= 0) headers[i] = h; else headers.push(h); }
    const part = (mimeType: string, data: string) => ({ mimeType, filename: "", body: { size: data.length, data: Buffer.from(data).toString("base64url") } });
    const bodies = [...(m.text !== undefined ? [part("text/plain", m.text)] : []), ...(m.html !== undefined ? [part("text/html", m.html)] : [])];
    const parts = [...bodies, ...(m.attachmentName ? [{ mimeType: "application/pdf", filename: m.attachmentName, body: { size: 10, attachmentId: "att-1" } }] : [])];
    return { id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: "ignored", historyId: String(mb.historyId), internalDate: String(m.internalDate), sizeEstimate: 100, payload: { mimeType: "multipart/mixed", headers, body: { size: 0 }, parts } };
  }

  private authorize(url: URL, res: ServerResponse): void {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (url.searchParams.get("client_id") !== this.clientId || !url.searchParams.get("code_challenge")) { res.writeHead(400); res.end(); return; }
    const back = new URL(redirectUri);
    back.searchParams.set("state", state);
    if (this.nextConsent === "deny") back.searchParams.set("error", "access_denied");
    else {
      const code = `code-${randomUUID()}`;
      this.codes.set(code, {
        mailbox: this.nextMailbox.toLowerCase(), challenge: url.searchParams.get("code_challenge")!, redirectUri, refresh: this.nextConsent !== "no_refresh",
        scope: this.nextConsent === "wrong_scope" ? "https://www.googleapis.com/auth/userinfo.email" : url.searchParams.get("scope") ?? "",
      });
      back.searchParams.set("code", code);
    }
    this.mailbox(this.nextMailbox);
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  private tokenEndpoint(form: URLSearchParams, json: (status: number, body: unknown) => void): void {
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) return json(401, { error: "invalid_client" });
    const issue = (mailbox: string, extra: Record<string, unknown>) => {
      const access = `at-${randomUUID()}`;
      this.accessTokens.set(access, { mailbox, expires: Date.now() + this.accessTokenTtlSec * 1000 });
      return { access_token: access, expires_in: this.accessTokenTtlSec, token_type: "Bearer", ...extra };
    };
    if (form.get("grant_type") === "authorization_code") {
      const grant = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? ""); // single use
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || form.get("redirect_uri") !== grant.redirectUri || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return json(400, { error: "invalid_grant" });
      const refresh = grant.refresh ? `rt-${randomUUID()}` : undefined;
      if (refresh) this.refreshTokens.set(refresh, grant.mailbox);
      return json(200, issue(grant.mailbox, { scope: grant.scope, ...(refresh ? { refresh_token: refresh } : {}) }));
    }
    if (form.get("grant_type") === "refresh_token") {
      const mailbox = this.refreshTokens.get(form.get("refresh_token") ?? "");
      return mailbox ? json(200, issue(mailbox, { scope: "https://www.googleapis.com/auth/gmail.readonly" })) : json(400, { error: "invalid_grant" });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private control(path: string, raw: string, json: (status: number, body: unknown) => void): void {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (path === "/__control/health") return json(200, { ok: true });
    if (path === "/__control/add-message") { const m = this.addMessage(String(body["mailbox"]), body["message"] as never); return json(200, { id: m.id, threadId: m.threadId }); }
    if (path === "/__control/consent") { if (body["mailbox"]) this.nextMailbox = String(body["mailbox"]); if (body["mode"]) this.nextConsent = body["mode"] as never; return json(200, {}); }
    if (path === "/__control/expire-history") { this.expireHistory(String(body["mailbox"])); return json(200, {}); }
    if (path === "/__control/revoke-refresh") { this.revokeRefreshTokens(body["mailbox"] ? String(body["mailbox"]) : undefined); return json(200, {}); }
    if (path === "/__control/expire-access") { this.expireAccessTokens(); return json(200, {}); }
    if (path === "/__control/state") return json(200, { revoked: [...this.revoked].length, requests: this.requests.length, refreshTokens: this.refreshTokens.size });
    return json(404, {});
  }
}
