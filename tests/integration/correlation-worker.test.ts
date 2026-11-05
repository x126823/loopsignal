import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { confirmCandidate, rejectCandidate } from "@/modules/correlation";
import { HeuristicProvider } from "@/modules/intelligence";
import { resolveReviewTask } from "@/modules/lifecycle";
import { handleAnalyzeMessage } from "../../src/workers/analyze-message";
import { handleCorrelationFollowUp } from "../../src/workers/correlation-follow-up";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createEngineFixture, createMessage, engineOpts, NOW, type EngineFixture } from "../helpers/engine-fixture";
import { createTestHub, destroyTestHub, waitingJobs } from "../helpers/queue";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let hub: QueueHub;
let f: EngineFixture;
let chatSource: string;

const handle = (messageId: string) => handleAnalyzeMessage({ organizationId: f.organizationId, messageId }, { provider: new HeuristicProvider(), pipeline: { fieldKey: testKey }, engine: engineOpts, now: () => NOW });
const newThread = async () => (await owner.thread.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } })).id;

const created: EngineFixture[] = [];
beforeAll(() => { hub = createTestHub(); });
// A fresh organization per test: open items from one test would (correctly) be candidates for the next.
beforeEach(async () => {
  f = await createEngineFixture(owner);
  created.push(f);
  const base = await owner.monitoredSource.findUniqueOrThrow({ where: { id: f.sourceId } });
  chatSource = (await owner.monitoredSource.create({ data: { organizationId: f.organizationId, connectionId: base.connectionId, kind: "SPACE", externalId: `chat-${randomUUID()}`, teamId: f.teamId } })).id;
});
afterAll(async () => {
  await destroyTestHub(hub);
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

async function pendingCandidate() {
  const mail = await createMessage(owner, f, await newThread(), "Our checkout page returns an error for all our customers right now. Order #48213 failed.", 0, "INBOUND", f.sourceId);
  expect(await handle(mail.id)).toMatchObject({ status: "ITEM_CREATED" });
  const chatThread = await newThread();
  const chat = await createMessage(owner, f, chatThread, "Checkout is broken, customers get an error on the checkout page. Order #48213 is stuck.", 20, "INBOUND", chatSource);
  await handle(chat.id);
  return { chat, chatThread, cand: await owner.correlationCandidate.findFirstOrThrow({ where: { subjectId: chat.id } }) };
}

describe("the correlation follow-up job", () => {
  it("queues one analysis for a rejected message under a distinct job id, and nothing the second time", async () => {
    const { chat, cand } = await pendingCandidate();
    await rejectCandidate(f.principals.member, { candidateId: cand.id });
    const job = { organizationId: f.organizationId, candidateId: cand.id };
    expect(await handleCorrelationFollowUp(job, { hub })).toEqual({ outcome: "QUEUED", messages: 1 });
    const queued = await waitingJobs(hub, QUEUES.analyzeMessage);
    expect(queued.map((j) => j.id)).toEqual([`analyze-${chat.id}-after-${cand.id}`]);
    expect(queued[0]!.data).toEqual({ organizationId: f.organizationId, messageId: chat.id }); // ids only
    expect(await handleCorrelationFollowUp(job, { hub })).toEqual({ outcome: "SKIPPED", reason: "ALREADY_DONE" });
    expect(await waitingJobs(hub, QUEUES.analyzeMessage)).toHaveLength(1);
    // That job finds nothing in the way, and the message becomes its own item.
    expect(await handle(chat.id)).toMatchObject({ status: "ITEM_CREATED" });
  });

  it("does nothing for an undecided candidate, and rejects a payload with extra fields", async () => {
    const { cand } = await pendingCandidate();
    expect(await handleCorrelationFollowUp({ organizationId: f.organizationId, candidateId: cand.id }, { hub })).toEqual({ outcome: "SKIPPED", reason: "UNDECIDED" });
    await expect(handleCorrelationFollowUp({ organizationId: f.organizationId, candidateId: cand.id, body: "hi" }, { hub })).rejects.toThrow(/Invalid correlation-follow-up job payload/);
    expect(await handleCorrelationFollowUp({ organizationId: f.organizationId, candidateId: randomUUID() }, { hub })).toEqual({ outcome: "SKIPPED", reason: "NOT_FOUND" });
  });

  it("after a confirmation, queues only our replies that came after the message", async () => {
    const { chat, chatThread, cand } = await pendingCandidate();
    const early = await createMessage(owner, f, chatThread, "Thanks, we have received this and will look into it.", 30, "OUTBOUND", chatSource);
    await createMessage(owner, f, chatThread, "More detail: it started after the deploy.", 35, "INBOUND", chatSource); // the customer's own: not queued
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    const before = (await waitingJobs(hub, QUEUES.analyzeMessage)).length;
    expect(await handleCorrelationFollowUp({ organizationId: f.organizationId, candidateId: cand.id }, { hub })).toEqual({ outcome: "QUEUED", messages: 1 });
    const jobs = await waitingJobs(hub, QUEUES.analyzeMessage);
    expect(jobs.length - before).toBe(1);
    expect(jobs.map((j) => j.id)).toContain(`analyze-${early.id}-after-${cand.id}`);
    expect(jobs.map((j) => j.id)).not.toContain(`analyze-${chat.id}-after-${cand.id}`);
  });
});

describe("the review queue cannot be used to bypass a decision", () => {
  it("refuses to close a cross-channel task with the generic resolve or dismiss, leaving the candidate pending", async () => {
    const { cand } = await pendingCandidate();
    const task = await owner.reviewTask.findFirstOrThrow({ where: { type: "CORRELATION", refId: cand.id } });
    for (const status of ["RESOLVED", "DISMISSED"] as const) {
      expect(await resolveReviewTask(f.principals.admin, { id: task.id, status })).toEqual({ outcome: "REJECTED", reason: "DECISION_REQUIRED" });
    }
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("OPEN");
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).status).toBe("PENDING");
    await confirmCandidate(f.principals.member, { candidateId: cand.id }); // the decision closes it
    expect((await owner.reviewTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("RESOLVED");
  });
});
