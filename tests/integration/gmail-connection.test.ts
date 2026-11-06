import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The integration is off unless configured, and the environment is read lazily on first use: set it before anything runs. The
// fake Google below stands in for every Google endpoint, so no real credential or mailbox is ever involved (CLAUDE.md rule 7).
const fake = new (await import("../helpers/fake-google")).FakeGoogle();
await fake.start();
Object.assign(process.env, {
  GMAIL_ENABLED: "true", GOOGLE_OAUTH_CLIENT_ID: fake.clientId, GOOGLE_OAUTH_CLIENT_SECRET: fake.clientSecret, GOOGLE_TEST_BASE_URL: fake.baseUrl,
  APP_BASE_URL: "https://app.example.test", GMAIL_PUBSUB_TOPIC: "projects/synthetic-project/topics/gmail-push",
  GMAIL_PUSH_AUDIENCE: "https://app.example.test/api/gmail/push", GMAIL_PUSH_SERVICE_ACCOUNT: "pubsub@synthetic-project.iam.gserviceaccount.com",
});

const { createPrismaClient, withTenant } = await import("@/lib/db");
const { decryptField } = await import("@/lib/crypto/fields");
const { QUEUES } = await import("@/lib/queue");
const { canonicalJson, syncSource } = await import("@/modules/ingestion");
const { createKeySource } = await import("@/modules/integrations");
const sources = await import("@/modules/sources");
const { handleGmailScan } = await import("@/workers/gmail-scan");
const { createEngineFixture } = await import("../helpers/engine-fixture");
const { purgeOrgs, testKey } = await import("../helpers/fixtures");
const { createTestHub, destroyTestHub, waitingJobs } = await import("../helpers/queue");
type Principal = import("@/modules/identity").Principal;
type QueueHub = import("@/lib/queue").QueueHub;

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const fakeKeys = () => createKeySource(`${fake.baseUrl}/certs`);
let f: Awaited<ReturnType<typeof createEngineFixture>>;
let other: Awaited<ReturnType<typeof createEngineFixture>>;
let hub: QueueHub;
const logged: string[] = [];

beforeAll(async () => {
  f = await createEngineFixture(owner);
  other = await createEngineFixture(owner);
  hub = createTestHub();
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await destroyTestHub(hub);
  await purgeOrgs(owner, [f.organizationId, other.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [...Object.values(f.users), ...Object.values(other.users)] } } });
  await owner.$disconnect();
  await fake.stop();
});
beforeEach(() => {
  fake.clearFailures();
  fake.nextConsent = "grant";
});
afterEach(() => {
  fake.revoked.clear();
});

const newMailbox = () => `box-${randomUUID().slice(0, 8)}@synthetic.test`;
const admin = () => f.principals.admin;
const SECRETS = new Set<string>();

/** Run the real consent flow end to end: begin, "approve" at the fake Google, come back with code and state. */
async function connect(p: Principal = admin(), mailbox = newMailbox(), team = f.teamId, deps: import("@/modules/sources").SourcesDeps = {}) {
  fake.nextMailbox = mailbox;
  const started = await sources.beginGmailConnect(p, { teamId: team }, deps);
  const res = await fetch(started.url, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  const code = back.searchParams.get("code");
  if (code) SECRETS.add(code);
  const result = await sources.completeGmailConnect(p, { code, state: back.searchParams.get("state"), providerError: back.searchParams.get("error"), cookieValue: started.cookieValue }, deps);
  return { ...result, mailbox, started, back };
}
const sync = (c: { monitoredSourceId: string }, org = f) => syncSource({ organizationId: org.organizationId, monitoredSourceId: c.monitoredSourceId }, { hub, fieldKey: testKey, pageSize: 2 });
const customer = (n: number) => ({ from: `Customer ${n} <customer${n}@customer.test>`, subject: `Request ${n}`, text: `Please help with matter ${n}.` });
const credentialRow = (connectionId: string) => owner.connectionCredential.findFirstOrThrow({ where: { connectionId } });
const aad = (org: string, conn: string) => `${org}:ConnectionCredential.tokens:${conn}`;

describe("consent flow", () => {
  it("connects a mailbox: a connection, a mailbox source for the chosen team, encrypted credentials and an audit row", async () => {
    const c = await connect();
    const conn = await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.connectionId } } });
    expect(conn).toMatchObject({ provider: "GMAIL", status: "ACTIVE", ownerUserId: f.users.admin, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
    const source = await owner.monitoredSource.findUniqueOrThrow({ where: { id: c.monitoredSourceId } });
    expect(source).toMatchObject({ kind: "MAILBOX", externalId: c.mailbox, teamId: f.teamId, enabled: true, cursor: null });
    expect(c.reconnected).toBe(false);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "connection.gmail_connected", entityId: c.connectionId } });
    expect(audit).toMatchObject({ actorType: "USER", actorId: f.users.admin });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/token|secret|@/i); // ids, flags and scopes only: not even the address
  });

  it("asks Google for read-only access with PKCE, and the request carries a signed state", async () => {
    const { started } = await connect();
    const u = new URL(started.url);
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/gmail/callback");
    const [nonce, verifier] = started.cookieValue.split(".");
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
    expect(sources.readState(u.searchParams.get("state")!, Date.now())).toMatchObject({ o: f.organizationId, u: f.users.admin, t: f.teamId, n: nonce });
  });

  it("is for organization admins only, at both steps", async () => {
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(sources.beginGmailConnect(f.principals[who], { teamId: f.teamId }), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(started.url).searchParams.get("state");
    await expect(sources.completeGmailConnect(f.principals.lead, { code: "c", state, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("rejects a team that is not in the organization", async () => {
    await expect(sources.beginGmailConnect(admin(), { teamId: other.teamId })).rejects.toMatchObject({ code: "team_not_found" });
    await expect(sources.beginGmailConnect(admin(), { teamId: randomUUID() })).rejects.toMatchObject({ code: "team_not_found" });
  });

  it("refuses a state that was altered, truncated or never signed", async () => {
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(started.url).searchParams.get("state")!;
    const [payload, mac] = state.split(".") as [string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), t: other.teamId })).toString("base64url");
    const attempts = [`${payload}.${mac.slice(0, -2)}AA`, `${forgedPayload}.${mac}`, payload, `${payload}.${mac}.extra`, "", "not-a-state", `${Buffer.from("{}").toString("base64url")}.${mac}`];
    for (const bad of attempts) {
      await expect(sources.completeGmailConnect(admin(), { code: "c", state: bad, providerError: null, cookieValue: started.cookieValue }), bad).rejects.toMatchObject({ code: "state_invalid" });
    }
    await expect(sources.completeGmailConnect(admin(), { code: "c", state: null, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ code: "state_invalid" });
  });

  it("refuses a state older than ten minutes", async () => {
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId }, { now: () => new Date(Date.now() - 11 * 60_000) }); // the flow began 11 minutes ago
    const state = new URL(started.url).searchParams.get("state");
    await expect(sources.completeGmailConnect(admin(), { code: "c", state, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ code: "state_expired" });
  });

  it("refuses a state started by someone else or for another organization", async () => {
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(started.url).searchParams.get("state");
    const outsider = other.principals.admin; // an admin, but of a different organization
    await expect(sources.completeGmailConnect(outsider, { code: "c", state, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ code: "wrong_user" });
  });

  it("refuses a state that was started in another organization the same person administers", async () => {
    await owner.membership.create({ data: { organizationId: other.organizationId, userId: f.users.admin, role: "ORG_ADMIN" } });
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(started.url).searchParams.get("state");
    const sameUserElsewhere: Principal = { userId: f.users.admin, organizationId: other.organizationId, orgRole: "ORG_ADMIN", teamRoles: {} }; // e.g. the org switcher changed meanwhile
    await expect(sources.completeGmailConnect(sameUserElsewhere, { code: "c", state, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ code: "wrong_user" });
    await owner.membership.deleteMany({ where: { organizationId: other.organizationId, userId: f.users.admin } });
  });

  it("refuses a state started by a different admin of the same organization", async () => {
    const second = randomUUID();
    await owner.user.create({ data: { id: second, email: `u-${second}@synthetic.loopsignal.test` } });
    await owner.membership.create({ data: { organizationId: f.organizationId, userId: second, role: "ORG_ADMIN" } });
    const started = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(started.url).searchParams.get("state");
    const colleague: Principal = { userId: second, organizationId: f.organizationId, orgRole: "ORG_ADMIN", teamRoles: {} };
    await expect(sources.completeGmailConnect(colleague, { code: "c", state, providerError: null, cookieValue: started.cookieValue })).rejects.toMatchObject({ code: "wrong_user" });
    await owner.membership.deleteMany({ where: { userId: second } });
    await owner.user.delete({ where: { id: second } });
  });

  it("refuses a callback from a browser that did not start the flow (missing or different cookie)", async () => {
    const a = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const b = await sources.beginGmailConnect(admin(), { teamId: f.teamId });
    const state = new URL(a.url).searchParams.get("state");
    for (const cookieValue of [null, "", "justonepart", b.cookieValue, `${a.cookieValue.split(".")[0]}`]) {
      await expect(sources.completeGmailConnect(admin(), { code: "c", state, providerError: null, cookieValue }), String(cookieValue)).rejects.toMatchObject({ code: "state_invalid" });
    }
  });

  it("creates nothing when the admin denies access, no lasting access is issued, or the read scope is missing", async () => {
    const before = await owner.sourceConnection.count({ where: { organizationId: f.organizationId } });
    for (const [mode, code] of [["deny", "denied"], ["no_refresh", "no_refresh_token"], ["wrong_scope", "scope_missing"]] as const) {
      fake.nextConsent = mode;
      await expect(connect(), mode).rejects.toMatchObject({ code });
    }
    expect(await owner.sourceConnection.count({ where: { organizationId: f.organizationId } })).toBe(before);
  });

  it("cannot be completed twice with the same code", async () => {
    const mailbox = newMailbox();
    const c = await connect(admin(), mailbox);
    await expect(sources.completeGmailConnect(admin(), { code: c.back.searchParams.get("code"), state: c.back.searchParams.get("state"), providerError: null, cookieValue: c.started.cookieValue })).rejects.toMatchObject({ name: "ProviderAuthError" });
    expect(await owner.monitoredSource.count({ where: { organizationId: f.organizationId, externalId: mailbox } })).toBe(1);
  });

  it("reconnecting a mailbox keeps its source and its sync position instead of creating a second one", async () => {
    const mailbox = newMailbox();
    const first = await connect(admin(), mailbox);
    await owner.monitoredSource.update({ where: { id: first.monitoredSourceId }, data: { cursor: "h.42" } });
    expect(await sources.disconnectGmail(admin(), first.connectionId)).toBe("DISCONNECTED");
    const again = await connect(admin(), mailbox, f.otherTeamId);
    expect(again).toMatchObject({ connectionId: first.connectionId, monitoredSourceId: first.monitoredSourceId, reconnected: true });
    expect(await owner.monitoredSource.findUniqueOrThrow({ where: { id: first.monitoredSourceId } })).toMatchObject({ enabled: true, cursor: "h.42", teamId: f.otherTeamId });
    expect((await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: first.connectionId } } })).status).toBe("ACTIVE");
    expect(await owner.connectionCredential.count({ where: { connectionId: first.connectionId } })).toBe(1);
  });
});

describe("stored credentials", () => {
  it("are encrypted, and bound to their own organization and connection", async () => {
    const c = await connect();
    const row = await credentialRow(c.connectionId);
    const raw = Buffer.from(row.tokens);
    const tokens = JSON.parse(decryptField(row.tokens, testKey, aad(f.organizationId, c.connectionId))) as { accessToken: string; refreshToken: string };
    SECRETS.add(tokens.accessToken); SECRETS.add(tokens.refreshToken);
    expect(raw.includes(Buffer.from(tokens.accessToken))).toBe(false);
    expect(raw.includes(Buffer.from(tokens.refreshToken))).toBe(false);
    expect(() => decryptField(row.tokens, testKey, aad(f.organizationId, randomUUID()))).toThrow("Field decryption failed");
    expect(() => decryptField(row.tokens, testKey, aad(other.organizationId, c.connectionId))).toThrow("Field decryption failed");
  });

  it("cannot be moved to another connection: a copied blob fails instead of authenticating as someone else", async () => {
    const a = await connect();
    const b = await connect();
    const stolen = (await credentialRow(a.connectionId)).tokens;
    await owner.connectionCredential.updateMany({ where: { connectionId: b.connectionId }, data: { tokens: stolen } });
    await expect(sources.getAccessToken(f.organizationId, b.connectionId)).rejects.toThrow("Field decryption failed");
  });

  it("uses the stored access token while it is fresh, and refreshes it shortly before it expires", async () => {
    const c = await connect();
    const first = await sources.getAccessToken(f.organizationId, c.connectionId);
    const calls = fake.count("/token");
    expect(await sources.getAccessToken(f.organizationId, c.connectionId)).toBe(first);
    expect(fake.count("/token")).toBe(calls); // no refresh
    const nearExpiry = () => new Date(Date.now() + 3600_000 - 60_000); // one minute left
    const refreshed = await sources.getAccessToken(f.organizationId, c.connectionId, { now: nearExpiry });
    expect(refreshed).not.toBe(first);
    expect(fake.count("/token")).toBe(calls + 1);
    expect(await sources.getAccessToken(f.organizationId, c.connectionId)).toBe(refreshed); // the new token was stored
    SECRETS.add(first); SECRETS.add(refreshed);
  });

  it("fails closed when there are none", async () => {
    await expect(sources.getAccessToken(f.organizationId, randomUUID())).rejects.toMatchObject({ name: "ProviderAuthError" });
  });

  it("are invisible to another organization at the database level", async () => {
    const c = await connect();
    expect(await withTenant({ organizationId: other.organizationId }, (tx) => tx.connectionCredential.findMany())).toEqual([]);
    expect(await withTenant({ organizationId: f.organizationId }, (tx) => tx.connectionCredential.count({ where: { connectionId: c.connectionId } }))).toBe(1);
    await expect(sources.getAccessToken(other.organizationId, c.connectionId)).rejects.toMatchObject({ name: "ProviderAuthError" });
  });

  it("are protected by row-level security itself, with no application scoping in between", async () => {
    const c = await connect();
    const raw = createPrismaClient(process.env["APP_DATABASE_URL"]!); // the app's database role, without the tenant layer
    try {
      const as = <T>(organizationId: string | null, fn: (tx: Parameters<Parameters<typeof raw.$transaction>[0]>[0]) => Promise<T>) =>
        raw.$transaction(async (tx) => {
          if (organizationId) await tx.$executeRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
          return fn(tx);
        });
      expect(await as(other.organizationId, (tx) => tx.connectionCredential.findMany({ where: { connectionId: c.connectionId } }))).toEqual([]);
      expect(await as(null, (tx) => tx.connectionCredential.findMany({ where: { connectionId: c.connectionId } }))).toEqual([]); // no context: nothing
      expect((await as(other.organizationId, (tx) => tx.connectionCredential.updateMany({ where: { connectionId: c.connectionId }, data: { watchExpiresAt: new Date() } }))).count).toBe(0);
      expect((await as(other.organizationId, (tx) => tx.connectionCredential.deleteMany({ where: { connectionId: c.connectionId } }))).count).toBe(0);
      await expect(as(other.organizationId, (tx) => tx.connectionCredential.create({ data: { organizationId: f.organizationId, connectionId: c.connectionId, tokens: new Uint8Array([1]), accessTokenExpiresAt: new Date() } }))).rejects.toThrow(); // cannot write into another tenant
      expect(await as(f.organizationId, (tx) => tx.connectionCredential.count({ where: { connectionId: c.connectionId } }))).toBe(1);
    } finally {
      await raw.$disconnect();
    }
  });

  it("are never part of the connection list shown to admins", async () => {
    const c = await connect();
    const list = await sources.listGmailConnections(admin());
    const mine = list.find((x) => x.id === c.connectionId)!;
    expect(mine.sources.map((s) => s.mailbox)).toEqual([c.mailbox]);
    const text = JSON.stringify(list);
    const tokens = JSON.parse(decryptField((await credentialRow(c.connectionId)).tokens, testKey, aad(f.organizationId, c.connectionId))) as Record<string, string>;
    for (const t of Object.values(tokens)) expect(text).not.toContain(t);
    expect(text).not.toMatch(/tokens|credential/i);
    await expect(sources.listGmailConnections(f.principals.member)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect((await sources.listGmailConnections(other.principals.admin)).find((x) => x.id === c.connectionId)).toBeUndefined();
  });
});

describe("syncing a connected mailbox", () => {
  it("ingests mail through the normal pipeline: threads, direction, encrypted bodies, analysis jobs, a cursor", async () => {
    const c = await connect();
    const inbound = fake.addMessage(c.mailbox, { ...customer(1), threadId: "thread-A" });
    fake.addMessage(c.mailbox, { from: `Support <${c.mailbox}>`, subject: "Re: Request 1", text: "Thanks, we are on it.", labels: ["SENT"], threadId: "thread-A" });
    fake.addMessage(c.mailbox, { ...customer(2), text: undefined, html: "<p>Our <b>checkout</b> is down.</p>" });
    const out = await sync(c);
    expect(out).toMatchObject({ status: "SYNCED", messagesCreated: 3, malformed: 0, payloadConflicts: 0, resyncs: 0, hasMore: false });

    const messages = await owner.message.findMany({ where: { monitoredSourceId: c.monitoredSourceId }, orderBy: { sentAt: "asc" } });
    expect(messages.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND", "INBOUND"]);
    expect(new Set(messages.slice(0, 2).map((m) => m.threadId)).size).toBe(1); // same Gmail thread, one conversation
    expect(messages[0]!.provider).toBe("GMAIL");
    expect(decryptField(messages[0]!.bodyText, testKey, `${f.organizationId}:Message.bodyText`)).toBe("Please help with matter 1.");
    expect(decryptField(messages[2]!.bodyText, testKey, `${f.organizationId}:Message.bodyText`)).toBe("Our checkout is down.");
    expect((await owner.thread.findUniqueOrThrow({ where: { id: messages[0]!.threadId } })).externalThreadId).toBe("thread-A");
    expect(messages.find((m) => m.externalMessageId === inbound.id)).toBeTruthy();
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: c.monitoredSourceId } })).cursor).toBe(`h.${fake.mailbox(c.mailbox).historyId}`);
    const jobs = await waitingJobs(hub, QUEUES.analyzeMessage);
    for (const m of messages) expect(jobs.some((j) => j.data.messageId === m.id)).toBe(true);
    for (const j of jobs) expect(Object.keys(j.data).sort()).toEqual(["messageId", "organizationId"]);
  });

  it("stores the raw event without volatile fields", async () => {
    const c = await connect();
    const m = fake.addMessage(c.mailbox, customer(1));
    await sync(c);
    const raw = await owner.rawEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, provider: "GMAIL", externalId: m.id } });
    const payload = JSON.parse(decryptField(raw.payload, testKey, `${f.organizationId}:RawEvent.payload`)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["from", "hasAttachments", "id", "mailbox", "sent", "sentAtMs", "subject", "text", "threadId", "v"]);
  });

  it("is safe to repeat: re-reading everything creates no duplicates, conflicts or raw events, even after labels changed", async () => {
    const c = await connect();
    const a = fake.addMessage(c.mailbox, customer(1));
    fake.addMessage(c.mailbox, customer(2));
    await sync(c);
    const counts = async () => [await owner.message.count({ where: { monitoredSourceId: c.monitoredSourceId } }), await owner.rawEvent.count({ where: { organizationId: f.organizationId, externalId: { in: fake.mailbox(c.mailbox).messages.map((m) => m.id) } } }), await owner.thread.count({ where: { organizationId: f.organizationId, provider: "GMAIL", externalThreadId: { in: fake.mailbox(c.mailbox).messages.map((m) => m.threadId) } } })];
    const before = await counts();
    a.labels = ["INBOX", "STARRED"]; // read and starred since
    await owner.monitoredSource.update({ where: { id: c.monitoredSourceId }, data: { cursor: null } }); // forget our position: read it all again
    expect(await sync(c)).toMatchObject({ messagesCreated: 0, messagesExisting: 2, payloadConflicts: 0, malformed: 0 });
    expect(await counts()).toEqual(before);
  });

  it("picks up only new mail on the next sync", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    await sync(c);
    expect(await sync(c)).toMatchObject({ events: 0, messagesCreated: 0 });
    fake.addMessage(c.mailbox, customer(2));
    fake.addMessage(c.mailbox, customer(3));
    expect(await sync(c)).toMatchObject({ events: 2, messagesCreated: 2 });
  });

  it("recovers from a history gap: resyncs the recent window, creates no duplicates and keeps going", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    await sync(c);
    const missed = fake.addMessage(c.mailbox, customer(2)); // arrives while our position is about to be forgotten
    fake.expireHistory(c.mailbox);
    const out = await sync(c);
    expect(out).toMatchObject({ resyncs: 1, messagesCreated: 1, messagesExisting: 1, payloadConflicts: 0 });
    expect(await owner.message.count({ where: { monitoredSourceId: c.monitoredSourceId, externalMessageId: missed.id } })).toBe(1);
    expect(await sync(c)).toMatchObject({ resyncs: 0, events: 0 });
    fake.addMessage(c.mailbox, customer(3));
    expect(await sync(c)).toMatchObject({ messagesCreated: 1 });
  });

  it("refreshes an expired access token by itself and carries on", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    fake.expireAccessTokens(); // Google now rejects the stored token
    const refreshes = fake.count("/token");
    expect(await sync(c)).toMatchObject({ status: "SYNCED", messagesCreated: 1 });
    expect(fake.count("/token")).toBeGreaterThan(refreshes);
  });

  it("stops and flags the connection when Google refuses the credentials for good, without retrying", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    fake.expireAccessTokens();
    fake.revokeRefreshTokens(c.mailbox); // the user removed our access in their Google account
    const { handleIngestSourceJob } = await import("@/modules/ingestion");
    const out = await handleIngestSourceJob({ organizationId: f.organizationId, monitoredSourceId: c.monitoredSourceId }, { hub, fieldKey: testKey });
    expect(out).toMatchObject({ status: "SKIPPED", reason: "CONNECTION_INACTIVE" });
    expect((await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.connectionId } } })).status).toBe("ERROR");
    expect(await owner.message.count({ where: { monitoredSourceId: c.monitoredSourceId } })).toBe(0);
    const audits = await owner.auditLog.findMany({ where: { organizationId: f.organizationId, action: "connection.auth_failed", entityId: c.connectionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "SYSTEM", metadata: { reason: "invalid_grant" } });
    expect(await sync(c)).toMatchObject({ status: "SKIPPED", reason: "CONNECTION_INACTIVE" }); // later syncs skip it quietly
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "connection.auth_failed", entityId: c.connectionId } })).toBe(1); // flagged once
    expect((await sources.listGmailConnections(admin())).find((x) => x.id === c.connectionId)!.status).toBe("ERROR");
  });

  it("leaves the cursor and the data untouched when Google is down", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    await sync(c);
    const cursor = (await owner.monitoredSource.findUniqueOrThrow({ where: { id: c.monitoredSourceId } })).cursor;
    fake.addMessage(c.mailbox, customer(2));
    fake.failNext(/\/history$/, 400, 1); // a request Gmail rejects: surfaces as an error, not as silent loss
    await expect(sync(c)).rejects.toMatchObject({ name: "ProviderApiError" });
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: c.monitoredSourceId } })).cursor).toBe(cursor);
    expect(await sync(c)).toMatchObject({ messagesCreated: 1 }); // the next run picks the message up
  });

  it("keeps two organizations that watch the same address apart", async () => {
    const mailbox = newMailbox();
    const a = await connect(admin(), mailbox);
    const b = await connect(other.principals.admin, mailbox, other.teamId);
    fake.addMessage(mailbox, customer(1));
    await sync(a);
    await sync(b, other);
    expect(await owner.message.count({ where: { organizationId: f.organizationId, monitoredSourceId: a.monitoredSourceId } })).toBe(1);
    expect(await owner.message.count({ where: { organizationId: other.organizationId, monitoredSourceId: b.monitoredSourceId } })).toBe(1);
    expect(await withTenant({ organizationId: f.organizationId }, (tx) => tx.message.count({ where: { monitoredSourceId: b.monitoredSourceId } }))).toBe(0);
  });
});

describe("disconnecting", () => {
  it("revokes at Google, deletes the credentials, stops syncing, keeps the collected mail and is audited", async () => {
    const c = await connect();
    fake.addMessage(c.mailbox, customer(1));
    await sync(c);
    const refresh = (JSON.parse(decryptField((await credentialRow(c.connectionId)).tokens, testKey, aad(f.organizationId, c.connectionId))) as { refreshToken: string }).refreshToken;

    expect(await sources.disconnectGmail(admin(), c.connectionId)).toBe("DISCONNECTED");
    expect(fake.revoked.has(refresh)).toBe(true);
    expect(await owner.connectionCredential.count({ where: { connectionId: c.connectionId } })).toBe(0);
    expect((await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.connectionId } } })).status).toBe("REVOKED");
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: c.monitoredSourceId } })).enabled).toBe(false);
    expect(await owner.message.count({ where: { monitoredSourceId: c.monitoredSourceId } })).toBe(1);
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "connection.disconnected", entityId: c.connectionId } })).toMatchObject({ actorId: f.users.admin, metadata: { revokedAtProvider: true } });
    expect(await sync(c)).toMatchObject({ status: "SKIPPED", reason: "SOURCE_DISABLED" });
    expect(await sources.disconnectGmail(admin(), c.connectionId)).toBe("ALREADY_DISCONNECTED");
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "connection.disconnected", entityId: c.connectionId } })).toBe(1);
  });

  it("still removes our copy when Google cannot be reached to revoke", async () => {
    const c = await connect();
    const { createGoogleClient, googleEndpoints } = await import("@/modules/integrations");
    const client = createGoogleClient({ endpoints: googleEndpoints(fake.baseUrl), clientId: fake.clientId, clientSecret: fake.clientSecret, sleep: async () => undefined, baseDelayMs: 1 });
    fake.failNext(/\/revoke$/, 500, 10);
    expect(await sources.disconnectGmail(admin(), c.connectionId, { client })).toBe("DISCONNECTED");
    expect(await owner.connectionCredential.count({ where: { connectionId: c.connectionId } })).toBe(0);
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "connection.disconnected", entityId: c.connectionId } })).toMatchObject({ metadata: { revokedAtProvider: false } });
  });

  it("is for admins of that organization only", async () => {
    const c = await connect();
    await expect(sources.disconnectGmail(f.principals.lead, c.connectionId)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await sources.disconnectGmail(other.principals.admin, c.connectionId)).toBe("NOT_FOUND"); // another tenant cannot even see it
    expect((await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.connectionId } } })).status).toBe("ACTIVE");
    expect(await sources.disconnectGmail(admin(), randomUUID())).toBe("NOT_FOUND");
  });
});

describe("push watch", () => {
  const watchRow = async (connectionId: string) => (await credentialRow(connectionId)).watchExpiresAt;

  it("registers a watch for a connection that has none, and records when it lapses", async () => {
    const c = await connect();
    const before = fake.watches.length;
    const summary = await sources.renewDueWatches(f.organizationId);
    expect(summary.renewed).toBeGreaterThanOrEqual(1);
    expect(fake.watches.slice(before).some((w) => w.mailbox === c.mailbox && w.topic === "projects/synthetic-project/topics/gmail-push")).toBe(true);
    const lapses = (await watchRow(c.connectionId))!;
    expect(lapses.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
  });

  it("leaves a healthy watch alone and renews one with less than a day left", async () => {
    const c = await connect();
    await sources.renewDueWatches(f.organizationId);
    const calls = () => fake.watches.filter((w) => w.mailbox === c.mailbox).length;
    const once = calls();
    await sources.renewDueWatches(f.organizationId);
    expect(calls()).toBe(once);
    await owner.connectionCredential.updateMany({ where: { connectionId: c.connectionId }, data: { watchExpiresAt: new Date(Date.now() + 3_600_000) } });
    await sources.renewDueWatches(f.organizationId);
    expect(calls()).toBe(once + 1);
    expect((await watchRow(c.connectionId))!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
  });

  it("one failing connection neither stops the others nor goes unnoticed", async () => {
    const good = await connect();
    const bad = await connect();
    await owner.connectionCredential.updateMany({ where: { connectionId: { in: [good.connectionId, bad.connectionId] } }, data: { watchExpiresAt: null } });
    fake.expireAccessTokens();
    fake.revokeRefreshTokens(bad.mailbox);
    const summary = await sources.renewDueWatches(f.organizationId);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(await watchRow(good.connectionId)).not.toBeNull();
    expect((await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: bad.connectionId } } })).status).toBe("ERROR");
    expect(logged.some((l) => l.includes("gmail.watch_renewal_failed"))).toBe(true);
  });
});

describe("scheduled scan", () => {
  const ingestJobsFor = async (monitoredSourceId: string) => (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => j.data.monitoredSourceId === monitoredSourceId);

  it("queues a sync for every active mailbox once per interval, and skips mailboxes that need attention", async () => {
    const live = await connect();
    const dead = await connect();
    await owner.sourceConnection.update({ where: { organizationId_id: { organizationId: f.organizationId, id: dead.connectionId } }, data: { status: "ERROR" } });
    const now = () => new Date(Date.UTC(2026, 10, 9, 12, 0, 5));
    const first = await handleGmailScan({ hub, now });
    expect(first.failures).toBe(0);
    expect(await ingestJobsFor(live.monitoredSourceId)).toHaveLength(1);
    expect(await ingestJobsFor(dead.monitoredSourceId)).toHaveLength(0);
    await handleGmailScan({ hub, now });
    expect(await ingestJobsFor(live.monitoredSourceId)).toHaveLength(1); // same interval: deduplicated
    await handleGmailScan({ hub, now: () => new Date(now().getTime() + 200_000) });
    expect(await ingestJobsFor(live.monitoredSourceId)).toHaveLength(2); // next interval: a new sync
  });

  it("also registers push watches that are due", async () => {
    const c = await connect();
    await handleGmailScan({ hub });
    expect(await owner.connectionCredential.findFirstOrThrow({ where: { connectionId: c.connectionId } })).toMatchObject({ watchExpiresAt: expect.any(Date) });
  });
});

describe("push notifications from Pub/Sub", () => {
  const body = (emailAddress: string, historyId: string | number = 5000) => ({ message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64"), messageId: "1" }, subscription: "projects/p/subscriptions/s" });
  const push = (b: unknown, token: string | null = fake.pushToken()) => sources.handleGmailPush({ authorization: token ? `Bearer ${token}` : null, body: b }, { hub, keys: fakeKeys() });
  const queuedFor = async (sourceId: string) => (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => j.data.monitoredSourceId === sourceId);

  it("queues a sync of the mailbox's source and carries only ids", async () => {
    const c = await connect();
    expect(await push(body(c.mailbox.toUpperCase(), 7001))).toEqual({ status: 204, queued: 1 });
    const jobs = await queuedFor(c.monitoredSourceId);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0]!.data).sort()).toEqual(["monitoredSourceId", "organizationId"]);
    expect(JSON.stringify(jobs[0]!.data)).not.toContain(c.mailbox);
  });

  it("collapses duplicates of the same notification and queues a new one for a new history position", async () => {
    const c = await connect();
    await push(body(c.mailbox, 7100));
    await push(body(c.mailbox, 7100));
    expect(await queuedFor(c.monitoredSourceId)).toHaveLength(1);
    await push(body(c.mailbox, 7101));
    expect(await queuedFor(c.monitoredSourceId)).toHaveLength(2);
  });

  it("rejects anything without a valid Google-signed token, before reading the body, and queues nothing", async () => {
    const c = await connect();
    const bad: Array<string | null> = [
      null, "garbage", fake.pushToken({ aud: "https://other.test" }), fake.pushToken({ email: "attacker@evil.test" }),
      fake.pushToken({ exp: Math.floor(Date.now() / 1000) - 7200 }), fake.pushToken({}, { tamper: true }), fake.pushToken({}, { kid: "nope" }),
    ];
    for (const token of bad) expect(await push(body(c.mailbox), token), String(token)).toEqual({ status: 401 });
    expect(await sources.handleGmailPush({ authorization: "Basic abc", body: body(c.mailbox) }, { hub, keys: fakeKeys() })).toEqual({ status: 401 });
    expect(await queuedFor(c.monitoredSourceId)).toHaveLength(0);
  });

  it("acknowledges a mailbox it does not know, without queueing or revealing that", async () => {
    expect(await push(body("nobody@nowhere.test"))).toEqual({ status: 204, queued: 0 });
  });

  it("ignores mailboxes that are disconnected or need attention", async () => {
    const c = await connect();
    await owner.sourceConnection.update({ where: { organizationId_id: { organizationId: f.organizationId, id: c.connectionId } }, data: { status: "ERROR" } });
    expect(await push(body(c.mailbox, 7200))).toEqual({ status: 204, queued: 0 });
    const d = await connect();
    await sources.disconnectGmail(admin(), d.connectionId);
    expect(await push(body(d.mailbox, 7201))).toEqual({ status: 204, queued: 0 });
  });

  it("answers 400 to a malformed notification", async () => {
    for (const b of [null, {}, { message: {} }, { message: { data: "" } }, { message: { data: Buffer.from("not json").toString("base64") } }, body("not-an-email"), { message: { data: Buffer.from(JSON.stringify({ emailAddress: "a@b.test", historyId: "x; drop table" })).toString("base64") } }]) {
      expect(await push(b), JSON.stringify(b)).toEqual({ status: 400 });
    }
  });

  it("wakes every organization that watches the same mailbox, each under its own context", async () => {
    const mailbox = newMailbox();
    const a = await connect(admin(), mailbox);
    const b = await connect(other.principals.admin, mailbox, other.teamId);
    expect(await push(body(mailbox, 7300))).toEqual({ status: 204, queued: 2 });
    expect(await queuedFor(a.monitoredSourceId)).toHaveLength(1);
    expect(await queuedFor(b.monitoredSourceId)).toHaveLength(1);
  });
});

describe("secrets stay out of everything we write", () => {
  it("no token, code or secret appears in logs, audit rows or queued jobs", async () => {
    const c = await connect();
    const tokens = JSON.parse(decryptField((await credentialRow(c.connectionId)).tokens, testKey, aad(f.organizationId, c.connectionId))) as Record<string, string>;
    for (const t of Object.values(tokens)) SECRETS.add(t);
    SECRETS.add(fake.clientSecret);
    fake.addMessage(c.mailbox, customer(1));
    fake.expireAccessTokens();
    await sync(c);
    await sources.renewDueWatches(f.organizationId);
    await handleGmailScan({ hub });

    expect(SECRETS.size).toBeGreaterThan(4);
    const everything = logged.join("\n");
    const audit = JSON.stringify(await owner.auditLog.findMany({ where: { organizationId: { in: [f.organizationId, other.organizationId] } }, select: { metadata: true, action: true } }));
    const jobs = JSON.stringify((await Promise.all([QUEUES.ingestSource, QUEUES.analyzeMessage, QUEUES.gmailScan].map((q) => hub.queue(q).getJobs()))).flat().map((j) => j.data));
    const raw = JSON.stringify(await owner.rawEvent.findMany({ where: { organizationId: f.organizationId }, select: { payloadHash: true, externalId: true } }));
    for (const secret of SECRETS) for (const [where, text] of Object.entries({ logs: everything, audit, jobs, raw })) expect(text, `${where} leaks a secret`).not.toContain(secret);
    expect(everything).not.toContain("Please help with matter"); // and message content never reaches a log either
    expect(canonicalJson({})).toBe("{}");
  });
});
