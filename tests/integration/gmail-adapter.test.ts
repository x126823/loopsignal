import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGmailAdapter, createGoogleClient, createKeySource, googleEndpoints, ProviderApiError, ProviderAuthError, ProviderRateLimitError, verifyPubSubToken, type GmailAuth, type GoogleClient,
} from "@/modules/integrations";
import { canonicalJson } from "@/modules/ingestion";
import { FakeGoogle, KID } from "../helpers/fake-google";

const fake = new FakeGoogle();
const MAILBOX = "support@synthetic.test";
const slept: number[] = [];
let client: GoogleClient;
let token = "";

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});

async function login(): Promise<{ access: string; refresh: string }> {
  // Drive the fake's real consent + token endpoints with PKCE, exactly as the app does.
  const verifier = "v".repeat(43);
  const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
  const res = await fetch(`${fake.baseUrl}/authorize?client_id=${fake.clientId}&redirect_uri=http://localhost:3000/cb&state=s&code_challenge=${challenge}&scope=x`, { redirect: "manual" });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const grant = await client.exchangeCode({ code, redirectUri: "http://localhost:3000/cb", codeVerifier: verifier });
  return { access: grant.accessToken, refresh: grant.refreshToken! };
}

beforeEach(async () => {
  fake.mailboxes.clear();
  fake.requests.length = 0;
  fake.clearFailures();
  fake.nextMailbox = MAILBOX;
  fake.nextConsent = "grant";
  slept.length = 0;
  client = createGoogleClient({ endpoints: googleEndpoints(fake.baseUrl), clientId: fake.clientId, clientSecret: fake.clientSecret, sleep: async (ms) => void slept.push(ms), baseDelayMs: 10 });
  token = (await login()).access;
});

const auth = (): GmailAuth => ({ getToken: async () => token, refresh: async () => { throw new Error("refresh not expected"); } });
const adapter = (days = 7) => createGmailAdapter({ client, auth: auth(), backfillDays: days });
const SOURCE = { kind: "MAILBOX" as const, externalId: MAILBOX };
const customer = (n: number) => ({ from: `Customer ${n} <customer${n}@customer.test>`, subject: `Request ${n}`, text: `Please help with matter ${n}.` });

/** Run fetch to the end of the data, as syncSource does, returning every event and the final cursor. */
async function drain(a = adapter(), start: string | null = null, limit = 2) {
  let cursor = start;
  const events = [];
  const notices = [];
  for (let i = 0; i < 50; i++) {
    const page = await a.fetch(SOURCE, cursor, limit);
    events.push(...page.events);
    if (page.notice) notices.push(page.notice);
    cursor = page.nextCursor;
    if (!page.hasMore) return { events, cursor, notices };
  }
  throw new Error("fetch never ended");
}

describe("google client", () => {
  it("builds a consent URL with only the read-only scope, offline access, PKCE and no extra grants", () => {
    const u = new URL(client.buildAuthUrl({ redirectUri: "http://localhost:3000/api/gmail/callback", state: "st", codeChallenge: "ch" }));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", prompt: "consent", code_challenge: "ch", code_challenge_method: "S256", response_type: "code", state: "st", include_granted_scopes: "false",
    });
  });

  it("refuses a test endpoint that is not a loopback address, so tokens can never be sent to a typo", () => {
    expect(() => googleEndpoints("https://evil.example.com")).toThrow(/loopback/);
    expect(googleEndpoints("http://localhost:4010/").token).toBe("http://localhost:4010/token");
  });

  it("retries throttling honouring Retry-After, then succeeds", async () => {
    fake.failNext(/\/profile$/, 429, 2, { "retry-after": "3" });
    await expect(client.getProfile(token)).resolves.toMatchObject({ emailAddress: MAILBOX });
    expect(slept).toEqual([3000, 3000]);
  });

  it("backs off exponentially on server errors and gives up with a status-only error", async () => {
    fake.failNext(/\/profile$/, 503, 10);
    const error = await client.getProfile(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect((error as ProviderApiError).message).toBe("Provider request failed with status 503");
    expect(slept).toEqual([10, 20, 40]); // 4 attempts
  });

  it("treats a rate-limit 403 as throttling and gives up with a rate-limit error", async () => {
    fake.failNext(/\/profile$/, 403, 10);
    await expect(client.getProfile(token)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it("maps credential failures to auth errors without retrying", async () => {
    const n = fake.count("/profile");
    await expect(client.getProfile("not-a-token")).rejects.toMatchObject({ name: "ProviderAuthError", code: "unauthorized" });
    expect(fake.count("/profile") - n).toBe(1);
    await expect(client.refresh("rt-unknown")).rejects.toMatchObject({ name: "ProviderAuthError", code: "invalid_grant" });
  });

  it("returns null for a message that vanished, and rejects responses that do not match the schema", async () => {
    await expect(client.getMessage(token, "gone")).resolves.toBeNull();
    fake.addMessage(MAILBOX, customer(1));
    const bad = createGoogleClient({ endpoints: googleEndpoints(fake.baseUrl), clientId: "x", clientSecret: "x", fetchImpl: async () => new Response(JSON.stringify({ emailAddress: 42, secret: "do-not-leak" })) });
    const e = await bad.getProfile(token).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderApiError);
    expect(String((e as Error).message)).not.toContain("do-not-leak");
  });

  it("never puts tokens or bodies into error messages", async () => {
    const e = await client.getProfile("secret-looking-token").then(() => new Error("expected a failure"), (x: unknown) => x as Error);
    expect(e.message).not.toContain("secret-looking-token");
  });
});

describe("gmail adapter: first sync and following history", () => {
  it("reads the mailbox in pages, then stands at the mailbox's history position", async () => {
    for (let i = 1; i <= 5; i++) fake.addMessage(MAILBOX, customer(i));
    const { events, cursor, notices } = await drain();
    expect(events).toHaveLength(5);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(5);
    expect(cursor).toBe(`h.${fake.mailbox(MAILBOX).historyId}`);
    expect(notices).toEqual([]);
    expect(events.every((e) => e.provider === "GMAIL")).toBe(true);
  });

  it("reports hasMore with a resumable backfill cursor", async () => {
    for (let i = 1; i <= 3; i++) fake.addMessage(MAILBOX, customer(i));
    const first = await adapter().fetch(SOURCE, null, 2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toMatch(/^b\.\d+\./);
    const second = await adapter().fetch(SOURCE, first.nextCursor, 2);
    expect(second.hasMore).toBe(false);
    expect(first.events.length + second.events.length).toBe(3);
  });

  it("picks up only new mail afterwards, and nothing when nothing changed", async () => {
    fake.addMessage(MAILBOX, customer(1));
    const caughtUp = await drain();
    const idle = await adapter().fetch(SOURCE, caughtUp.cursor, 10);
    expect(idle).toMatchObject({ events: [], hasMore: false, nextCursor: caughtUp.cursor });
    const fresh = fake.addMessage(MAILBOX, customer(2));
    const next = await drain(adapter(), caughtUp.cursor);
    expect(next.events.map((e) => e.externalId)).toEqual([fresh.id]);
    expect(next.cursor).toBe(`h.${fake.mailbox(MAILBOX).historyId}`);
  });

  it("loses nothing that arrives while the first sync is still reading: the position is fixed before the listing starts", async () => {
    fake.addMessage(MAILBOX, customer(1));
    let late: string | undefined;
    fake.afterNext(/\/messages$/, () => { late = fake.addMessage(MAILBOX, customer(2)).id; }); // arrives right after the listing was answered
    const first = await drain();
    expect(first.events.map((e) => e.externalId)).not.toContain(late);
    const next = await drain(adapter(), first.cursor);
    expect(next.events.map((e) => e.externalId)).toEqual([late]);
  });

  it("pages through history when many messages arrive at once", async () => {
    const caughtUp = await drain();
    for (let i = 1; i <= 5; i++) fake.addMessage(MAILBOX, customer(i));
    const next = await drain(adapter(), caughtUp.cursor, 2);
    expect(next.events).toHaveLength(5);
  });

  it("skips spam, drafts and other labels, but still advances past them", async () => {
    const caughtUp = await drain();
    fake.addMessage(MAILBOX, { ...customer(1), labels: ["INBOX", "SPAM"] });
    fake.addMessage(MAILBOX, { ...customer(2), labels: ["DRAFT"] });
    const kept = fake.addMessage(MAILBOX, customer(3));
    const next = await drain(adapter(), caughtUp.cursor);
    expect(next.events.map((e) => e.externalId)).toEqual([kept.id]);
    expect(next.cursor).toBe(`h.${fake.mailbox(MAILBOX).historyId}`);
  });

  it("projects a stable payload: the same message read after a label change is byte-identical", async () => {
    const m = fake.addMessage(MAILBOX, customer(1));
    const before = (await drain()).events[0]!;
    m.labels = ["INBOX", "STARRED", "IMPORTANT"]; // marked read, starred
    fake.mailbox(MAILBOX).history.push({ id: ++fake.mailbox(MAILBOX).historyId, messageId: m.id });
    const after = (await drain(adapter(), null)).events[0]!;
    expect(canonicalJson(after.payload)).toBe(canonicalJson(before.payload));
  });

  it("does not read attachments or return their content", async () => {
    fake.addMessage(MAILBOX, { ...customer(1), attachmentName: "contract.pdf" });
    const [event] = (await drain()).events;
    expect(event!.payload).toMatchObject({ hasAttachments: true });
    expect(JSON.stringify(event!.payload)).not.toContain("att-1");
  });

  it("refuses sources that are not mailboxes", async () => {
    await expect(adapter().fetch({ kind: "LABEL", externalId: "x" }, null, 5)).rejects.toThrow(/mailboxes only/);
  });
});

describe("gmail adapter: history gaps", () => {
  it("restarts a bounded backfill when Gmail has forgotten the position, flags it, and a re-read dedupes by message id", async () => {
    for (let i = 1; i <= 3; i++) fake.addMessage(MAILBOX, customer(i));
    const first = await drain();
    fake.addMessage(MAILBOX, customer(4));
    fake.expireHistory(MAILBOX);
    const recovered = await drain(adapter(), first.cursor);
    expect(recovered.notices).toEqual(["RESYNC"]);
    expect(recovered.events).toHaveLength(4); // everything in the window, including mail the old position had already covered
    const ids = new Set(first.events.map((e) => e.externalId));
    expect(recovered.events.filter((e) => ids.has(e.externalId))).toHaveLength(3); // the same ids: ingestion will recognize them
    expect(recovered.cursor).toBe(`h.${fake.mailbox(MAILBOX).historyId}`);
  });

  it("treats an unreadable cursor like a gap instead of failing forever", async () => {
    fake.addMessage(MAILBOX, customer(1));
    const out = await drain(adapter(), "garbage-cursor");
    expect(out.notices).toEqual(["RESYNC"]);
    expect(out.events).toHaveLength(1);
  });
});

describe("gmail adapter: credentials", () => {
  it("refreshes once and retries when Gmail rejects the access token", async () => {
    fake.addMessage(MAILBOX, customer(1));
    let refreshed = 0;
    const stale: GmailAuth = { getToken: async () => "expired-token", refresh: async () => { refreshed++; return token; } };
    const out = await drain(createGmailAdapter({ client, auth: stale, backfillDays: 7 }));
    expect(out.events).toHaveLength(1);
    expect(refreshed).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a credential failure that persists after the refresh", async () => {
    const dead: GmailAuth = { getToken: async () => "bad", refresh: async () => "still-bad" };
    await expect(createGmailAdapter({ client, auth: dead, backfillDays: 7 }).fetch(SOURCE, null, 5)).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("pub/sub push token verification", () => {
  const expectation = { audience: "https://app.example.test/api/gmail/push", serviceAccount: "pubsub@synthetic-project.iam.gserviceaccount.com" };
  const verify = (t: string, now = Date.now()) => verifyPubSubToken(t, expectation, createKeySource(`${fake.baseUrl}/certs`), now);

  it("accepts a token signed by the expected key with the expected audience and sender", async () => {
    expect(await verify(fake.pushToken())).toEqual({ ok: true });
  });

  it.each([
    ["wrong audience", () => fake.pushToken({ aud: "https://elsewhere.test" }), "wrong_audience"],
    ["wrong service account", () => fake.pushToken({ email: "someone@else.test" }), "wrong_sender"],
    ["unverified email", () => fake.pushToken({ email_verified: false }), "wrong_sender"],
    ["expired", () => fake.pushToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), "expired"],
    ["unknown key id", () => fake.pushToken({}, { kid: "someone-elses-key" }), "unknown_key"],
    ["tampered claims", () => fake.pushToken({}, { tamper: true }), "bad_signature"],
    ["not a jwt", () => "abc.def", "malformed"],
    ["empty parts", () => "..", "malformed"],
  ])("rejects: %s", async (_name, make, reason) => {
    expect(await verify(make())).toEqual({ ok: false, reason });
  });

  it("rejects a token signed with an algorithm other than RS256, and one whose header is not what we expect", async () => {
    const forged = `${Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url")}.${fake.pushToken().split(".")[1]}.`;
    expect(await verify(forged)).toEqual({ ok: false, reason: "malformed" });
  });
});
