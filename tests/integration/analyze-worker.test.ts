import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { deadLetterName, deadLetterRecord, jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { syncSource } from "@/modules/ingestion";
import { HeuristicProvider, ProviderError, type LLMProvider } from "@/modules/intelligence";
import { analyzeProcessor, type AnalyzeDeps } from "../../src/workers/analyze-message";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { at, createEngineFixture, createThreadWithMessage, engineOpts, type EngineFixture } from "../helpers/engine-fixture";
import { createTestHub, destroyTestHub, waitFor } from "../helpers/queue";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;
let hub: QueueHub;
let connectionId: string;

const heuristic = new HeuristicProvider();
const baseDeps = (provider: LLMProvider = heuristic): AnalyzeDeps => ({ provider, pipeline: { fieldKey: testKey }, engine: engineOpts });
const analyzeQueue = () => hub.queue(QUEUES.analyzeMessage);
const settled = async () => waitFor(async () => {
  const c = await analyzeQueue().getJobCounts("waiting", "active", "delayed", "prioritized");
  return Object.values(c).every((n) => n === 0) ? true : false;
}, 30_000, "the analyze queue to drain");
const enqueue = (organizationId: string, messageId: string) => {
  const job = { organizationId, messageId };
  return hub.enqueue(QUEUES.analyzeMessage, job, jobIds.analyzeMessage(job));
};

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

describe("the whole pipeline with a real worker: ingest, analyze, track", () => {
  it("turns a synthetic mailbox into correct items whatever order the concurrent jobs run in", async () => {
    const mailbox = `inbox-${randomUUID().slice(0, 8)}@synthetic.test`;
    const src = await owner.monitoredSource.create({ data: { organizationId: f.organizationId, connectionId, kind: "MAILBOX", externalId: mailbox, teamId: f.teamId } });
    const worker = hub.worker(QUEUES.analyzeMessage, analyzeProcessor(baseDeps()), { concurrency: 4 }); // concurrent: jobs interleave freely
    try {
      const sync = await syncSource({ organizationId: f.organizationId, monitoredSourceId: src.id }, { hub, fieldKey: testKey });
      expect(sync.messagesCreated).toBe(12);
      await settled();

      const thread = async (key: string) => owner.thread.findFirstOrThrow({ where: { organizationId: f.organizationId, externalThreadId: `${mailbox}/${key}` } });
      const itemOf = async (key: string) => owner.trackedItem.findFirst({ where: { threadId: (await thread(key)).id } });

      // Requests the classifier judges actionable become items; the replies on them are acknowledged / answered.
      const sso = (await itemOf("sso-login"))!;
      expect([sso.state, sso.teamId]).toEqual(["RESPONDED", f.teamId]);
      expect(sso.ackAt).not.toBeNull(); // "Received, looking into it now." came first
      expect(sso.firstSubstantiveResponseAt!.getTime()).toBeGreaterThan(sso.ackAt!.getTime());
      const invoice = (await itemOf("invoice-copy"))!;
      expect([invoice.state, invoice.ackAt]).toEqual(["RESPONDED", null]); // "Attached is ..." is a substantive reply, with no separate acknowledgment

      // Everything else was judged not actionable: no item, and our replies on those threads were not misread.
      for (const key of ["label-printer", "export-csv", "api-timeout", "welcome"]) expect(await itemOf(key), key).toBeNull();
      expect(await owner.trackedItem.count({ where: { organizationId: f.organizationId, thread: { externalThreadId: { startsWith: mailbox } } } })).toBe(2);

      // The timestamps are when the messages were SENT, not when the worker got to them.
      const ackMsg = await owner.message.findFirstOrThrow({ where: { organizationId: f.organizationId, externalMessageId: `${mailbox}/sso-login/1` } });
      expect(sso.ackAt).toEqual(ackMsg.sentAt);

      // One classification per inbound message, nothing failed, nothing dead-lettered, and every state is derivable from events.
      const messageIds = (await owner.message.findMany({ where: { monitoredSourceId: src.id }, select: { id: true } })).map((m) => m.id);
      expect(await owner.analysisRun.count({ where: { organizationId: f.organizationId, analyzer: "intent_classifier", messageId: { in: messageIds }, status: "OK" } })).toBe(6);
      expect((await analyzeQueue().getJobCounts("failed")).failed).toBe(0);
      expect(await hub.queue(deadLetterName(QUEUES.analyzeMessage)).getJobs(["waiting", "completed"])).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });
});

describe("worker behavior under failure", () => {
  it("defers a job, instead of failing it, when the organization's budget is spent", async () => {
    const fx = await createEngineFixture(owner);
    const worker = hub.worker(QUEUES.analyzeMessage, analyzeProcessor(baseDeps()));
    try {
      const first = await createThreadWithMessage(owner, fx, "Our checkout page returns an error. Can you look into this?", 0);
      await enqueue(fx.organizationId, first.messageId);
      await waitFor(async () => (await owner.trackedItem.count({ where: { threadId: first.threadId } })) === 1, 20_000, "first item");
      const spent = await owner.analysisRun.aggregate({ _sum: { tokensIn: true, tokensOut: true }, where: { organizationId: fx.organizationId } });
      await owner.organization.update({ where: { id: fx.organizationId }, data: { settings: { llm: { dailyTokenBudget: (spent._sum.tokensIn ?? 0) + (spent._sum.tokensOut ?? 0) } } } });

      const second = await createThreadWithMessage(owner, fx, "Another outage. Please help us urgently?", 0);
      await enqueue(fx.organizationId, second.messageId);
      const job = await waitFor(async () => {
        const j = await analyzeQueue().getJob(jobIds.analyzeMessage({ organizationId: fx.organizationId, messageId: second.messageId }));
        return j && (await j.getState()) === "delayed" ? j : false;
      }, 20_000, "the job to be delayed");
      expect(job.delay).toBeGreaterThan(0);
      expect(job.delay).toBeLessThanOrEqual(24 * 3_600_000 + 6 * 60_000);
      expect(await owner.trackedItem.count({ where: { threadId: second.threadId } })).toBe(0);
      expect(await hub.queue(deadLetterName(QUEUES.analyzeMessage)).getJobs(["waiting", "completed"])).toHaveLength(0);
    } finally {
      await worker.close();
      await purgeOrgs(owner, [fx.organizationId]);
      await owner.user.deleteMany({ where: { id: { in: Object.values(fx.users) } } });
    }
  }, 60_000);

  it("retries a transient provider error with backoff and then succeeds", async () => {
    let calls = 0;
    const flaky: LLMProvider = { name: heuristic.name, model: heuristic.model, complete: async (req) => { if (++calls === 1) throw new ProviderError(true, "RATE_LIMITED"); return heuristic.complete(req); } };
    const worker = hub.worker(QUEUES.analyzeMessage, analyzeProcessor(baseDeps(flaky)));
    try {
      const { threadId, messageId } = await createThreadWithMessage(owner, f, "Please look at my broken invoice, it is wrong. Can you help?", 0);
      await enqueue(f.organizationId, messageId);
      await waitFor(async () => (await owner.trackedItem.count({ where: { threadId } })) === 1, 20_000, "item after retry");
      const job = (await analyzeQueue().getJob(jobIds.analyzeMessage({ organizationId: f.organizationId, messageId })))!;
      expect(job.attemptsMade).toBeGreaterThanOrEqual(1);
      expect(calls).toBeGreaterThan(1);
    } finally {
      await worker.close();
    }
  }, 60_000);

  it("dead-letters a permanent provider error immediately, keeping ids only", async () => {
    const rejecting: LLMProvider = { name: "claude", model: "m", complete: async () => { throw new ProviderError(false, "AUTH"); } };
    const worker = hub.worker(QUEUES.analyzeMessage, analyzeProcessor(baseDeps(rejecting)));
    try {
      const { messageId } = await createThreadWithMessage(owner, f, "Please help, our export is broken. Can you look?", 0);
      await enqueue(f.organizationId, messageId);
      const dead = await waitFor(async () =>
        (await hub.queue(deadLetterName(QUEUES.analyzeMessage)).getJobs(["waiting", "completed", "delayed"])).find((d) => d.data.data.messageId === messageId), 20_000, "dead letter");
      expect(deadLetterRecord.parse(dead.data)).toMatchObject({ errorName: "UnrecoverableError", attemptsMade: 1, data: { organizationId: f.organizationId, messageId } });
      expect(JSON.stringify(dead.data)).not.toMatch(/AUTH|export is broken/); // neither the provider detail nor the message text
    } finally {
      await worker.close();
    }
  }, 60_000);
});

void at;
