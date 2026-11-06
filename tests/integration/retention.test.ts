import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto/fields";
import { runRetention, getRetention, setRetention, erasePerson, exportPerson, getRetentionStatus, verifyAllAuditChains, RETENTION_DEFAULTS } from "@/modules/retention";
import { handleRetention } from "@/workers/maintenance";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { asLifecycleWriter, purgeOrgs, testKey } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const app = createPrismaClient(process.env["APP_DATABASE_URL"]!);
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2027, 5, 1, 12, 0, 0));
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const logged: string[] = [];
const fixtures: EngineFixture[] = [];

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await purgeOrgs(owner, fixtures.map((f) => f.organizationId));
  await owner.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => Object.values(f.users)) } } });
  await owner.$disconnect();
  await app.$disconnect();
});

const fresh = async () => {
  const f = await createEngineFixture(owner);
  fixtures.push(f);
  return f;
};
const deps = (over: Record<string, unknown> = {}) => ({ now: () => NOW, fieldKey: testKey, ...over });
const bodyOf = (organizationId: string, blob: Uint8Array) => decryptField(blob, testKey, `${organizationId}:Message.bodyText`);

interface Seed { messageId: string; threadId: string; rawEventId: string; itemId?: string }
/** A message with a raw payload, `received` days ago, optionally the origin of an item in `state` (closed `closed` days ago). */
async function seed(f: EngineFixture, o: { received: number; item?: "OPEN" | "CLOSED" | "REOPENED"; closed?: number; text?: string; sender?: string; threadId?: string }): Promise<Seed> {
  const text = o.text ?? `Please help with matter ${randomUUID().slice(0, 6)}.`;
  const threadId = o.threadId ?? (await owner.thread.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } })).id;
  const raw = await owner.rawEvent.create({
    data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalId: `e-${randomUUID()}`, payload: encryptField(JSON.stringify({ body: text }), testKey, `${f.organizationId}:RawEvent.payload`), payloadHash: randomUUID(), receivedAt: ago(o.received) },
  });
  const senderParticipantId = o.sender ? (await owner.participant.upsert({ where: { organizationId_address: { organizationId: f.organizationId, address: o.sender } }, create: { organizationId: f.organizationId, address: o.sender, displayName: "Pat Customer" }, update: {} })).id : null;
  const message = await owner.message.create({
    data: {
      organizationId: f.organizationId, monitoredSourceId: f.sourceId, threadId, provider: "SYNTHETIC", externalMessageId: `m-${randomUUID()}`, rawEventId: raw.id, senderParticipantId,
      sentAt: ago(o.received), createdAt: ago(o.received), subject: "Printer jams", bodyText: encryptField(text, testKey, `${f.organizationId}:Message.bodyText`), bodyHash: "hash-of-text", direction: "INBOUND",
    },
  });
  let itemId: string | undefined;
  if (o.item) {
    const item = await asLifecycleWriter(owner, (tx) => tx.trackedItem.create({
      data: { organizationId: f.organizationId, teamId: f.teamId, originMessageId: message.id, threadId, title: "Item", state: o.item === "CLOSED" ? "CLOSED" : o.item === "REOPENED" ? "REOPENED" : "RECEIVED", ...(o.item === "CLOSED" ? { closedAt: ago(o.closed ?? 0) } : {}) },
    }));
    itemId = item.id;
  }
  return { messageId: message.id, threadId, rawEventId: raw.id, ...(itemId ? { itemId } : {}) };
}
const msg = (id: string) => owner.message.findUniqueOrThrow({ where: { id } });
const rawExists = async (id: string) => (await owner.rawEvent.count({ where: { id } })) === 1;
const purged = async (f: EngineFixture, id: string) => {
  const m = await msg(id);
  return m.contentPurgedAt !== null && bodyOf(f.organizationId, m.bodyText) === "[removed by retention]";
};

describe("retention settings", () => {
  it("default to 30 days for raw payloads and 180 for bodies, and fall back to them when the stored value is missing or invalid", async () => {
    const f = await fresh();
    expect(await getRetention(f.organizationId)).toEqual({ rawEventDays: 30, messageDays: 180 });
    expect(RETENTION_DEFAULTS).toEqual({ rawEventDays: 30, messageDays: 180 });
    for (const bad of [{ rawEventDays: 0, messageDays: 0 }, "forever", { rawEventDays: 30 }, { rawEventDays: 30, messageDays: 180, extra: 1 }, null]) {
      await owner.organization.update({ where: { id: f.organizationId }, data: { settings: { retention: bad } as object } });
      expect(await getRetention(f.organizationId), JSON.stringify(bad)).toEqual({ rawEventDays: 30, messageDays: 180 });
    }
  });

  it("are changed by an administrator only, validated, audited with before and after, and never clobber other settings", async () => {
    const f = await fresh();
    await owner.organization.update({ where: { id: f.organizationId }, data: { settings: { llm: { dailyTokenBudget: 123 } } } });
    expect(await setRetention(f.principals.admin, { rawEventDays: 14, messageDays: 120 })).toEqual({ rawEventDays: 14, messageDays: 120 });
    expect(await getRetention(f.organizationId)).toEqual({ rawEventDays: 14, messageDays: 120 });
    expect((await owner.organization.findUniqueOrThrow({ where: { id: f.organizationId } })).settings).toMatchObject({ llm: { dailyTokenBudget: 123 }, retention: { rawEventDays: 14, messageDays: 120 } });
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "retention.settings_changed" } });
    expect(audit).toMatchObject({ actorId: f.users.admin, metadata: { before: { rawEventDays: 30, messageDays: 180 }, after: { rawEventDays: 14, messageDays: 120 } } });
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(setRetention(f.principals[who], { rawEventDays: 14, messageDays: 120 }), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    await expect(getRetentionStatus(f.principals.member)).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuse values that could lose data by accident", async () => {
    const f = await fresh();
    const bad = [
      { rawEventDays: 6, messageDays: 180 }, // a week at least
      { rawEventDays: 30, messageDays: 89 }, // bodies must outlive the longest first sync (90 days)
      { rawEventDays: 200, messageDays: 180 }, // a raw payload is a copy of the body: it cannot outlive it
      { rawEventDays: 30.5, messageDays: 180 }, { rawEventDays: "30", messageDays: 180 }, { rawEventDays: 30, messageDays: 4000 },
      { rawEventDays: 30, messageDays: 180, keepForever: true }, {}, null, "x",
    ];
    for (const input of bad) await expect(setRetention(f.principals.admin, input), JSON.stringify(input)).rejects.toMatchObject({ name: "InvalidRetentionError" });
    expect(await getRetention(f.organizationId)).toEqual({ rawEventDays: 30, messageDays: 180 });
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "retention.settings_changed" } })).toBe(0);
  });
});

describe("raw payloads", () => {
  it("are deleted after their window and kept before it, and their messages are detached, not deleted", async () => {
    const f = await fresh();
    const old = await seed(f, { received: 45 });
    const fresher = await seed(f, { received: 10 });
    const out = await runRetention(f.organizationId, deps());
    expect(out).toMatchObject({ rawEvents: 1, complete: true });
    expect(await rawExists(old.rawEventId)).toBe(false);
    expect(await rawExists(fresher.rawEventId)).toBe(true);
    expect((await msg(old.messageId)).rawEventId).toBeNull();
    expect((await msg(fresher.messageId)).rawEventId).toBe(fresher.rawEventId);
    expect(bodyOf(f.organizationId, (await msg(old.messageId)).bodyText)).not.toBe("[removed by retention]"); // the body has its own, longer window
  });

  it("follow the organization's own window", async () => {
    const f = await fresh();
    const tenDays = await seed(f, { received: 10 });
    await runRetention(f.organizationId, deps());
    expect(await rawExists(tenDays.rawEventId)).toBe(true);
    await setRetention(f.principals.admin, { rawEventDays: 7, messageDays: 180 });
    await runRetention(f.organizationId, deps());
    expect(await rawExists(tenDays.rawEventId)).toBe(false);
  });

  it("are kept while the item they belong to is open, whatever their age, and go once it is closed", async () => {
    const f = await fresh();
    const open = await seed(f, { received: 400, item: "OPEN" });
    const reopened = await seed(f, { received: 400, item: "REOPENED" });
    const closed = await seed(f, { received: 400, item: "CLOSED", closed: 399 });
    await runRetention(f.organizationId, deps());
    expect(await rawExists(open.rawEventId)).toBe(true);
    expect(await rawExists(reopened.rawEventId)).toBe(true);
    expect(await rawExists(closed.rawEventId)).toBe(false);
  });

  it("are kept when the message is attached to an open item from another channel", async () => {
    const f = await fresh();
    const target = await seed(f, { received: 5, item: "OPEN" });
    const other = await seed(f, { received: 400 });
    await owner.itemMessageLink.create({ data: { organizationId: f.organizationId, itemId: target.itemId!, messageId: other.messageId, role: "OTHER" } });
    await runRetention(f.organizationId, deps());
    expect(await rawExists(other.rawEventId)).toBe(true);
    expect(await purged(f, other.messageId)).toBe(false);
  });
});

describe("message bodies", () => {
  it("are replaced by a tombstone after their window, keeping the row, its ids and its metadata", async () => {
    const f = await fresh();
    const s = await seed(f, { received: 300, sender: "users/777" });
    const before = await msg(s.messageId);
    const out = await runRetention(f.organizationId, deps());
    expect(out.messages).toBe(1);
    const after = await msg(s.messageId);
    expect(bodyOf(f.organizationId, after.bodyText)).toBe("[removed by retention]");
    expect(after).toMatchObject({ bodyHash: "", contentPurgedAt: NOW, id: before.id, threadId: before.threadId, senderParticipantId: before.senderParticipantId, direction: "INBOUND", subject: "Printer jams" });
    expect(after.sentAt).toEqual(before.sentAt);
    expect(Buffer.from(after.bodyText).includes(Buffer.from("matter"))).toBe(false);
  });

  it("keep what is not yet due, and what belongs to an open item however old", async () => {
    const f = await fresh();
    const recent = await seed(f, { received: 100 });
    const open = await seed(f, { received: 500, item: "OPEN" });
    const reopened = await seed(f, { received: 500, item: "REOPENED" });
    await runRetention(f.organizationId, deps());
    for (const s of [recent, open, reopened]) expect(await purged(f, s.messageId)).toBe(false);
  });

  it("count from when the item closed, not from when the message arrived", async () => {
    const f = await fresh();
    const longAgoButClosedRecently = await seed(f, { received: 400, item: "CLOSED", closed: 20 });
    const closedLongAgo = await seed(f, { received: 400, item: "CLOSED", closed: 200 });
    await runRetention(f.organizationId, deps());
    expect(await purged(f, longAgoButClosedRecently.messageId)).toBe(false);
    expect(await purged(f, closedLongAgo.messageId)).toBe(true);
  });

  it("wait for every item in the conversation: one open item protects the whole thread", async () => {
    const f = await fresh();
    const thread = await owner.thread.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
    const first = await seed(f, { received: 400, item: "CLOSED", closed: 399, threadId: thread.id });
    const second = await seed(f, { received: 5, item: "OPEN", threadId: thread.id });
    await runRetention(f.organizationId, deps());
    expect(await purged(f, first.messageId)).toBe(false);
    expect(await purged(f, second.messageId)).toBe(false);
  });

  it("go by their arrival date when they belong to no item", async () => {
    const f = await fresh();
    const old = await seed(f, { received: 200 });
    const recent = await seed(f, { received: 100 });
    await runRetention(f.organizationId, deps());
    expect(await purged(f, old.messageId)).toBe(true);
    expect(await purged(f, recent.messageId)).toBe(false);
  });

  it("take the quotes copied into analysis runs with them, and leave every other run alone", async () => {
    const f = await fresh();
    const gone = await seed(f, { received: 300 });
    const kept = await seed(f, { received: 5 });
    const run = (messageId: string, quote: string) => owner.analysisRun.create({ data: {
      organizationId: f.organizationId, analyzer: "intent_classifier", messageId, provider: "fake", model: "fake-1", promptVersion: "1", inputHash: randomUUID(), output: { actionable: true },
      confidence: 0.9, evidence: [{ messageId, quote }, { messageId: kept.messageId, quote: "a quote from a message that stays" }], recommendedAction: "TRACK", status: "OK",
    } });
    const a = await run(gone.messageId, "printer jams every third sheet");
    await runRetention(f.organizationId, deps());
    const after = await owner.analysisRun.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.evidence).toEqual([{ messageId: gone.messageId, quote: "[removed by retention]" }, { messageId: kept.messageId, quote: "a quote from a message that stays" }]);
    expect(after).toMatchObject({ confidence: 0.9, recommendedAction: "TRACK", status: "OK", output: { actionable: true } }); // the decision itself is kept
  });

  it("are not touched twice, and a second run changes and audits nothing", async () => {
    const f = await fresh();
    const s = await seed(f, { received: 300 });
    expect((await runRetention(f.organizationId, deps())).messages).toBe(1);
    const first = (await msg(s.messageId)).contentPurgedAt;
    const again = await runRetention(f.organizationId, deps({ now: () => new Date(NOW.getTime() + DAY) }));
    expect(again).toMatchObject({ rawEvents: 0, messages: 0 });
    expect((await msg(s.messageId)).contentPurgedAt).toEqual(first);
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "retention.purged" } })).toBe(1);
  });
});

describe("a run", () => {
  it("works through a backlog in batches, says when it stopped early, and the next run finishes the job", async () => {
    const f = await fresh();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => seed(f, { received: 300 })));
    const partial = await runRetention(f.organizationId, deps({ batchSize: 2, maxBatches: 1 }));
    expect(partial.complete).toBe(false);
    expect(partial.messages).toBe(2);
    const rest = await runRetention(f.organizationId, deps({ batchSize: 2, maxBatches: 10 }));
    expect(rest.complete).toBe(true);
    expect(rest.messages).toBe(3);
    for (const s of all) expect(await purged(f, s.messageId)).toBe(true);
  });

  it("reports an unfinished backlog of raw payloads on its own, not only of bodies", async () => {
    const f = await fresh();
    for (let i = 0; i < 5; i++) await seed(f, { received: 45 }); // raw payloads are due (30 days); their bodies are not (180 days)
    const partial = await runRetention(f.organizationId, deps({ batchSize: 2, maxBatches: 1 }));
    expect(partial).toMatchObject({ rawEvents: 2, messages: 0, complete: false });
    expect(await runRetention(f.organizationId, deps({ batchSize: 2, maxBatches: 10 }))).toMatchObject({ rawEvents: 3, complete: true });
  });

  it("is audited once with counts and windows only, never any content", async () => {
    const f = await fresh();
    await seed(f, { received: 300, text: "Confidential: our checkout is down for Pat Customer." });
    await runRetention(f.organizationId, deps());
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "retention.purged" } });
    expect(audit).toMatchObject({ actorType: "SYSTEM", metadata: { rawEvents: 1, messages: 1, rawEventDays: 30, messageDays: 180, complete: true } });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Confidential|checkout|Pat/);
    expect(logged.join("\n")).not.toMatch(/Confidential|checkout is down/);
  });

  it("only ever touches its own organization", async () => {
    const a = await fresh();
    const b = await fresh();
    const mine = await seed(a, { received: 300 });
    const theirs = await seed(b, { received: 300 });
    await runRetention(a.organizationId, deps());
    expect(await purged(a, mine.messageId)).toBe(true);
    expect(await purged(b, theirs.messageId)).toBe(false);
    expect(await rawExists(theirs.rawEventId)).toBe(true);
  });

  it("the scheduled pass visits every organization", async () => {
    const one = await fresh();
    const two = await fresh();
    const a = await seed(one, { received: 300 });
    const b = await seed(two, { received: 300 });
    const out = await handleRetention({ now: () => NOW, fieldKey: testKey, batchSize: 100, only: [one.organizationId, two.organizationId] }); // only these: a fake future clock must never touch other organizations' data
    expect(out.failures).toBe(0);
    expect(out.organizations).toBe(2);
    expect(await purged(one, a.messageId)).toBe(true);
    expect(await purged(two, b.messageId)).toBe(true);
  });
});

describe("the append-only guard on raw payloads", () => {
  it("still rejects every direct change, from the app role and from the table owner, and TRUNCATE", async () => {
    const f = await fresh();
    const s = await seed(f, { received: 1 });
    await expect(owner.$executeRaw`DELETE FROM "RawEvent" WHERE id = ${s.rawEventId}::uuid`).rejects.toThrow(/append-only/);
    await expect(owner.$executeRaw`UPDATE "RawEvent" SET payload = '\\x00'::bytea WHERE id = ${s.rawEventId}::uuid`).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`TRUNCATE "RawEvent"`)).rejects.toThrow(); // blocked by the guard (and by the foreign keys that reference it)
    await expect(app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true)`;
      await tx.$executeRaw`DELETE FROM "RawEvent" WHERE id = ${s.rawEventId}::uuid`;
    })).rejects.toThrow();
    expect(await rawExists(s.rawEventId)).toBe(true);
  });

  it("cannot be opened by the app role claiming to be the maintenance role", async () => {
    const f = await fresh();
    const s = await seed(f, { received: 1 });
    await expect(app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true)`;
      await tx.$executeRawUnsafe(`SET LOCAL ROLE loopsignal_maint`);
      await tx.$executeRaw`DELETE FROM "RawEvent" WHERE id = ${s.rawEventId}::uuid`;
    })).rejects.toThrow();
    expect(await rawExists(s.rawEventId)).toBe(true);
  });

  it("is passed only through the maintenance functions, and only for the caller's own organization", async () => {
    const a = await fresh();
    const b = await fresh();
    const mine = await seed(a, { received: 100 });
    const theirs = await seed(b, { received: 100 });
    const as = <T>(org: string, fn: (tx: Parameters<Parameters<typeof app.$transaction>[0]>[0]) => Promise<T>) =>
      app.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`; return fn(tx); });
    // Asking to purge ANOTHER organization's rows under this tenant context is refused outright.
    await expect(as(a.organizationId, (tx) => tx.$queryRaw`SELECT retention_purge_raw_events(${b.organizationId}::uuid, ${NOW}::timestamptz, 10)`)).rejects.toThrow(/tenant context/);
    await expect(as(a.organizationId, (tx) => tx.$queryRaw`SELECT retention_purge_raw_events_for_messages(${b.organizationId}::uuid, ${[theirs.messageId]}::uuid[])`)).rejects.toThrow(/tenant context/);
    await expect(as(a.organizationId, (tx) => tx.$queryRaw`SELECT retention_rekey_raw_event(${b.organizationId}::uuid, ${theirs.rawEventId}::uuid, '\\x01'::bytea)`)).rejects.toThrow(/tenant context/);
    expect(await rawExists(theirs.rawEventId)).toBe(true);
    // With no tenant context at all, nothing is allowed.
    await expect(app.$queryRaw`SELECT retention_purge_raw_events(${a.organizationId}::uuid, ${NOW}::timestamptz, 10)`).rejects.toThrow();
    // And for its own organization it works, and re-encrypting changes the payload and nothing else.
    const before = await owner.rawEvent.findUniqueOrThrow({ where: { id: mine.rawEventId } });
    const replacement = encryptField(JSON.stringify({ body: "same content, new key" }), testKey, `${a.organizationId}:RawEvent.payload`);
    expect(await as(a.organizationId, (tx) => tx.$queryRaw<Array<{ ok: boolean }>>`SELECT retention_rekey_raw_event(${a.organizationId}::uuid, ${mine.rawEventId}::uuid, ${replacement}::bytea) AS ok`)).toEqual([{ ok: true }]);
    const after = await owner.rawEvent.findUniqueOrThrow({ where: { id: mine.rawEventId } });
    expect(Buffer.from(after.payload).equals(Buffer.from(replacement))).toBe(true);
    expect({ ...after, payload: null }).toEqual({ ...before, payload: null });
  });

  it("lets the maintenance role replace the payload and delete a row, but change nothing else, even if it were granted more", async () => {
    const f = await fresh();
    const s = await seed(f, { received: 1 });
    const asMaint = (sql: string) => owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${f.organizationId}, true)`;
      await tx.$executeRawUnsafe("SET LOCAL ROLE loopsignal_maint");
      return tx.$executeRawUnsafe(sql);
    });
    expect(await asMaint(`UPDATE "RawEvent" SET payload = '\\x0102'::bytea WHERE id = '${s.rawEventId}'`)).toBe(1); // the payload: allowed
    await expect(asMaint(`UPDATE "RawEvent" SET "payloadHash" = 'changed' WHERE id = '${s.rawEventId}'`)).rejects.toThrow(); // anything else: refused
    await expect(asMaint(`UPDATE "RawEvent" SET payload = '\\x03'::bytea, "externalId" = 'changed' WHERE id = '${s.rawEventId}'`)).rejects.toThrow();
    expect((await owner.rawEvent.findUniqueOrThrow({ where: { id: s.rawEventId } })).payloadHash).not.toBe("changed");
    const orphan = await owner.rawEvent.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalId: `e-${randomUUID()}`, payload: new Uint8Array([9]), payloadHash: "orphan" } }); // no message refers to it
    expect(await asMaint(`DELETE FROM "RawEvent" WHERE id = '${orphan.id}'`)).toBe(1); // deleting: allowed to this role only
  });

  it("the maintenance role cannot log in, owns only its functions, and the other append-only tables have no exception", async () => {
    const [role] = await owner.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'loopsignal_maint'`;
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    const fns = await owner.$queryRaw<Array<{ proname: string; owner: string; secdef: boolean }>>`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'retention\\_%' AND p.proname <> 'retention_expired_message_ids'`;
    expect(fns.map((x) => x.proname).sort()).toEqual(["retention_purge_raw_events", "retention_purge_raw_events_for_messages", "retention_rekey_raw_event"]);
    expect(fns.every((x) => x.owner === "loopsignal_maint" && x.secdef)).toBe(true);
    const f = await fresh();
    await setRetention(f.principals.admin, { rawEventDays: 14, messageDays: 120 }); // leaves an audit row to try to delete
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId } });
    await expect(owner.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${audit.id}::uuid`).rejects.toThrow(/append-only/);
    const [grants] = await owner.$queryRaw<Array<{ del: boolean; upd_audit: boolean; upd_event: boolean }>>`
      SELECT has_table_privilege('loopsignal_maint', '"AuditLog"', 'DELETE') AS del, has_table_privilege('loopsignal_maint', '"AuditLog"', 'UPDATE') AS upd_audit, has_table_privilege('loopsignal_maint', '"LifecycleEvent"', 'UPDATE') AS upd_event`;
    expect(grants).toEqual({ del: false, upd_audit: false, upd_event: false });
  });
});

describe("erasing a person", () => {
  it("removes everything they wrote in every state, their raw payloads and quotes, and their name, and nothing of anyone else's", async () => {
    const f = await fresh();
    const person = "users/erase-me";
    const mine = await seed(f, { received: 2, item: "OPEN", text: "Hello, I am Pat and my number is 555-0100.", sender: person });
    const mineOld = await seed(f, { received: 400, text: "Another message from Pat.", sender: person });
    const someoneElse = await seed(f, { received: 2, item: "OPEN", text: "A different customer.", sender: "users/other" });
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: person } })).id;
    await owner.participant.update({ where: { organizationId_id: { organizationId: f.organizationId, id: participantId } }, data: { userId: f.users.member } });
    const run = await owner.analysisRun.create({ data: {
      organizationId: f.organizationId, analyzer: "intent_classifier", messageId: mine.messageId, provider: "fake", model: "fake-1", promptVersion: "1", inputHash: randomUUID(), output: {},
      confidence: 0.9, evidence: [{ messageId: mine.messageId, quote: "my number is 555-0100" }], recommendedAction: "TRACK", status: "OK",
    } });

    const result = await erasePerson(f.principals.admin, { participantId }, deps());
    expect(result).toEqual({ messages: 2, rawEvents: 2, evidenceRuns: 1 }); // both messages, and both raw payloads
    for (const s of [mine, mineOld]) {
      expect(await purged(f, s.messageId), s.messageId).toBe(true);
      expect((await msg(s.messageId)).subject).toBe("[erased]");
      expect(await rawExists(s.rawEventId)).toBe(false);
    }
    expect(await purged(f, someoneElse.messageId)).toBe(false);
    expect(await rawExists(someoneElse.rawEventId)).toBe(true);
    expect((await msg(someoneElse.messageId)).subject).toBe("Printer jams");
    expect((await owner.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).evidence).toEqual([{ messageId: mine.messageId, quote: "[removed by retention]" }]);
    expect(await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: participantId } } })).toMatchObject({ address: `erased:${participantId}`, displayName: null, userId: null });
    // The lifecycle record survives: the message rows and the item are still there.
    expect(await owner.message.count({ where: { id: { in: [mine.messageId, mineOld.messageId] } } })).toBe(2);
    expect((await owner.trackedItem.findUniqueOrThrow({ where: { id: mine.itemId! } })).state).not.toBe("CLOSED");
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "participant.erased", entityId: participantId } });
    expect(audit).toMatchObject({ actorId: f.users.admin, metadata: { messages: 2, rawEvents: 2, evidenceRuns: 1 } });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Pat|555|erase-me/);
  });

  it("also blanks the subject of a message whose body retention had already removed", async () => {
    const f = await fresh();
    const old = await seed(f, { received: 300, sender: "users/was-purged" });
    await runRetention(f.organizationId, deps());
    expect(await purged(f, old.messageId)).toBe(true);
    expect((await msg(old.messageId)).subject).toBe("Printer jams"); // retention keeps subjects; an erasure does not
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: "users/was-purged" } })).id;
    await erasePerson(f.principals.admin, { participantId }, deps());
    expect((await msg(old.messageId)).subject).toBe("[erased]");
  });

  it("is for administrators of that organization only, and reports a participant that does not exist", async () => {
    const a = await fresh();
    const b = await fresh();
    const s = await seed(a, { received: 2, sender: "users/keep" });
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: a.organizationId, address: "users/keep" } })).id;
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(erasePerson(a.principals[who], { participantId }, deps()), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    expect(await erasePerson(b.principals.admin, { participantId }, deps())).toBeNull(); // another tenant cannot even see them
    expect(await erasePerson(a.principals.admin, { participantId: randomUUID() }, deps())).toBeNull();
    expect(await purged(a, s.messageId)).toBe(false);
    expect(await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: a.organizationId, id: participantId } } })).toMatchObject({ address: "users/keep" });
    expect(await owner.auditLog.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] }, action: "participant.erased" } })).toBe(0);
  });
});

describe("exporting a person's data (subject access)", () => {
  it("returns their record, every message they wrote (decrypted, or the removal marker), and the items they started, and nothing of anyone else's", async () => {
    const f = await fresh();
    const person = "users/export-me";
    const a = await seed(f, { received: 2, item: "OPEN", text: "Hello, I am Pat and my number is 555-0100.", sender: person });
    const old = await seed(f, { received: 300, text: "An old message from Pat.", sender: person });
    await seed(f, { received: 2, text: "A different customer entirely.", sender: "users/not-me" });
    await runRetention(f.organizationId, deps()); // the old message's text is already gone
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: person } })).id;

    const out = (await exportPerson(f.principals.admin, { participantId }, deps()))!;
    expect(out.participant).toMatchObject({ id: participantId, address: person, displayName: "Pat Customer", linkedUserId: null });
    expect(out.messages.map((m) => m.id)).toEqual([old.messageId, a.messageId]); // oldest first
    expect(out.messages.find((m) => m.id === a.messageId)).toMatchObject({ body: "Hello, I am Pat and my number is 555-0100.", direction: "INBOUND", subject: "Printer jams", contentRemovedAt: null });
    expect(out.messages.find((m) => m.id === old.messageId)).toMatchObject({ body: "[removed by retention]", contentRemovedAt: expect.any(String) });
    expect(out.itemsStarted.map((i) => i.id)).toEqual([a.itemId]);
    expect(out.truncated).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/different customer|not-me/);
    expect(out.notIncluded.length).toBeGreaterThan(0);
    expect(out.organizationId).toBe(f.organizationId);
  });

  it("is audited with counts only, and the content never reaches a log", async () => {
    const f = await fresh();
    await seed(f, { received: 2, text: "Confidential: Pat's account number is 99-1234.", sender: "users/audited" });
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: "users/audited" } })).id;
    await exportPerson(f.principals.admin, { participantId }, deps());
    const audit = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "participant.exported", entityId: participantId } });
    expect(audit).toMatchObject({ actorId: f.users.admin, actorType: "USER", metadata: { messages: 1, items: 0, truncated: false } });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Confidential|99-1234|audited/);
    expect(logged.join("\n")).not.toMatch(/Confidential|99-1234/);
  });

  it("says when it cut the list short", async () => {
    const f = await fresh();
    for (let i = 0; i < 4; i++) await seed(f, { received: 2, sender: "users/prolific" });
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: f.organizationId, address: "users/prolific" } })).id;
    const out = (await exportPerson(f.principals.admin, { participantId }, deps({ limit: 3 })))!;
    expect(out.messages).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("is for administrators of that organization only, and another organization sees nothing", async () => {
    const a = await fresh();
    const b = await fresh();
    await seed(a, { received: 2, sender: "users/private" });
    const participantId = (await owner.participant.findFirstOrThrow({ where: { organizationId: a.organizationId, address: "users/private" } })).id;
    for (const who of ["lead", "member", "viewer", "auditor"] as const) {
      await expect(exportPerson(a.principals[who], { participantId }, deps()), who).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    expect(await exportPerson(b.principals.admin, { participantId }, deps())).toBeNull();
    expect(await exportPerson(a.principals.admin, { participantId: randomUUID() }, deps())).toBeNull();
    expect(await owner.auditLog.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] }, action: "participant.exported" } })).toBe(0); // refused or empty: nothing was exported
  });
});

describe("audit-chain verification", () => {
  it("records an intact chain, and reports a chain that was altered outside the application", async () => {
    const good = await fresh();
    const tampered = await fresh();
    await setRetention(good.principals.admin, { rawEventDays: 14, messageDays: 120 });
    await setRetention(tampered.principals.admin, { rawEventDays: 14, messageDays: 120 });
    await setRetention(tampered.principals.admin, { rawEventDays: 20, messageDays: 150 });
    // Break-glass edit, as someone with superuser access could make it: change a recorded fact without recomputing the chain.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE "AuditLog" SET action = 'retention.nothing_happened' WHERE "organizationId" = ${tampered.organizationId}::uuid AND action = 'retention.settings_changed'`;
    });
    const result = await verifyAllAuditChains({ only: [good.organizationId, tampered.organizationId] });
    expect(result.organizations).toBe(2);
    expect(result.broken).toBe(1);
    expect(result.failed).toBe(0);
    const okEntry = await owner.auditLog.findFirstOrThrow({ where: { organizationId: good.organizationId, action: "audit.chain_verified" }, orderBy: { seq: "desc" } });
    expect(okEntry).toMatchObject({ actorType: "SYSTEM", metadata: { intact: true } });
    const badEntry = await owner.auditLog.findFirstOrThrow({ where: { organizationId: tampered.organizationId, action: "audit.chain_verified" }, orderBy: { seq: "desc" } });
    expect(badEntry.metadata).toMatchObject({ intact: false, firstBadSeq: expect.any(Number) });
    expect(logged.some((l) => l.includes("audit.chain_broken") && l.includes(tampered.organizationId) && l.includes('"level":"error"'))).toBe(true);
    expect(logged.some((l) => l.includes("audit.chain_broken") && l.includes(good.organizationId))).toBe(false);
  });

  it("is what the status screen shows: the windows, the last purge and the last check", async () => {
    const f = await fresh();
    expect(await getRetentionStatus(f.principals.admin)).toMatchObject({ settings: { rawEventDays: 30, messageDays: 180 }, lastPurge: null, lastVerification: null });
    await seed(f, { received: 300 });
    await runRetention(f.organizationId, deps());
    await verifyAllAuditChains({ only: [f.organizationId] });
    const status = await getRetentionStatus(f.principals.admin);
    expect(status.lastPurge).toMatchObject({ rawEvents: 1, messages: 1 });
    expect(status.lastVerification).toMatchObject({ intact: true });
  });
});
