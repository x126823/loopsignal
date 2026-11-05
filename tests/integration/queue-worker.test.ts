import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { deadLetterName, deadLetterRecord, jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { handleIngestSourceJob } from "@/modules/ingestion";
import { syntheticInbox } from "@/modules/integrations";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { createTestHub, destroyTestHub, waitFor, waitingJobs } from "../helpers/queue";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const TOTAL = syntheticInbox("x").length;
let f: EngineFixture;
let hub: QueueHub;
let connectionId: string;

const newSource = (externalId = `box-${randomUUID().slice(0, 8)}`, provider: "SYNTHETIC" | "GMAIL" = "SYNTHETIC") =>
  (async () => {
    const conn = provider === "SYNTHETIC" ? connectionId
      : (await owner.sourceConnection.create({ data: { organizationId: f.organizationId, provider, ownerUserId: f.users.admin, scopes: [] } })).id;
    return owner.monitoredSource.create({ data: { organizationId: f.organizationId, connectionId: conn, kind: "MAILBOX", externalId } });
  })();
const dead = (queue: (typeof QUEUES)[keyof typeof QUEUES]) => hub.queue(deadLetterName(queue)).getJobs(["waiting", "completed", "delayed", "failed"]);

beforeAll(async () => {
  f = await createEngineFixture(owner);
  connectionId = (await owner.monitoredSource.findUniqueOrThrow({ where: { id: f.sourceId } })).connectionId;
  hub = createTestHub();
});

afterAll(async () => {
  await destroyTestHub(hub);
  await purgeOrgs(owner, [f.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
  await owner.$disconnect();
});

describe("enqueueing", () => {
  it("is idempotent by job id: the same id queues one job", async () => {
    const job = { organizationId: f.organizationId, messageId: randomUUID() };
    await hub.enqueue(QUEUES.analyzeMessage, job, jobIds.analyzeMessage(job));
    await hub.enqueue(QUEUES.analyzeMessage, job, jobIds.analyzeMessage(job));
    const matching = (await waitingJobs(hub, QUEUES.analyzeMessage)).filter((j) => j.data.messageId === job.messageId);
    expect(matching).toHaveLength(1);
  });

  it("refuses a payload with anything beyond ids, so content cannot enter a queue", async () => {
    const before = (await waitingJobs(hub, QUEUES.analyzeMessage)).length;
    await expect(hub.enqueue(QUEUES.analyzeMessage, { organizationId: f.organizationId, messageId: randomUUID(), body: "secret" }, "x-1")).rejects.toThrow();
    await expect(hub.enqueue(QUEUES.analyzeMessage, { organizationId: "nope", messageId: randomUUID() }, "x-2")).rejects.toThrow();
    expect((await waitingJobs(hub, QUEUES.analyzeMessage)).length).toBe(before);
  });
});

describe("a real worker running the ingest handler", () => {
  it("ingests a mailbox end to end, and a second trigger changes nothing (exit criterion)", async () => {
    const src = await newSource();
    const worker = hub.worker(QUEUES.ingestSource, (job) => handleIngestSourceJob(job.data, { hub, fieldKey: testKey }));
    try {
      const job = { organizationId: f.organizationId, monitoredSourceId: src.id };
      await hub.enqueue(QUEUES.ingestSource, job, jobIds.ingestSource(job, "first"));
      await waitFor(async () => (await owner.message.count({ where: { monitoredSourceId: src.id } })) === TOTAL, 15_000, "messages");
      await waitFor(async () => ((await hub.queue(QUEUES.ingestSource).getJobCounts("completed")).completed ?? 0) >= 1, 15_000, "job completion");

      const snapshot = async () => [
        await owner.message.count({ where: { monitoredSourceId: src.id } }),
        await owner.rawEvent.count({ where: { organizationId: f.organizationId, externalId: { startsWith: src.externalId } } }),
        (await waitingJobs(hub, QUEUES.analyzeMessage)).length,
      ];
      const before = await snapshot();
      expect(before.slice(0, 2)).toEqual([TOTAL, TOTAL]);

      // Replay: reset the cursor and trigger again as a brand new job.
      await owner.monitoredSource.update({ where: { id: src.id }, data: { cursor: null } });
      await hub.enqueue(QUEUES.ingestSource, job, jobIds.ingestSource(job, "second"));
      await waitFor(async () => ((await hub.queue(QUEUES.ingestSource).getJobCounts("completed")).completed ?? 0) >= 2, 15_000, "second job");
      expect(await snapshot()).toEqual(before);
      expect(await dead(QUEUES.ingestSource)).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });
});

describe("retries and the dead-letter queue", () => {
  const job = () => ({ organizationId: f.organizationId, messageId: randomUUID() });
  // Earlier tests leave analysis jobs in this queue; a worker here would process them too and skew the counts.
  beforeEach(async () => { await hub.queue(QUEUES.analyzeMessage).drain(true); });

  it("retries a transient failure with backoff and then completes, without dead-lettering", async () => {
    let calls = 0;
    const j = job();
    const worker = hub.worker<{ organizationId: string; messageId: string }>(QUEUES.analyzeMessage, async (q) => {
      if (q.data.messageId !== j.messageId) return "other";
      if (++calls < 3) throw new Error("transient");
      return "ok";
    });
    try {
      await hub.enqueue(QUEUES.analyzeMessage, j, jobIds.analyzeMessage(j));
      const done = await waitFor(async () => {
        const found = await hub.queue(QUEUES.analyzeMessage).getJob(jobIds.analyzeMessage(j));
        return found && (await found.isCompleted()) ? found : false;
      }, 15_000, "completion after retries");
      expect([calls, done.attemptsMade]).toEqual([3, 3]);
      expect((await dead(QUEUES.analyzeMessage)).filter((d) => d.data.data.messageId === j.messageId)).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });

  it("dead-letters a job that exhausts its attempts, keeping ids and the error class but never the message", async () => {
    let calls = 0;
    const j = job();
    const worker = hub.worker<{ organizationId: string; messageId: string }>(QUEUES.analyzeMessage, async (q) => {
      if (q.data.messageId !== j.messageId) return "other";
      calls++;
      const err = new Error("could not process: SECRET-BODY-TEXT Dear customer, your password is hunter2");
      (err as { code?: string }).code = "E_PROCESSING";
      throw err;
    });
    try {
      await hub.enqueue(QUEUES.analyzeMessage, j, jobIds.analyzeMessage(j));
      const record = await waitFor(async () => (await dead(QUEUES.analyzeMessage)).find((d) => d.data.data.messageId === j.messageId), 20_000, "dead letter");
      expect(calls).toBe(5);
      const parsed = deadLetterRecord.parse(record.data);
      expect(parsed).toMatchObject({ queue: QUEUES.analyzeMessage, errorName: "Error", errorCode: "E_PROCESSING", attemptsMade: 5, data: j });
      const dump = JSON.stringify(record.data);
      expect(dump).not.toMatch(/SECRET-BODY-TEXT|hunter2|Dear customer/); // rule 10
    } finally {
      await worker.close();
    }
  });

  it("dead-letters an unrecoverable error immediately, without burning retries", async () => {
    let calls = 0;
    const j = job();
    const worker = hub.worker<{ organizationId: string; messageId: string }>(QUEUES.analyzeMessage, async (q) => {
      if (q.data.messageId !== j.messageId) return "other";
      calls++;
      throw new UnrecoverableError("never going to work");
    });
    try {
      await hub.enqueue(QUEUES.analyzeMessage, j, jobIds.analyzeMessage(j));
      const record = await waitFor(async () => (await dead(QUEUES.analyzeMessage)).find((d) => d.data.data.messageId === j.messageId), 15_000, "dead letter");
      expect(calls).toBe(1);
      expect(deadLetterRecord.parse(record.data)).toMatchObject({ errorName: "UnrecoverableError", attemptsMade: 1 });
    } finally {
      await worker.close();
    }
  });
});

describe("handleIngestSourceJob classification", () => {
  it("treats an invalid payload as unrecoverable", async () => {
    for (const bad of [null, {}, { organizationId: "x" }, { organizationId: f.organizationId, monitoredSourceId: randomUUID(), extra: 1 }]) {
      await expect(handleIngestSourceJob(bad, { hub })).rejects.toBeInstanceOf(UnrecoverableError);
    }
  });

  it("treats a provider with no adapter as unrecoverable (real providers arrive in Sprints 11-12)", async () => {
    const gmail = await newSource(undefined, "GMAIL");
    await expect(handleIngestSourceJob({ organizationId: f.organizationId, monitoredSourceId: gmail.id }, { hub })).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("returns a skip, not an error, for a source that no longer exists", async () => {
    const out = await handleIngestSourceJob({ organizationId: f.organizationId, monitoredSourceId: randomUUID() }, { hub });
    expect(out).toMatchObject({ status: "SKIPPED", reason: "SOURCE_NOT_FOUND" });
  });
});
