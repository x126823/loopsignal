import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Google Chat is off unless configured, and the environment is read lazily on first use: set it before anything runs. The fake Google
// below stands in for every Google endpoint, so no real credential, space or message is ever involved (CLAUDE.md rule 7).
const fake = new (await import("../helpers/fake-google")).FakeGoogle();
await fake.start();
const SA_JSON = fake.serviceAccountJson();
Object.assign(process.env, { GOOGLE_CHAT_ENABLED: "true", GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_TEST_BASE_URL: fake.baseUrl });

const { createPrismaClient, withTenant } = await import("@/lib/db");
const { decryptField } = await import("@/lib/crypto/fields");
const { QUEUES } = await import("@/lib/queue");
const { handleIngestSourceJob, linkChatPerson, listChatPeople } = await import("@/modules/ingestion");
const { CHAT_APP_MESSAGES_READONLY_SCOPE, createChatClient, createServiceAccountTokens, googleEndpoints, parseServiceAccountKey, ProviderSourceUnavailableError } = await import("@/modules/integrations");
const sources = await import("@/modules/sources");
const { handleChatScan } = await import("@/workers/chat-scan");
const { createEngineFixture } = await import("../helpers/engine-fixture");
const { purgeOrgs, testKey } = await import("../helpers/fixtures");
const { createTestHub, destroyTestHub, waitingJobs } = await import("../helpers/queue");
type Principal = import("@/modules/identity").Principal;
type QueueHub = import("@/lib/queue").QueueHub;

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: Awaited<ReturnType<typeof createEngineFixture>>;
let other: Awaited<ReturnType<typeof createEngineFixture>>;
let hub: QueueHub;
const logged: string[] = [];
const admin = () => f.principals.admin;
const newSpace = () => `spaces/T${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const CODE = /^LS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

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
  fake.rejectServiceAccount = false;
  fake.chatUnavailableStatus = 404;
});

/** Request a claim, add the app to the space, post the code there. */
async function claim(p: Principal = admin(), space = newSpace(), team = f.teamId) {
  const started = await sources.startSpaceClaim(p, { space, teamId: team });
  return { ...started, space };
}
async function bind(p: Principal = admin(), space = newSpace(), org = f) {
  fake.addChatSpace(space, true);
  const c = await claim(p, space, org.teamId);
  fake.addChatMessage(space, { text: `Connecting this space: ${c.code}` });
  const out = await sources.verifySpaceClaim(p, c.claimId);
  if (out.outcome !== "VERIFIED") throw new Error(`bind failed: ${out.outcome}`);
  return { ...c, monitoredSourceId: out.monitoredSourceId };
}
const sync = (monitoredSourceId: string, org = f) => handleIngestSourceJob({ organizationId: org.organizationId, monitoredSourceId }, { hub, fieldKey: testKey });
const sourceRow = (id: string) => owner.monitoredSource.findUniqueOrThrow({ where: { id } });

describe("requesting a space", () => {
  it("returns a readable one-time code, keeps it encrypted, and audits the request without the code or the space", async () => {
    fake.addChatSpace("spaces/AAAA1111", true);
    const c = await claim(admin(), "spaces/AAAA1111");
    expect(c.code).toMatch(CODE);
    expect(c.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const row = await owner.sourceClaim.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.claimId } } });
    expect(Buffer.from(row.code).includes(Buffer.from(c.code))).toBe(false);
    expect(decryptField(row.code, testKey, `${f.organizationId}:SourceClaim.code`)).toBe(c.code);
    expect(() => decryptField(row.code, testKey, `${other.organizationId}:SourceClaim.code`)).toThrow("Field decryption failed");
    expect(row).toMatchObject({ provider: "GOOGLE_CHAT", externalId: "spaces/AAAA1111", status: "PENDING", teamId: f.teamId, createdByUserId: f.users.admin });
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "connection.chat_claim_started", entityId: c.claimId } });
    expect(JSON.stringify(audit.metadata)).not.toContain(c.code);
    expect(JSON.stringify(audit.metadata)).not.toContain("AAAA1111");
  });

  it("accepts a bare id, a spaces/ name or a Chat link, and nothing else", () => {
    expect(sources.parseSpace("AAAAx1")).toBe("spaces/AAAAx1");
    expect(sources.parseSpace(" spaces/AAAAx1 ")).toBe("spaces/AAAAx1");
    expect(sources.parseSpace("https://chat.google.com/room/AAAAx1?cls=7")).toBe("spaces/AAAAx1");
    expect(sources.parseSpace("https://chat.google.com/space/AAAAx1")).toBe("spaces/AAAAx1");
    for (const bad of ["", "spaces/", "spaces/a/b", "spaces/a?x=1", "../etc", "javascript:alert(1)", "https://evil.example/room/AAAA", "https://chat.google.com.evil.example/room/AAAA", "a b", "spaces/" + "a".repeat(200)]) {
      expect(() => sources.parseSpace(bad), bad).toThrow(sources.ChatClaimError);
    }
  });

  it("is for organization admins only, and only for a team of that organization", async () => {
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(sources.startSpaceClaim(f.principals[who], { space: newSpace(), teamId: f.teamId }), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    await expect(sources.startSpaceClaim(admin(), { space: newSpace(), teamId: other.teamId })).rejects.toMatchObject({ code: "team_not_found" });
    await expect(sources.startSpaceClaim(admin(), { space: "not a space", teamId: f.teamId })).rejects.toMatchObject({ code: "invalid_space" });
  });

  it("a newer request for the same space replaces the older one", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const first = await claim(admin(), space);
    const second = await claim(admin(), space);
    fake.addChatMessage(space, { text: first.code });
    expect(await sources.verifySpaceClaim(admin(), first.claimId)).toEqual({ outcome: "NOT_PENDING" });
    expect((await sources.listChatSpaces(admin())).pending.filter((p) => p.space === space).map((p) => p.id)).toEqual([second.claimId]);
    expect((await sources.verifySpaceClaim(admin(), second.claimId)).outcome).toBe("CODE_NOT_SEEN"); // the old code does not prove the new request
  });

  it("refuses a space this organization already has connected", async () => {
    const b = await bind();
    await expect(sources.startSpaceClaim(admin(), { space: b.space, teamId: f.teamId })).rejects.toMatchObject({ code: "already_bound" });
  });
});

describe("proving a space", () => {
  it("connects the space once its code is found, creating the connection and source for the chosen team", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const c = await claim(admin(), space, f.otherTeamId);
    fake.addChatMessage(space, { text: "Hello everyone" });
    expect((await sources.verifySpaceClaim(admin(), c.claimId)).outcome).toBe("CODE_NOT_SEEN");
    expect(await owner.monitoredSource.count({ where: { organizationId: f.organizationId, externalId: space } })).toBe(0);

    fake.addChatMessage(space, { text: `Please connect this space. ${c.code} thanks!` });
    const out = await sources.verifySpaceClaim(admin(), c.claimId);
    expect(out.outcome).toBe("VERIFIED");
    const src = await sourceRow((out as { monitoredSourceId: string }).monitoredSourceId);
    expect(src).toMatchObject({ kind: "SPACE", externalId: space, teamId: f.otherTeamId, enabled: true, cursor: null });
    const conn = await owner.sourceConnection.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: src.connectionId } } });
    expect(conn).toMatchObject({ provider: "GOOGLE_CHAT", status: "ACTIVE", scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE] });
    expect(await owner.connectionCredential.count({ where: { connectionId: conn.id } })).toBe(0); // no per-customer secret exists
    expect((await owner.sourceClaim.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: c.claimId } } })).status).toBe("VERIFIED");
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "connection.chat_space_bound", entityId: src.id } });
    expect(audit).toMatchObject({ actorId: f.users.admin });
    expect(JSON.stringify(audit.metadata)).not.toContain(c.code);
    expect(await sources.verifySpaceClaim(admin(), c.claimId)).toEqual({ outcome: "NOT_PENDING" });
  });

  it("reuses one connection for every space of the organization", async () => {
    const a = await bind();
    const b = await bind();
    expect((await sourceRow(a.monitoredSourceId)).connectionId).toBe((await sourceRow(b.monitoredSourceId)).connectionId);
  });

  it("does not accept a different code, or a lookalike", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const c = await claim(admin(), space);
    for (const text of [sources.makeClaimCode(), c.code.toLowerCase(), c.code.replace("LS-", "LS"), `${c.code.slice(0, -1)}`, `x${c.code}x`.replace("xLS", "xLS")]) {
      fake.addChatMessage(space, { text });
    }
    expect((await sources.verifySpaceClaim(admin(), c.claimId)).outcome).toBe("CODE_NOT_SEEN");
  });

  it("says plainly when the app cannot read the space, whichever status Google uses, and keeps the request open", async () => {
    const space = newSpace();
    fake.addChatSpace(space, false);
    const c = await claim(admin(), space);
    for (const status of [404, 403]) {
      fake.chatUnavailableStatus = status;
      expect((await sources.verifySpaceClaim(admin(), c.claimId)).outcome, String(status)).toBe("APP_NOT_IN_SPACE");
    }
    expect((await sources.verifySpaceClaim(admin(), (await claim(admin(), "spaces/neverheardof")).claimId)).outcome).toBe("APP_NOT_IN_SPACE");
    fake.addChatSpace(space, true); // the app is added
    fake.addChatMessage(space, { text: c.code });
    expect((await sources.verifySpaceClaim(admin(), c.claimId)).outcome).toBe("VERIFIED"); // the same request still works
  });

  it("expires after a day", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const c = await claim(admin(), space);
    fake.addChatMessage(space, { text: c.code });
    expect((await sources.verifySpaceClaim(admin(), c.claimId, { now: () => new Date(Date.now() + 25 * 3_600_000) })).outcome).toBe("EXPIRED");
    expect((await sources.listChatSpaces(admin(), { now: () => new Date(Date.now() + 25 * 3_600_000) })).pending.find((p) => p.id === c.claimId)).toBeUndefined();
    expect(await owner.monitoredSource.count({ where: { organizationId: f.organizationId, externalId: space } })).toBe(0);
  });

  it("is for admins of the claiming organization only", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const c = await claim(admin(), space);
    fake.addChatMessage(space, { text: c.code });
    await expect(sources.verifySpaceClaim(f.principals.lead, c.claimId)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await sources.verifySpaceClaim(other.principals.admin, c.claimId)).toEqual({ outcome: "NOT_FOUND" }); // another tenant cannot see it
    expect(await sources.verifySpaceClaim(admin(), randomUUID())).toEqual({ outcome: "NOT_FOUND" });
    await expect(sources.listChatSpaces(f.principals.member)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect((await sources.listChatSpaces(other.principals.admin)).pending.find((p) => p.id === c.claimId)).toBeUndefined();
  });
});

describe("one space, one organization", () => {
  it("refuses a second organization that proves the same space while the first holds it, and frees it when the first lets go", async () => {
    const a = await bind(admin());
    const c = await claim(other.principals.admin, a.space, other.teamId); // allowed to ASK: it cannot see who holds it
    fake.addChatMessage(a.space, { text: c.code });
    expect(await sources.verifySpaceClaim(other.principals.admin, c.claimId)).toEqual({ outcome: "ALREADY_BOUND" });
    expect(await owner.monitoredSource.count({ where: { organizationId: other.organizationId, externalId: a.space } })).toBe(0);

    expect(await sources.removeChatSpace(admin(), a.monitoredSourceId)).toBe("REMOVED");
    const out = await sources.verifySpaceClaim(other.principals.admin, c.claimId);
    expect(out.outcome).toBe("VERIFIED");
  });

  it("lets exactly one of two organizations win when both prove the same space at the same moment", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const a = await claim(admin(), space);
    const b = await claim(other.principals.admin, space, other.teamId);
    fake.addChatMessage(space, { text: a.code });
    fake.addChatMessage(space, { text: b.code });
    const results = await Promise.all([sources.verifySpaceClaim(admin(), a.claimId), sources.verifySpaceClaim(other.principals.admin, b.claimId)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["ALREADY_BOUND", "VERIFIED"]);
    expect(await owner.monitoredSource.count({ where: { externalId: space, enabled: true, connection: { provider: "GOOGLE_CHAT" } } })).toBe(1);
  });

  it("answers the binding question with a boolean only", async () => {
    const a = await bind(admin());
    const rows = await owner.$queryRaw<Array<Record<string, unknown>>>`SELECT chat_space_bound_elsewhere(${a.space}, ${randomUUID()}::uuid) AS elsewhere`;
    expect(rows).toEqual([{ elsewhere: true }]);
  });
});

describe("removing a space", () => {
  it("stops reading it, audits it, keeps the collected messages, and lets the organization connect it again", async () => {
    const b = await bind();
    fake.addChatMessage(b.space, { text: "Please help with matter 1." });
    expect((await sync(b.monitoredSourceId)).status).toBe("SYNCED");
    expect(await sources.removeChatSpace(admin(), b.monitoredSourceId)).toBe("REMOVED");
    expect((await sourceRow(b.monitoredSourceId)).enabled).toBe(false);
    expect(await owner.message.count({ where: { monitoredSourceId: b.monitoredSourceId } })).toBeGreaterThan(0);
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "connection.chat_space_removed", entityId: b.monitoredSourceId } })).toBe(1);
    expect(await sync(b.monitoredSourceId)).toMatchObject({ status: "SKIPPED", reason: "SOURCE_DISABLED" });
    expect(await sources.removeChatSpace(admin(), b.monitoredSourceId)).toBe("ALREADY_REMOVED");

    const again = await claim(admin(), b.space);
    fake.addChatMessage(b.space, { text: again.code });
    expect(await sources.verifySpaceClaim(admin(), again.claimId)).toEqual({ outcome: "VERIFIED", monitoredSourceId: b.monitoredSourceId }); // same source, same history
    expect((await sourceRow(b.monitoredSourceId)).enabled).toBe(true);
  });

  it("connecting it again can move it to a different team", async () => {
    const b = await bind();
    await sources.removeChatSpace(admin(), b.monitoredSourceId);
    const again = await claim(admin(), b.space, f.otherTeamId);
    fake.addChatMessage(b.space, { text: again.code });
    await sources.verifySpaceClaim(admin(), again.claimId);
    expect((await sourceRow(b.monitoredSourceId)).teamId).toBe(f.otherTeamId);
  });

  it("is for admins of that organization only", async () => {
    const b = await bind();
    await expect(sources.removeChatSpace(f.principals.lead, b.monitoredSourceId)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await sources.removeChatSpace(other.principals.admin, b.monitoredSourceId)).toBe("NOT_FOUND");
    expect(await sources.removeChatSpace(admin(), randomUUID())).toBe("NOT_FOUND");
    expect((await sourceRow(b.monitoredSourceId)).enabled).toBe(true);
  });
});

describe("syncing a connected space", () => {
  it("ingests messages through the normal pipeline, once, and then only what is new", async () => {
    const b = await bind();
    const thread = `${b.space}/threads/th1`;
    fake.addChatMessage(b.space, { text: "The label printer jams every third sheet.", senderId: "users/501", senderName: "Pat Customer", thread });
    fake.addChatMessage(b.space, { text: "Same here on the second floor.", senderId: "users/502", senderName: "Sam Customer", thread, threadReply: true });
    const first = await sync(b.monitoredSourceId);
    expect(first).toMatchObject({ status: "SYNCED", messagesCreated: 3, malformed: 0, payloadConflicts: 0 }); // the proof code message is a message too

    const msgs = await owner.message.findMany({ where: { monitoredSourceId: b.monitoredSourceId }, orderBy: { sentAt: "asc" } });
    expect(msgs.every((m) => m.provider === "GOOGLE_CHAT" && m.direction === "INBOUND" && (m.subject ?? "").startsWith("Chat message from "))).toBe(true);
    const printer = msgs.find((m) => decryptField(m.bodyText, testKey, `${f.organizationId}:Message.bodyText`).includes("label printer"))!;
    const same = msgs.find((m) => decryptField(m.bodyText, testKey, `${f.organizationId}:Message.bodyText`).startsWith("Same here"))!;
    expect(printer.threadId).toBe(same.threadId); // one conversation
    expect((await owner.thread.findUniqueOrThrow({ where: { id: printer.threadId } })).externalThreadId).toBe(thread);
    expect((await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: "users/501" } })).displayName).toBe("Pat Customer");
    const jobs = await waitingJobs(hub, QUEUES.analyzeMessage);
    for (const m of msgs) expect(jobs.some((j) => j.data.messageId === m.id)).toBe(true);

    expect(await sync(b.monitoredSourceId)).toMatchObject({ status: "SYNCED", events: 0, messagesCreated: 0 });
    fake.addChatMessage(b.space, { text: "A new question." });
    expect(await sync(b.monitoredSourceId)).toMatchObject({ events: 1, messagesCreated: 1 });
    expect(await owner.message.count({ where: { monitoredSourceId: b.monitoredSourceId } })).toBe(4);
  });

  it("is safe to repeat: reading everything again creates no duplicates and no conflicts", async () => {
    const b = await bind();
    fake.addChatMessage(b.space, { text: "One." });
    fake.addChatMessage(b.space, { text: "Two." });
    await sync(b.monitoredSourceId);
    const before = await owner.message.count({ where: { monitoredSourceId: b.monitoredSourceId } });
    await owner.monitoredSource.update({ where: { id: b.monitoredSourceId }, data: { cursor: null } });
    expect(await sync(b.monitoredSourceId)).toMatchObject({ messagesCreated: 0, payloadConflicts: 0, malformed: 0 });
    expect(await owner.message.count({ where: { monitoredSourceId: b.monitoredSourceId } })).toBe(before);
  });

  it("treats messages from other apps as internal, so they are never tracked as requests", async () => {
    const b = await bind();
    const bot = fake.addChatMessage(b.space, { text: "Build failed on main.", senderType: "BOT", senderId: "users/app-77" });
    await sync(b.monitoredSourceId);
    expect((await owner.message.findFirstOrThrow({ where: { monitoredSourceId: b.monitoredSourceId, externalMessageId: bot.name } })).direction).toBe("INTERNAL");
  });

  it("skips a space the app can no longer read, quietly, loses nothing, and resumes when it can", async () => {
    const b = await bind();
    fake.addChatMessage(b.space, { text: "Before." });
    await sync(b.monitoredSourceId);
    const cursor = (await sourceRow(b.monitoredSourceId)).cursor;
    fake.addChatSpace(b.space, false); // the app was removed from the space
    const during = fake.addChatMessage(b.space, { text: "While the app was out." });
    for (const status of [404, 403]) {
      fake.chatUnavailableStatus = status;
      expect(await sync(b.monitoredSourceId), String(status)).toMatchObject({ status: "SKIPPED", reason: "SOURCE_UNAVAILABLE" });
    }
    expect((await sourceRow(b.monitoredSourceId)).cursor).toBe(cursor);
    expect((await sourceRow(b.monitoredSourceId)).enabled).toBe(true); // nothing was disabled
    expect(logged.some((l) => l.includes("ingest.source_unavailable"))).toBe(true);
    fake.addChatSpace(b.space, true); // added back
    expect(await sync(b.monitoredSourceId)).toMatchObject({ status: "SYNCED", messagesCreated: 1 });
    expect(await owner.message.count({ where: { monitoredSourceId: b.monitoredSourceId, externalMessageId: during.name } })).toBe(1);
  });

  it("treats the app's own credentials being refused as every space being unavailable, and logs it as an error without any detail", async () => {
    const b = await bind();
    fake.rejectServiceAccount = true;
    const rejecting = createServiceAccountTokens({ key: parseServiceAccountKey(SA_JSON), tokenUrl: googleEndpoints(fake.baseUrl).token, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE] });
    const adapter = sources.chatAdapterFor({ organizationId: f.organizationId, connectionId: (await sourceRow(b.monitoredSourceId)).connectionId }, { chatTokens: rejecting });
    await expect(adapter.fetch({ kind: "SPACE", externalId: b.space }, null, 5)).rejects.toBeInstanceOf(ProviderSourceUnavailableError);
    const line = logged.find((l) => l.includes("chat.app_credentials_rejected"))!;
    expect(line).toContain('"level":"error"');
    expect(line).not.toMatch(/PRIVATE KEY|at-chat/);
  });
});

describe("who is on our team", () => {
  async function person(b: { space: string; monitoredSourceId: string }, address = `users/${randomUUID().slice(0, 6)}`, name = "Casey Support") {
    fake.addChatMessage(b.space, { text: "I am looking at this now.", senderId: address, senderName: name });
    await sync(b.monitoredSourceId);
    return (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address } })).id;
  }
  const dirOf = async (sourceId: string, text: string) => (await owner.message.findMany({ where: { monitoredSourceId: sourceId }, orderBy: { sentAt: "asc" } }))
    .filter((m) => decryptField(m.bodyText, testKey, `${f.organizationId}:Message.bodyText`) === text).map((m) => m.direction);

  it("starts out as INBOUND for everyone, and a linked person's NEW messages become our team's, never rewriting history", async () => {
    const b = await bind();
    const id = await person(b);
    expect(await dirOf(b.monitoredSourceId, "I am looking at this now.")).toEqual(["INBOUND"]);
    expect(await linkChatPerson(admin(), { participantId: id, userId: f.users.member })).toBe("LINKED");
    const address = (await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id } } })).address;
    fake.addChatMessage(b.space, { text: "Fixed on our side.", senderId: address });
    await sync(b.monitoredSourceId);
    expect(await dirOf(b.monitoredSourceId, "Fixed on our side.")).toEqual(["OUTBOUND"]);
    expect(await dirOf(b.monitoredSourceId, "I am looking at this now.")).toEqual(["INBOUND"]); // earlier messages are untouched
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "participant.linked", entityId: id } })).toMatchObject({ actorId: f.users.admin });

    expect(await linkChatPerson(admin(), { participantId: id, userId: null })).toBe("UNLINKED");
    fake.addChatMessage(b.space, { text: "One more thing.", senderId: address });
    await sync(b.monitoredSourceId);
    expect(await dirOf(b.monitoredSourceId, "One more thing.")).toEqual(["INBOUND"]);
    expect(await linkChatPerson(admin(), { participantId: id, userId: null })).toBe("UNCHANGED");
  });

  it("lists only people who have written in Chat, and links only to members of the organization", async () => {
    const b = await bind();
    const id = await person(b, "users/listme", "Lee Listed");
    const emailPerson = await owner.participant.create({ data: { organizationId: f.organizationId, address: `gmail-person-${randomUUID().slice(0, 6)}@customer.test`, displayName: "Gmail Person" } });
    expect((await listChatPeople(admin())).map((p) => p.id)).toContain(id);
    expect((await listChatPeople(admin())).map((p) => p.id)).not.toContain(emailPerson.id);
    expect(await linkChatPerson(admin(), { participantId: emailPerson.id, userId: f.users.member })).toBe("NOT_FOUND"); // not a Chat person
    expect(await linkChatPerson(admin(), { participantId: id, userId: other.users.member })).toBe("NOT_A_MEMBER"); // another organization's user
    expect(await linkChatPerson(admin(), { participantId: id, userId: randomUUID() })).toBe("NOT_A_MEMBER");
    expect(await linkChatPerson(admin(), { participantId: randomUUID(), userId: f.users.member })).toBe("NOT_FOUND");
    expect(await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id } } })).toMatchObject({ userId: null });
  });

  it("never makes an app's messages count as our team's: a linked bot stays INTERNAL", async () => {
    const b = await bind();
    const address = "users/app-" + randomUUID().slice(0, 5);
    fake.addChatMessage(b.space, { text: "Deploy started.", senderType: "BOT", senderId: address, senderName: "Deploy Bot" });
    await sync(b.monitoredSourceId);
    const id = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address } })).id;
    expect(await linkChatPerson(admin(), { participantId: id, userId: f.users.member })).toBe("LINKED");
    fake.addChatMessage(b.space, { text: "Deploy finished.", senderType: "BOT", senderId: address });
    await sync(b.monitoredSourceId);
    expect(await dirOf(b.monitoredSourceId, "Deploy finished.")).toEqual(["INTERNAL"]);
  });

  it("links only people who have actually written in a Chat space, whatever their address looks like", async () => {
    const quiet = await owner.participant.create({ data: { organizationId: f.organizationId, address: `users/quiet${randomUUID().slice(0, 5)}`, displayName: "Never Wrote" } });
    expect(await linkChatPerson(admin(), { participantId: quiet.id, userId: f.users.member })).toBe("NOT_FOUND"); // looks like a Chat id, has no Chat message
    const b = await bind();
    const emailLike = await owner.participant.create({ data: { organizationId: f.organizationId, address: `odd-${randomUUID().slice(0, 5)}@customer.test`, displayName: "Odd Address" } });
    const thread = await owner.thread.create({ data: { organizationId: f.organizationId, provider: "GOOGLE_CHAT", externalThreadId: `t-${randomUUID()}` } });
    await owner.message.create({ data: { organizationId: f.organizationId, monitoredSourceId: b.monitoredSourceId, threadId: thread.id, provider: "GOOGLE_CHAT", externalMessageId: `m-${randomUUID()}`, senderParticipantId: emailLike.id, sentAt: new Date(), bodyText: new Uint8Array([1]), bodyHash: "h", direction: "INBOUND" } });
    expect(await linkChatPerson(admin(), { participantId: emailLike.id, userId: f.users.member })).toBe("NOT_FOUND"); // has a Chat message, but is not a Chat id
  });

  it("is for admins only, and another organization can neither see nor change these people", async () => {
    const b = await bind();
    const id = await person(b);
    await expect(listChatPeople(f.principals.member)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(linkChatPerson(f.principals.lead, { participantId: id, userId: f.users.member })).rejects.toMatchObject({ name: "ForbiddenError" });
    expect((await listChatPeople(other.principals.admin)).map((p) => p.id)).not.toContain(id);
    expect(await linkChatPerson(other.principals.admin, { participantId: id, userId: other.users.member })).toBe("NOT_FOUND");
  });
});

describe("the scheduled scan", () => {
  const jobsFor = async (sourceId: string) => (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => j.data.monitoredSourceId === sourceId);

  it("queues a sync for every enabled space once per interval and skips removed ones", async () => {
    const live = await bind();
    const gone = await bind();
    await sources.removeChatSpace(admin(), gone.monitoredSourceId);
    const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, 5));
    expect((await handleChatScan({ hub, now })).failures).toBe(0);
    expect(await jobsFor(live.monitoredSourceId)).toHaveLength(1);
    expect(await jobsFor(gone.monitoredSourceId)).toHaveLength(0);
    await handleChatScan({ hub, now });
    expect(await jobsFor(live.monitoredSourceId)).toHaveLength(1);
    await handleChatScan({ hub, now: () => new Date(now().getTime() + 200_000) });
    expect(await jobsFor(live.monitoredSourceId)).toHaveLength(2);
  });

  it("never queues a Gmail mailbox or a space of the synthetic provider", async () => {
    const synthetic = (await owner.monitoredSource.findUniqueOrThrow({ where: { id: f.sourceId } })).id;
    await handleChatScan({ hub });
    expect(await jobsFor(synthetic)).toHaveLength(0);
  });
});

describe("secrets and content stay out of everything we write", () => {
  it("no key, token, claim code or message text appears in logs, audit rows or queued jobs", async () => {
    const b = await bind();
    fake.addChatMessage(b.space, { text: "Confidential: our checkout is down." });
    await sync(b.monitoredSourceId);
    await handleChatScan({ hub });
    const token = await createServiceAccountTokens({ key: parseServiceAccountKey(SA_JSON), tokenUrl: googleEndpoints(fake.baseUrl).token, scopes: [CHAT_APP_MESSAGES_READONLY_SCOPE] }).getToken();
    const secrets = [parseServiceAccountKey(SA_JSON).privateKey.split("\n")[1]!, "PRIVATE KEY", token.slice(0, 12), b.code, "Confidential: our checkout"];
    const audit = JSON.stringify(await owner.auditLog.findMany({ where: { organizationId: { in: [f.organizationId, other.organizationId] } }, select: { metadata: true, action: true } }));
    const jobs = JSON.stringify((await Promise.all([QUEUES.ingestSource, QUEUES.analyzeMessage, QUEUES.chatScan].map((q) => hub.queue(q).getJobs()))).flat().map((j) => j.data));
    const raw = JSON.stringify(await owner.rawEvent.findMany({ where: { organizationId: f.organizationId }, select: { payloadHash: true, externalId: true } }));
    for (const secret of secrets) for (const [where, text] of Object.entries({ logs: logged.join("\n"), audit, jobs, raw })) expect(text, `${where} leaks ${secret.slice(0, 8)}`).not.toContain(secret);
    expect(createChatClient).toBeTypeOf("function");
  });
});

describe("row-level security on claims", () => {
  it("another organization cannot see, change or forge claims, with no application scoping in between", async () => {
    const space = newSpace();
    fake.addChatSpace(space, true);
    const c = await claim(admin(), space);
    const raw = createPrismaClient(process.env["APP_DATABASE_URL"]!);
    try {
      const as = <T>(organizationId: string | null, fn: (tx: Parameters<Parameters<typeof raw.$transaction>[0]>[0]) => Promise<T>) =>
        raw.$transaction(async (tx) => {
          if (organizationId) await tx.$executeRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
          return fn(tx);
        });
      expect(await as(other.organizationId, (tx) => tx.sourceClaim.findMany({ where: { id: c.claimId } }))).toEqual([]);
      expect(await as(null, (tx) => tx.sourceClaim.findMany({ where: { id: c.claimId } }))).toEqual([]);
      expect((await as(other.organizationId, (tx) => tx.sourceClaim.updateMany({ where: { id: c.claimId }, data: { status: "VERIFIED", verifiedAt: new Date() } }))).count).toBe(0);
      await expect(as(other.organizationId, (tx) => tx.sourceClaim.create({ data: { organizationId: f.organizationId, provider: "GOOGLE_CHAT", externalId: space, teamId: f.teamId, code: new Uint8Array([1]), createdByUserId: f.users.admin, expiresAt: new Date() } }))).rejects.toThrow();
      expect(await as(f.organizationId, (tx) => tx.sourceClaim.count({ where: { id: c.claimId, status: "PENDING" } }))).toBe(1);
    } finally {
      await raw.$disconnect();
    }
    expect(await withTenant({ organizationId: other.organizationId }, (tx) => tx.sourceClaim.count())).toBe(
      await owner.sourceClaim.count({ where: { organizationId: other.organizationId } }),
    );
  });
});
