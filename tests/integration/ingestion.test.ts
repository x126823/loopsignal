import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptField } from "@/lib/crypto/fields";
import { createPrismaClient, withTenant } from "@/lib/db";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { ingestEvent, syncSource, type SyncDeps } from "@/modules/ingestion";
import { createSyntheticAdapter, syntheticInbox, type ProviderAdapter, type RawProviderEvent } from "@/modules/integrations";
import { canonicalJson } from "@/modules/ingestion";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { createTestHub, destroyTestHub, waitingJobs } from "../helpers/queue";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const adapter = createSyntheticAdapter();
const TOTAL = syntheticInbox("x").length; // 12
let f: EngineFixture;
let g: EngineFixture;
let hub: QueueHub;
let connectionId: string;

const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({ hub, fieldKey: testKey, ...over });
const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[1], fx = f) => withTenant({ organizationId: fx.organizationId }, fn);

async function newSource(externalId = `box-${randomUUID().slice(0, 8)}`, fx = f, conn = connectionId) {
  const s = await owner.monitoredSource.create({ data: { organizationId: fx.organizationId, connectionId: conn, kind: "MAILBOX", externalId } });
  return { id: s.id, externalId };
}
const counts = (fx = f) => Promise.all([
  owner.rawEvent.count({ where: { organizationId: fx.organizationId } }), owner.message.count({ where: { organizationId: fx.organizationId } }),
  owner.thread.count({ where: { organizationId: fx.organizationId } }), owner.participant.count({ where: { organizationId: fx.organizationId } }),
]);
const ev = (payload: unknown, externalId?: string): RawProviderEvent => ({
  provider: "SYNTHETIC", externalId: externalId ?? (payload as { id: string }).id, receivedAt: new Date(), payload,
});
const ingest = (source: { id: string }, event: RawProviderEvent, fx = f, a: ProviderAdapter = adapter) =>
  withTenant({ organizationId: fx.organizationId }, (tx) => ingestEvent(tx, { organizationId: fx.organizationId, monitoredSourceId: source.id, event, adapter: a, fieldKey: testKey }));
const analyzeJobs = async () => (await waitingJobs(hub, QUEUES.analyzeMessage));

beforeAll(async () => {
  f = await createEngineFixture(owner);
  g = await createEngineFixture(owner);
  connectionId = (await owner.monitoredSource.findUniqueOrThrow({ where: { id: f.sourceId } })).connectionId;
  hub = createTestHub();
});

afterAll(async () => {
  await destroyTestHub(hub);
  await purgeOrgs(owner, [f.organizationId, g.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [...Object.values(f.users), ...Object.values(g.users)] } } });
  await owner.$disconnect();
});

describe("ingestEvent", () => {
  it("stores the raw event encrypted and hashed, and a normalized, encrypted message", async () => {
    const src = await newSource();
    const payload = syntheticInbox(src.externalId)[0]!;
    const out = await ingest(src, ev(payload));
    expect(out).toMatchObject({ result: "MESSAGE_CREATED", rawEventCreated: true });

    const raw = await owner.rawEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, externalId: payload.id } });
    expect(raw.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(raw.payload).includes(Buffer.from(payload.body))).toBe(false); // not plaintext
    expect(JSON.parse(decryptField(raw.payload, testKey, `${f.organizationId}:RawEvent.payload`))).toEqual(JSON.parse(canonicalJson(payload)));

    const msg = await owner.message.findFirstOrThrow({ where: { organizationId: f.organizationId, externalMessageId: payload.id } });
    expect(Buffer.from(msg.bodyText).includes(Buffer.from(payload.body))).toBe(false);
    expect(decryptField(msg.bodyText, testKey, `${f.organizationId}:Message.bodyText`)).toBe(payload.body);
    expect([msg.rawEventId, msg.monitoredSourceId, msg.direction, msg.subject]).toEqual([raw.id, src.id, payload.direction, payload.subject]);
  });

  it("replaying the same event creates nothing new (exit criterion)", async () => {
    const src = await newSource();
    const event = ev(syntheticInbox(src.externalId)[0]!);
    const first = await ingest(src, event);
    const before = await counts();
    for (let i = 0; i < 3; i++) {
      const again = await ingest(src, event);
      expect(again).toMatchObject({ result: "MESSAGE_EXISTS", rawEventCreated: false });
      expect((again as { messageId: string }).messageId).toBe((first as { messageId: string }).messageId);
    }
    expect(await counts()).toEqual(before);
  });

  it("survives many concurrent replays of one event: exactly one of everything, no errors", async () => {
    const src = await newSource();
    const event = ev(syntheticInbox(src.externalId)[1]!);
    const before = await counts();
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => ingest(src, event)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const created = results.filter((r) => r.status === "fulfilled" && r.value.result === "MESSAGE_CREATED");
    expect(created).toHaveLength(1);
    const after = await counts();
    expect(after.map((n, i) => n - before[i]!)).toEqual([1, 1, 1, 1]);
  });

  it("dedupes a message the provider re-sends under a different event id", async () => {
    const src = await newSource();
    const payload = syntheticInbox(src.externalId)[0]!;
    await ingest(src, ev(payload));
    const before = await counts();
    const out = await ingest(src, ev(payload, `resend-${randomUUID()}`));
    expect(out).toMatchObject({ result: "MESSAGE_EXISTS", rawEventCreated: true }); // the new raw event is kept as evidence
    const after = await counts();
    expect(after.map((n, i) => n - before[i]!)).toEqual([1, 0, 0, 0]);
  });

  it("keeps the original when an event id is re-sent with different content", async () => {
    const src = await newSource();
    const payload = syntheticInbox(src.externalId)[0]!;
    await ingest(src, ev(payload));
    const before = await counts();
    const out = await ingest(src, ev({ ...payload, body: "Edited body that must not overwrite the original." }));
    expect(out.result).toBe("PAYLOAD_CONFLICT");
    expect(await counts()).toEqual(before);
    const msg = await owner.message.findFirstOrThrow({ where: { organizationId: f.organizationId, externalMessageId: payload.id } });
    expect(decryptField(msg.bodyText, testKey, `${f.organizationId}:Message.bodyText`)).toBe(payload.body);
  });

  it("stores malformed events raw, opens one review task, and never creates a message", async () => {
    const src = await newSource();
    const good = syntheticInbox(src.externalId)[0]!;
    const poison = [{ ...good, id: "poison-1", from: { address: "nope" } }, { ...good, id: "poison-2", body: "" }, { id: "poison-3", junk: true }];
    const msgsBefore = (await counts())[1]!;
    for (const p of poison) {
      for (let i = 0; i < 2; i++) expect((await ingest(src, ev(p))).result).toBe("MALFORMED"); // replay is stable
    }
    expect((await counts())[1]).toBe(msgsBefore);
    const raws = await owner.rawEvent.findMany({ where: { organizationId: f.organizationId, externalId: { startsWith: "poison-" } } });
    expect(raws).toHaveLength(3);
    const tasks = await owner.reviewTask.findMany({ where: { organizationId: f.organizationId, type: "SCHEMA_FAILURE", refId: { in: raws.map((r) => r.id) } } });
    expect(tasks).toHaveLength(3); // one per raw event, even after replays
    expect(tasks.every((t) => t.status === "OPEN" && t.refType === "RawEvent")).toBe(true);
  });

  it("groups messages by thread and sender, case-insensitively", async () => {
    const src = await newSource();
    const [a, b] = syntheticInbox(src.externalId).filter((e) => e.threadId.endsWith("sso-login"));
    const t0 = (await counts())[2]!;
    await ingest(src, ev(a!));
    await ingest(src, ev({ ...b!, id: `${b!.id}-b`, from: { address: a!.from.address.toUpperCase() }, direction: "INBOUND" }));
    const msgs = await owner.message.findMany({ where: { organizationId: f.organizationId, externalMessageId: { in: [a!.id, `${b!.id}-b`] } } });
    expect(new Set(msgs.map((m) => m.threadId)).size).toBe(1);
    expect(new Set(msgs.map((m) => m.senderParticipantId)).size).toBe(1);
    expect((await counts())[2]).toBe(t0 + 1);
  });

  it("keeps organizations separate: the same provider ids land in each tenant independently", async () => {
    const connG = (await owner.monitoredSource.findUniqueOrThrow({ where: { id: g.sourceId } })).connectionId;
    const srcF = await newSource("shared-box");
    const srcG = await newSource("shared-box", g, connG);
    const payload = syntheticInbox("shared-box")[0]!;
    await ingest(srcF, ev(payload));
    await ingest(srcG, ev(payload), g);
    expect((await owner.message.findMany({ where: { externalMessageId: payload.id, organizationId: { in: [f.organizationId, g.organizationId] } } })).length).toBe(2);
    expect(await inOrg((tx) => tx.message.count({ where: { externalMessageId: payload.id } }), f)).toBe(1);
    expect(await inOrg((tx) => tx.rawEvent.count({ where: { externalId: payload.id } }), g)).toBe(1);
  });
});

describe("syncSource", () => {
  it("ingests a whole mailbox, advances the cursor, and queues one analysis job per message", async () => {
    const src = await newSource();
    const out = await syncSource({ organizationId: f.organizationId, monitoredSourceId: src.id }, deps());
    expect(out).toMatchObject({ status: "SYNCED", events: TOTAL, messagesCreated: TOTAL, messagesExisting: 0, malformed: 0, hasMore: false });
    const row = await owner.monitoredSource.findUniqueOrThrow({ where: { id: src.id } });
    expect([row.cursor, row.lastSyncedAt !== null]).toEqual([String(TOTAL), true]);
    const msgIds = (await owner.message.findMany({ where: { monitoredSourceId: src.id } })).map((m) => m.id);
    expect(msgIds).toHaveLength(TOTAL);
    const jobs = (await analyzeJobs()).filter((j) => msgIds.includes(j.data.messageId));
    expect(jobs).toHaveLength(TOTAL);
    for (const j of jobs) expect(Object.keys(j.data).sort()).toEqual(["messageId", "organizationId"]); // ids only
  });

  it("replaying the same events twice creates no duplicates and no extra jobs (exit criterion)", async () => {
    const src = await newSource();
    const input = { organizationId: f.organizationId, monitoredSourceId: src.id };
    await syncSource(input, deps());
    const dbBefore = await counts();
    const jobsBefore = (await analyzeJobs()).length;

    expect((await syncSource(input, deps())).events).toBe(0); // caught up: nothing to fetch

    await owner.monitoredSource.update({ where: { id: src.id }, data: { cursor: null } }); // force a full replay
    const replay = await syncSource(input, deps());
    expect(replay).toMatchObject({ events: TOTAL, messagesCreated: 0, messagesExisting: TOTAL });
    expect(await counts()).toEqual(dbBefore);
    expect((await analyzeJobs()).length).toBe(jobsBefore);
  });

  it("works through a backlog in pages, continuing in a follow-up job", async () => {
    const src = await newSource();
    const input = { organizationId: f.organizationId, monitoredSourceId: src.id };
    const first = await syncSource(input, deps({ pageSize: 5, maxPages: 2 }));
    expect(first).toMatchObject({ pages: 2, events: 10, hasMore: true });
    const cont = (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => j.data.monitoredSourceId === src.id);
    expect(cont).toHaveLength(1); // exactly one continuation, queued by cursor
    const rest = await syncSource(input, deps({ pageSize: 5, maxPages: 2 }));
    expect(rest).toMatchObject({ events: TOTAL - 10, hasMore: false });
    expect(await owner.message.count({ where: { monitoredSourceId: src.id } })).toBe(TOTAL);
  });

  it("stores a page all-or-nothing: a failure rolls the whole page back and leaves the cursor alone", async () => {
    const src = await newSource();
    let n = 0;
    const flaky: ProviderAdapter = { ...adapter, normalize: (e) => { if (++n === 3) throw new Error("boom"); return adapter.normalize(e); } };
    await expect(syncSource({ organizationId: f.organizationId, monitoredSourceId: src.id }, deps({ adapterFor: () => flaky }))).rejects.toThrow("boom");
    expect(await owner.message.count({ where: { monitoredSourceId: src.id } })).toBe(0);
    expect(await owner.rawEvent.count({ where: { organizationId: f.organizationId, externalId: { startsWith: src.externalId } } })).toBe(0);
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: src.id } })).cursor).toBeNull();
    // A clean retry then succeeds with nothing duplicated.
    expect((await syncSource({ organizationId: f.organizationId, monitoredSourceId: src.id }, deps())).messagesCreated).toBe(TOTAL);
  });

  it("never strands a stored message without an analysis job: a failure after commit is repaired by the retry", async () => {
    const src = await newSource();
    const input = { organizationId: f.organizationId, monitoredSourceId: src.id };
    const brokenHub = Object.create(hub) as QueueHub;
    brokenHub.enqueue = async () => { throw new Error("redis unavailable"); };
    await expect(syncSource(input, deps({ hub: brokenHub }))).rejects.toThrow("redis unavailable");
    // Messages are stored but the cursor did not move, so the retry will see the page again.
    expect(await owner.message.count({ where: { monitoredSourceId: src.id } })).toBeGreaterThan(0);
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: src.id } })).cursor).toBeNull();

    const before = await counts();
    const retry = await syncSource(input, deps());
    expect(retry.messagesCreated + retry.messagesExisting).toBe(TOTAL);
    expect((await counts())[1]).toBe(before[1]); // no duplicates
    const msgIds = (await owner.message.findMany({ where: { monitoredSourceId: src.id } })).map((m) => m.id);
    const queued = new Set((await analyzeJobs()).map((j) => j.data.messageId));
    expect(msgIds.every((id) => queued.has(id))).toBe(true); // every message has its job
  });

  it("is safe when two workers sync the same source at once", async () => {
    const src = await newSource();
    const input = { organizationId: f.organizationId, monitoredSourceId: src.id };
    const results = await Promise.allSettled([syncSource(input, deps()), syncSource(input, deps()), syncSource(input, deps())]);
    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
      expect(["SYNCED", "CURSOR_MOVED"]).toContain(r.value.status);
    }
    expect(await owner.message.count({ where: { monitoredSourceId: src.id } })).toBe(TOTAL);
    expect(await owner.rawEvent.count({ where: { organizationId: f.organizationId, externalId: { startsWith: src.externalId } } })).toBe(TOTAL);
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: src.id } })).cursor).toBe(String(TOTAL));
  });

  it("skips missing, disabled and inactive-connection sources without ingesting", async () => {
    const off = await newSource();
    await owner.monitoredSource.update({ where: { id: off.id }, data: { enabled: false } });
    const conn = await owner.sourceConnection.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", ownerUserId: f.users.admin, scopes: [], status: "REVOKED" } });
    const revoked = await newSource(undefined, f, conn.id);
    const run = (id: string) => syncSource({ organizationId: f.organizationId, monitoredSourceId: id }, deps());
    expect(await run(off.id)).toMatchObject({ status: "SKIPPED", reason: "SOURCE_DISABLED" });
    expect(await run(revoked.id)).toMatchObject({ status: "SKIPPED", reason: "CONNECTION_INACTIVE" });
    expect(await run(randomUUID())).toMatchObject({ status: "SKIPPED", reason: "SOURCE_NOT_FOUND" });
    expect(await owner.message.count({ where: { monitoredSourceId: { in: [off.id, revoked.id] } } })).toBe(0);
    // Another organization's source id is invisible too.
    expect(await syncSource({ organizationId: g.organizationId, monitoredSourceId: off.id }, deps())).toMatchObject({ status: "SKIPPED", reason: "SOURCE_NOT_FOUND" });
  });

  it("keeps going past a poison event: it is recorded, counted, and never queued for analysis", async () => {
    const src = await newSource();
    const data = (box: string) => [...syntheticInbox(box).slice(0, 3), { id: `${box}/poison`, nonsense: true }, ...syntheticInbox(box).slice(3, 6)];
    const out = await syncSource({ organizationId: f.organizationId, monitoredSourceId: src.id }, deps({ adapterFor: () => createSyntheticAdapter({ events: data }) }));
    expect(out).toMatchObject({ status: "SYNCED", events: 7, messagesCreated: 6, malformed: 1 });
    expect((await owner.monitoredSource.findUniqueOrThrow({ where: { id: src.id } })).cursor).toBe("7");
    const jobs = (await analyzeJobs()).filter((j) => j.data.organizationId === f.organizationId);
    const msgIds = new Set((await owner.message.findMany({ where: { monitoredSourceId: src.id } })).map((m) => m.id));
    expect(jobs.filter((j) => msgIds.has(j.data.messageId))).toHaveLength(6);
  });
});

describe("enqueueOrganizationSync", () => {
  it("queues only active, enabled sources matching the prefix, one job each, and never another organization's", async () => {
    const { enqueueOrganizationSync } = await import("@/modules/ingestion");
    const wanted = await newSource(`prefix-${randomUUID().slice(0, 6)}-a`);
    const other = await newSource(`other-${randomUUID().slice(0, 6)}`);
    const off = await newSource(`prefix-${randomUUID().slice(0, 6)}-off`);
    await owner.monitoredSource.update({ where: { id: off.id }, data: { enabled: false } });
    const key = `t-${randomUUID().slice(0, 6)}`;
    const queued = await enqueueOrganizationSync(f.organizationId, hub, key, { externalIdPrefix: "prefix-" });
    expect(queued).toContain(wanted.id);
    expect([other.id, off.id].some((id) => queued.includes(id))).toBe(false);
    expect(await enqueueOrganizationSync(f.organizationId, hub, key, { externalIdPrefix: "prefix-" })).toEqual(queued); // same key: same jobs
    const jobs = (await waitingJobs(hub, QUEUES.ingestSource)).filter((j) => queued.includes(j.data.monitoredSourceId));
    expect(jobs).toHaveLength(queued.length);
    expect(await enqueueOrganizationSync(g.organizationId, hub, key, { externalIdPrefix: "prefix-" })).toEqual([]);
  });
});
