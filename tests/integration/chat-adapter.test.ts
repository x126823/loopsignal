import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createChatAdapter, createChatClient, createServiceAccountTokens, googleEndpoints, NormalizationError, parseServiceAccountKey, ProviderApiError, ProviderAuthError, ProviderSourceUnavailableError,
  CHAT_APP_MESSAGES_READONLY_SCOPE, type ChatClient, type ProviderAdapter, type ServiceAccountTokens,
} from "@/modules/integrations";
import { FakeGoogle } from "../helpers/fake-google";

const fake = new FakeGoogle();
const SPACE = "spaces/AAAAsupport";
const SOURCE = { kind: "SPACE" as const, externalId: SPACE };
let tokens: ServiceAccountTokens;
let client: ChatClient;
let adapter: ProviderAdapter;
const slept: number[] = [];

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.chatSpaces.clear();
  fake.requests.length = 0;
  fake.clearFailures();
  fake.rejectServiceAccount = false;
  fake.chatDescending = false;
  fake.chatUnavailableStatus = 404;
  fake.addChatSpace(SPACE, true);
  slept.length = 0;
  const endpoints = googleEndpoints(fake.baseUrl);
  const sleep = async (ms: number) => void slept.push(ms);
  tokens = createServiceAccountTokens({ key: parseServiceAccountKey(fake.serviceAccountJson()), tokenUrl: endpoints.token, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE], sleep, baseDelayMs: 1 });
  client = createChatClient({ chatBase: endpoints.chat, sleep, baseDelayMs: 1 });
  adapter = createChatAdapter({ client, tokens, backfillDays: 7 });
});

async function drain(a: ProviderAdapter = adapter, start: string | null = null, limit = 2) {
  let cursor = start;
  const events = [];
  for (let i = 0; i < 50; i++) {
    const page = await a.fetch(SOURCE, cursor, limit);
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) return { events, cursor: cursor! };
  }
  throw new Error("fetch never ended");
}

describe("service account (app authentication)", () => {
  it("accepts a key file and refuses a malformed one without echoing any of it", () => {
    expect(parseServiceAccountKey(fake.serviceAccountJson()).clientEmail).toBe(fake.serviceAccountEmail);
    for (const bad of ["not json", "{}", JSON.stringify({ client_email: "x@y.test" }), JSON.stringify({ client_email: "nope", private_key: "-----BEGIN PRIVATE KEY-----" }), JSON.stringify({ client_email: "a@b.test", private_key: "secret-looking-value" })]) {
      let message = "";
      try { parseServiceAccountKey(bad); } catch (e) { message = (e as Error).message; }
      expect(message, bad).not.toBe("");
      expect(message).not.toContain("secret-looking-value");
    }
  });

  it("mints a token with a signed assertion, and caches it until shortly before it expires", async () => {
    const first = await tokens.getToken();
    expect(first).toMatch(/^at-chat-/);
    expect(await tokens.getToken()).toBe(first);
    expect(fake.count("/token")).toBe(1);
    tokens.invalidate();
    expect(await tokens.getToken()).not.toBe(first);
    expect(fake.count("/token")).toBe(2);
  });

  it("re-mints near expiry using the injected clock", async () => {
    let now = Date.now();
    const t = createServiceAccountTokens({ key: parseServiceAccountKey(fake.serviceAccountJson()), tokenUrl: googleEndpoints(fake.baseUrl).token, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE], now: () => now });
    const a = await t.getToken();
    now += 3_600_000 - 60_000; // one minute of life left: inside the margin
    expect(await t.getToken()).not.toBe(a);
  });

  it("shares one exchange between concurrent callers", async () => {
    const before = fake.count("/token");
    const all = await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);
    expect(new Set(all).size).toBe(1);
    expect(fake.count("/token") - before).toBe(1);
  });

  it("only ever asks the endpoint it was given: the token_uri inside the key file is ignored", async () => {
    expect(JSON.parse(fake.serviceAccountJson()).token_uri).toContain("attacker.invalid");
    await expect(tokens.getToken()).resolves.toBeTruthy(); // it reached the fake, not attacker.invalid
  });

  it("reports a rejected key as a credential failure, and an unusable private key the same way", async () => {
    fake.rejectServiceAccount = true;
    await expect(tokens.getToken()).rejects.toMatchObject({ name: "ProviderAuthError", code: "invalid_grant" });
    const broken = createServiceAccountTokens({ key: { clientEmail: fake.serviceAccountEmail, privateKey: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" }, tokenUrl: googleEndpoints(fake.baseUrl).token, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE] });
    await expect(broken.getToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("chat client", () => {
  const msg = (n: number, extra: Parameters<FakeGoogle["addChatMessage"]>[1] = {}) => fake.addChatMessage(SPACE, { text: `Message ${n}`, ...extra });

  it("names only well-formed spaces, so a name can never carry a path or a query", async () => {
    const token = await tokens.getToken();
    for (const bad of ["AAAA", "spaces/", "spaces/a/b", "spaces/a?x=1", "../spaces/a", "spaces/a b"]) {
      await expect(client.listMessages(token, bad, { afterCreateTime: "2026-01-01T00:00:00Z", pageSize: 5 }), bad).rejects.toBeInstanceOf(ProviderApiError);
    }
    expect(fake.requests.filter((r) => r.path.startsWith("/chat/"))).toHaveLength(0);
  });

  it("treats a space the app cannot read as unavailable, whichever status Google uses", async () => {
    const token = await tokens.getToken();
    fake.addChatSpace(SPACE, false);
    for (const status of [404, 403]) {
      fake.chatUnavailableStatus = status;
      await expect(client.listMessages(token, SPACE, { afterCreateTime: "2026-01-01T00:00:00Z", pageSize: 5 }), String(status)).rejects.toBeInstanceOf(ProviderSourceUnavailableError);
    }
    await expect(client.listMessages(token, "spaces/neverheardof", { afterCreateTime: "2026-01-01T00:00:00Z", pageSize: 5 })).rejects.toBeInstanceOf(ProviderSourceUnavailableError);
  });

  it("returns nothing for an empty space (Google answers {}) and skips deleted messages", async () => {
    const token = await tokens.getToken();
    expect(await client.listMessages(token, SPACE, { afterCreateTime: "2020-01-01T00:00:00Z", pageSize: 5 })).toEqual({ messages: [] });
    const gone = msg(1);
    gone.deleteTime = "2026-11-06T10:00:00Z";
    msg(2);
    const r = await client.listMessages(token, SPACE, { afterCreateTime: "2020-01-01T00:00:00Z", pageSize: 10 });
    expect(r.messages.map((m) => m.text)).toEqual(["Message 2"]);
  });

  it("retries throttling and then gives up with a status-only error", async () => {
    const token = await tokens.getToken();
    fake.failNext(/\/chat\/v1\//, 429, 2);
    await expect(client.listMessages(token, SPACE, { afterCreateTime: "2020-01-01T00:00:00Z", pageSize: 5 })).resolves.toBeTruthy();
    expect(slept.length).toBe(2);
    fake.failNext(/\/chat\/v1\//, 503, 10);
    const e = await client.listMessages(token, SPACE, { afterCreateTime: "2020-01-01T00:00:00Z", pageSize: 5 }).then(() => new Error("expected a failure"), (x: unknown) => x as Error);
    expect(e.message).toBe("Provider request failed with status 503");
  });
});

describe("chat adapter", () => {
  const post = (n: number, extra: Parameters<FakeGoogle["addChatMessage"]>[1] = {}) => fake.addChatMessage(SPACE, { text: `Please help with matter ${n}.`, ...extra });

  it("reads the space in pages, oldest first, and stands at the newest message", async () => {
    const posted = [1, 2, 3, 4, 5].map((n) => post(n));
    const first = await adapter.fetch(SOURCE, null, 2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toMatch(/^t\..+\.2$/); // mid-listing: the page token is part of the cursor
    const { events, cursor } = await drain();
    expect(events.map((e) => e.externalId)).toEqual(posted.map((m) => m.name));
    expect(cursor).toBe(`t.${posted[4]!.createTime}`);
  });

  it("returns nothing new while caught up, and then only what arrived since", async () => {
    post(1);
    const caughtUp = await drain();
    expect(await adapter.fetch(SOURCE, caughtUp.cursor, 10)).toMatchObject({ events: [], hasMore: false, nextCursor: caughtUp.cursor });
    const fresh = post(2);
    const next = await drain(adapter, caughtUp.cursor);
    expect(next.events.map((e) => e.externalId)).toEqual([fresh.name]);
    expect(next.cursor).toBe(`t.${fresh.createTime}`);
  });

  it("orders by microseconds, so messages in the same millisecond are neither skipped nor repeated", async () => {
    const a = post(1, { createTime: "2026-11-06T09:00:00.123100Z" });
    const b = post(2, { createTime: "2026-11-06T09:00:00.123200Z" });
    const c = post(3, { createTime: "2026-11-06T09:00:00.123300Z" });
    const caughtUp = await drain(createChatAdapter({ client, tokens, backfillDays: 7, now: () => new Date("2026-11-06T10:00:00Z") }));
    expect(caughtUp.events.map((e) => e.externalId)).toEqual([a.name, b.name, c.name]);
    expect(caughtUp.cursor).toBe("t.2026-11-06T09:00:00.123300Z");
    const d = post(4, { createTime: "2026-11-06T09:00:00.123400Z" });
    expect((await drain(adapter, caughtUp.cursor)).events.map((e) => e.externalId)).toEqual([d.name]);
  });

  it("reads only the backfill window on a first sync", async () => {
    post(1, { createTime: "2026-10-01T09:00:00.000001Z" }); // far older than seven days before "now"
    const recent = post(2, { createTime: "2026-11-05T09:00:00.000001Z" });
    const a = createChatAdapter({ client, tokens, backfillDays: 7, now: () => new Date("2026-11-06T10:00:00Z") });
    expect((await drain(a)).events.map((e) => e.externalId)).toEqual([recent.name]);
  });

  it("never moves the cursor backwards", async () => {
    const m = post(1);
    const out = await drain(adapter, `t.${m.createTime}`);
    expect(out.events).toEqual([]);
    expect(out.cursor).toBe(`t.${m.createTime}`);
  });

  it("takes the newest message as its position whatever order a page arrives in", async () => {
    const posted = [post(1), post(2), post(3)];
    fake.chatDescending = true;
    const out = await drain(adapter, null, 10); // one page, newest first
    expect(out.events).toHaveLength(3);
    expect(out.cursor).toBe(`t.${posted[2]!.createTime}`);
  });

  it("restarts a listing whose page token has gone stale instead of failing forever", async () => {
    post(1); post(2); post(3);
    const first = await adapter.fetch(SOURCE, null, 1);
    const start = /^t\.(.+)\.1$/.exec(first.nextCursor)![1]!;
    const out = await drain(adapter, `t.${start}.stale-token`, 5);
    expect(out.events).toHaveLength(3); // re-read from the listing's starting point; ingestion dedupes
  });

  it("does not repeat or lose messages when read again from an older cursor (the replay is harmless)", async () => {
    const posted = [post(1), post(2)];
    const all = await drain();
    const again = await drain(adapter, null);
    expect(again.events.map((e) => e.externalId)).toEqual(all.events.map((e) => e.externalId));
    expect(posted.length).toBe(2);
  });

  it("refreshes an access token Google rejected, and carries on", async () => {
    post(1);
    await tokens.getToken();
    fake.expireAccessTokens();
    expect((await drain()).events).toHaveLength(1);
  });

  it("surfaces a rejected service account and an unreadable space", async () => {
    fake.rejectServiceAccount = true;
    tokens.invalidate();
    await expect(adapter.fetch(SOURCE, null, 5)).rejects.toBeInstanceOf(ProviderAuthError);
    fake.rejectServiceAccount = false;
    fake.addChatSpace(SPACE, false);
    await expect(adapter.fetch(SOURCE, null, 5)).rejects.toBeInstanceOf(ProviderSourceUnavailableError);
  });

  it("refuses sources that are not spaces", async () => {
    await expect(adapter.fetch({ kind: "MAILBOX", externalId: "a@b.test" }, null, 5)).rejects.toThrow(/spaces only/);
  });

  describe("normalize", () => {
    const eventFor = (m: ReturnType<typeof post>) => ({ provider: "GOOGLE_CHAT" as const, externalId: m.name, receivedAt: new Date(), payload: undefined as unknown });
    const normalized = async (extra: Parameters<FakeGoogle["addChatMessage"]>[1] = {}) => {
      const m = post(1, extra);
      const [event] = (await drain()).events;
      void eventFor;
      return { event: event!, m };
    };

    it("maps a person's message: thread, sender (never an email), time, a subject built from the sender only, INBOUND", async () => {
      const { event, m } = await normalized({ senderId: "users/777", senderName: "Pat Customer" });
      expect(adapter.normalize(event)).toMatchObject({
        provider: "GOOGLE_CHAT", externalMessageId: m.name, externalThreadId: m.thread.name, direction: "INBOUND",
        sender: { address: "users/777", displayName: "Pat Customer" }, bodyText: "Please help with matter 1.", sentAt: new Date(m.createTime),
      });
      expect(adapter.normalize(event).subject).toBe("Chat message from Pat Customer");
      expect(adapter.normalize(event).subject).not.toContain("matter 1"); // never message text: a subject is stored unencrypted
      expect(adapter.normalize({ ...event, payload: { ...(event.payload as object), senderName: undefined } }).subject).toBe("Chat message from someone");
    });

    it("treats other apps and bots as INTERNAL, which is never tracked as a request", async () => {
      expect((await normalized({ senderType: "BOT", senderId: "users/app-9" })).event).toBeTruthy();
      const [event] = (await drain(adapter, null, 10)).events.slice(-1);
      expect(adapter.normalize(event!).direction).toBe("INTERNAL");
    });

    it("falls back to the message itself as its thread, and marks messages without text", async () => {
      const m = fake.addChatMessage(SPACE, { text: "" });
      delete (m as { thread?: unknown }).thread;
      const events = (await drain(adapter, null, 10)).events;
      const n = adapter.normalize(events.find((e) => e.externalId === m.name)!);
      expect(n.externalThreadId).toBe(m.name);
      expect(n.bodyText).toBe("[no text content]");
    });

    it("stores a stable payload: only fixed fields, whatever else Chat adds", async () => {
      fake.addChatMessage(SPACE, { text: "hi" });
      const [event] = (await drain()).events.slice(-1);
      expect(Object.keys(event!.payload as object).sort()).toEqual(["createTime", "name", "senderId", "senderName", "senderType", "space", "text", "thread", "v"]);
    });

    it("rejects malformed payloads with a stable code and no content", async () => {
      const { event } = await normalized();
      for (const bad of [{ v: 2 }, { senderType: "ROBOT" }, { text: 5 }, { extra: "x" }, { name: "" }]) {
        let error: unknown;
        try { adapter.normalize({ ...event, payload: { ...(event.payload as object), ...bad } }); } catch (e) { error = e; }
        expect(error, JSON.stringify(bad)).toBeInstanceOf(NormalizationError);
        expect((error as Error).message).toBe("Malformed provider event: invalid_payload");
      }
      expect(() => adapter.normalize({ ...event, payload: { ...(event.payload as object), createTime: "yesterday" } })).toThrow("Malformed provider event: invalid_time");
    });
  });
});
