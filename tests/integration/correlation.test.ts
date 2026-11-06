import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant } from "@/lib/db";
import { confirmCandidate, listCandidates, listAwaitingFollowUp, rejectCandidate, runFollowUp, splitCandidate } from "@/modules/correlation";
import { ForbiddenError } from "@/modules/identity";
import { HeuristicProvider, type LLMProvider } from "@/modules/intelligence";
import { apply, propose } from "@/modules/lifecycle";
import { handleAnalyzeMessage, type AnalyzeDeps } from "../../src/workers/analyze-message";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { at, createEngineFixture, createMessage, engineOpts, NOW, type EngineFixture } from "../helpers/engine-fixture";

/**
 * Sprint 9 exit criterion: uncertain matches always reach the review queue; nothing is ever linked or merged without a person.
 * The mailbox is the fixture's own source; the chat space is a second source routed to the same team.
 */
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const created: EngineFixture[] = [];
const heuristic = new HeuristicProvider();
const deps = (provider: LLMProvider = heuristic): AnalyzeDeps => ({ provider, pipeline: { fieldKey: testKey }, engine: engineOpts, now: () => NOW });

const MAIL = "Our checkout page returns an error for all our customers right now. Order #48213 failed.";
const CHAT = "Checkout is broken, customers get an error on the checkout page. Order #48213 is stuck.";
const ACK = "Thanks, we have received this and will look into it.";
const OTHER_TOPIC = "Please help, our warehouse scanner will not pair with the tablet.";

let f: EngineFixture;
let chatSourceId: string;

async function setup(): Promise<{ fx: EngineFixture; chatSource: string }> {
  const fx = await createEngineFixture(owner);
  created.push(fx);
  const base = await owner.monitoredSource.findUniqueOrThrow({ where: { id: fx.sourceId } });
  const chat = await owner.monitoredSource.create({ data: { organizationId: fx.organizationId, connectionId: base.connectionId, kind: "SPACE", externalId: `chat-${randomUUID()}`, teamId: fx.teamId } });
  return { fx, chatSource: chat.id };
}
async function thread(fx: EngineFixture) {
  return (await owner.thread.create({ data: { organizationId: fx.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } })).id;
}
const handle = (messageId: string, d = deps(), fx = f) => handleAnalyzeMessage({ organizationId: fx.organizationId, messageId }, d);

async function mailItem(text = MAIL, minute = 0, fx = f) {
  const threadId = await thread(fx);
  const m = await createMessage(owner, fx, threadId, text, minute, "INBOUND", fx.sourceId);
  const out = await handle(m.id, deps(), fx);
  if (out.status !== "ITEM_CREATED") throw new Error(`expected ITEM_CREATED, got ${JSON.stringify(out)}`);
  return { threadId, messageId: m.id, itemId: out.itemId };
}
async function chatMessage(text = CHAT, minute = 20, threadId?: string, direction: "INBOUND" | "OUTBOUND" = "INBOUND", fx = f, source = chatSourceId) {
  const t = threadId ?? (await thread(fx));
  return { threadId: t, messageId: (await createMessage(owner, fx, t, text, minute, direction, source)).id };
}
const itemRow = (itemId: string) => owner.trackedItem.findUniqueOrThrow({ where: { id: itemId } });
const candidatesFor = (messageId: string) => owner.correlationCandidate.findMany({ where: { subjectId: messageId } });
const reviewTasks = (candidateId: string) => owner.reviewTask.findMany({ where: { type: "CORRELATION", refType: "CorrelationCandidate", refId: candidateId } });
const auditActions = async (entityId: string) => (await owner.auditLog.findMany({ where: { entityId }, orderBy: { seq: "asc" } })).map((a) => a.action);

/** A provider that gives the heuristic's answers, except for the correlation analyzer. */
const withCorrelation = (reply: (req: Parameters<LLMProvider["complete"]>[0]) => ReturnType<LLMProvider["complete"]>): LLMProvider => ({
  name: "scripted", model: "scripted-1",
  complete: (req) => (req.analyzer === "correlation_analyzer" ? reply(req) : heuristic.complete(req)),
});

// A fresh organization per test: open items from one test would (correctly) be candidates for the next.
beforeEach(async () => {
  const s = await setup();
  f = s.fx;
  chatSourceId = s.chatSource;
});
afterAll(async () => {
  await purgeOrgs(owner, created.map((c) => c.organizationId));
  await owner.user.deleteMany({ where: { id: { in: created.flatMap((c) => Object.values(c.users)) } } });
  await owner.$disconnect();
});

describe("finding candidates", () => {
  it("queues a likely duplicate for a person and creates no item for it", async () => {
    const mail = await mailItem();
    const before = await itemRow(mail.itemId);
    const chat = await chatMessage();
    const out = await handle(chat.messageId);
    expect(out).toMatchObject({ status: "CORRELATION_PENDING" });

    expect(await owner.trackedItem.count({ where: { threadId: chat.threadId } })).toBe(0); // held until a person decides
    const [cand] = await candidatesFor(chat.messageId);
    expect(cand).toMatchObject({ status: "PENDING", targetItemId: mail.itemId, decidedBy: null, decidedAt: null, followUpAt: null });
    expect(cand!.score).toBeGreaterThanOrEqual(0.45);
    const rationale = cand!.rationale as { signals: Array<{ name: string }>; verdict?: { sameMatter: string } };
    expect(rationale.signals.map((s) => s.name)).toEqual(["time", "sender", "reference", "text"]);
    expect(rationale.verdict?.sameMatter).toBe("yes");
    expect(JSON.stringify(cand!.rationale)).not.toMatch(/48213|checkout|customers/i); // counts only, never message text or identifiers

    const tasks = await reviewTasks(cand!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "OPEN" });
    expect(await auditActions(cand!.id)).toEqual(["correlation.candidate_queued"]);
    expect(await itemRow(mail.itemId)).toEqual(before); // finding a candidate never touches the item (rule 1)
    // The advisory run is recorded but is not attached to any item.
    expect(await owner.analysisRun.count({ where: { messageId: chat.messageId, analyzer: "correlation_analyzer", itemId: null } })).toBe(1);
  });

  it("tells the people who can decide, once, and nobody who cannot", async () => {
    await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    await handle(chat.messageId); // replay
    const cand = (await candidatesFor(chat.messageId))[0]!;
    const told = (u: string) => owner.notification.count({ where: { recipientUserId: u, type: "review_correlation", channel: "IN_APP", dedupeKey: `candidate:${cand.id}` } });
    expect([await told(f.users.member), await told(f.users.lead), await told(f.users.admin)]).toEqual([1, 1, 1]);
    expect([await told(f.users.viewer), await told(f.users.auditor), await told(f.users.otherTeamMember)]).toEqual([0, 0, 0]);
  });

  it("is idempotent: replaying the job asks the question once", async () => {
    await mailItem();
    const chat = await chatMessage();
    const a = await handle(chat.messageId);
    const b = await handle(chat.messageId);
    expect(b).toEqual(a);
    const cands = await candidatesFor(chat.messageId);
    expect(cands).toHaveLength(1);
    expect(await reviewTasks(cands[0]!.id)).toHaveLength(1);
    expect(await owner.analysisRun.count({ where: { messageId: chat.messageId, analyzer: "correlation_analyzer" } })).toBe(1); // cached
  });

  it("a second message in the same waiting thread joins the open question without a model call or a second task", async () => {
    await mailItem();
    const chat = await chatMessage();
    const first = await handle(chat.messageId);
    const runs = await owner.analysisRun.count({ where: { organizationId: f.organizationId } });
    const followUp = await chatMessage("Any news? Order #48213 is still stuck and the error continues.", 25, chat.threadId);
    expect(await handle(followUp.messageId)).toEqual(first);
    expect(await owner.analysisRun.count({ where: { organizationId: f.organizationId } })).toBe(runs);
    expect(await owner.correlationCandidate.count({ where: { subjectId: followUp.messageId } })).toBe(0);
  });

  it("a different matter simply starts its own item", async () => {
    await mailItem();
    const chat = await chatMessage(OTHER_TOPIC);
    expect(await handle(chat.messageId)).toMatchObject({ status: "ITEM_CREATED" });
    expect(await candidatesFor(chat.messageId)).toHaveLength(0);
  });

  it("a weak match never reaches a person, whatever the advisory model says", async () => {
    await mailItem();
    const yes = withCorrelation(async () => ({ kind: "output", json: { result: { sameMatter: "unsure" }, confidence: 0.9, evidence: [], recommendedAction: "NONE", requiresHumanApproval: false }, tokensIn: 1, tokensOut: 1, model: "m" }));
    const chat = await chatMessage("Please help, the printer on the third floor keeps jamming on double sided pages.");
    expect(await handle(chat.messageId, deps(yes))).toMatchObject({ status: "ITEM_CREATED" });
    expect(await candidatesFor(chat.messageId)).toHaveLength(0);
  });

  it("never offers a match inside the same source: separate threads there are separate matters", async () => {
    await mailItem(MAIL, 0);
    const second = await thread(f);
    const m = await createMessage(owner, f, second, CHAT, 20, "INBOUND", f.sourceId);
    expect(await handle(m.id)).toMatchObject({ status: "ITEM_CREATED" });
    expect(await owner.correlationCandidate.count({ where: { subjectId: m.id } })).toBe(0);
  });

  it("ignores items more than a day away", async () => {
    await mailItem(MAIL, 0);
    const chat = await chatMessage(CHAT, 25 * 60);
    expect(await handle(chat.messageId)).toMatchObject({ status: "ITEM_CREATED" });
  });

  it("never considers another organization's items", async () => {
    const other = await setup();
    const theirs = await mailItem(MAIL, 0, other.fx);
    const chat = await chatMessage(CHAT, 20, undefined, "INBOUND", f, chatSourceId);
    const out = await handle(chat.messageId);
    expect(out).toMatchObject({ status: "ITEM_CREATED" });
    expect(await owner.correlationCandidate.count({ where: { targetItemId: theirs.itemId } })).toBe(0);
  });

  it("a confident 'no' from the advisory model keeps the message out of the queue", async () => {
    await mailItem();
    const no = withCorrelation(async () => ({ kind: "output", json: { result: { sameMatter: "no" }, confidence: 0.95, evidence: [], recommendedAction: "NONE", requiresHumanApproval: false }, tokensIn: 1, tokensOut: 1, model: "m" }));
    const chat = await chatMessage();
    expect(await handle(chat.messageId, deps(no))).toMatchObject({ status: "ITEM_CREATED" });
    expect(await candidatesFor(chat.messageId)).toHaveLength(0);
  });

  it("an unusable or missing verdict never hides the question: a person decides, and no extra review task appears", async () => {
    await mailItem();
    const junk = withCorrelation(async () => ({ kind: "output", json: { result: { sameMatter: "maybe" } }, tokensIn: 1, tokensOut: 1, model: "m" }));
    const tasksBefore = await owner.reviewTask.count({ where: { organizationId: f.organizationId, type: "SCHEMA_FAILURE" } });
    const chat = await chatMessage();
    expect(await handle(chat.messageId, deps(junk))).toMatchObject({ status: "CORRELATION_PENDING" });
    expect(await owner.reviewTask.count({ where: { organizationId: f.organizationId, type: "SCHEMA_FAILURE" } })).toBe(tasksBefore); // advisory: no extra task
    expect((await candidatesFor(chat.messageId))[0]!.rationale).not.toHaveProperty("verdict");
  });

  it("an 'unsure' verdict still reaches a person", async () => {
    await mailItem();
    const unsure = withCorrelation(async () => ({ kind: "output", json: { result: { sameMatter: "unsure" }, confidence: 0.9, evidence: [], recommendedAction: "NONE", requiresHumanApproval: false }, tokensIn: 1, tokensOut: 1, model: "m" }));
    const chat = await chatMessage();
    expect(await handle(chat.messageId, deps(unsure))).toMatchObject({ status: "CORRELATION_PENDING" });
  });
});

describe("a person decides", () => {
  async function pending() {
    const mail = await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const cand = (await candidatesFor(chat.messageId))[0]!;
    return { mail, chat, cand };
  }

  it("confirming attaches the thread to the item: no second item, no state change, fully audited", async () => {
    const { mail, chat, cand } = await pending();
    const before = await itemRow(mail.itemId);
    const out = await confirmCandidate(f.principals.member, { candidateId: cand.id });
    expect(out).toEqual({ outcome: "CONFIRMED", itemId: mail.itemId, linkedMessages: 1 });

    expect(await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).toMatchObject({ status: "CONFIRMED", decidedBy: f.users.member });
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).decidedAt).toBeInstanceOf(Date);
    expect(await owner.itemMessageLink.findMany({ where: { itemId: mail.itemId, messageId: chat.messageId } })).toMatchObject([{ role: "OTHER" }]);
    expect(await owner.trackedItem.count({ where: { threadId: chat.threadId } })).toBe(0);
    expect(await itemRow(mail.itemId)).toEqual(before); // a link is not a transition
    expect(await reviewTasks(cand.id)).toMatchObject([{ status: "RESOLVED" }]);
    expect(await auditActions(cand.id)).toEqual(["correlation.candidate_queued", "correlation.confirmed"]);
  });

  it("our reply in the attached thread then acts on the item, and the customer's chatter does not", async () => {
    const { mail, chat, cand } = await pending();
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    const reply = await chatMessage(ACK, 30, chat.threadId, "OUTBOUND");
    expect(await handle(reply.messageId)).toEqual({ status: "ACKNOWLEDGED", itemId: mail.itemId });
    expect((await itemRow(mail.itemId)).state).toBe("ACKNOWLEDGED");
    const chatter = await chatMessage("Thanks, still waiting on this one.", 40, chat.threadId);
    expect(await handle(chatter.messageId)).toMatchObject({ status: "SKIPPED", reason: "INBOUND_ON_OPEN_ITEM" });
    // The link now records that this message carried history (role upgraded from OTHER).
    expect(await owner.itemMessageLink.findFirstOrThrow({ where: { itemId: mail.itemId, messageId: reply.messageId } })).toMatchObject({ role: "ACK" });
  });

  it("rejecting keeps them apart; the message then starts its own item and is not asked about again", async () => {
    const { mail, chat, cand } = await pending();
    expect(await rejectCandidate(f.principals.lead, { candidateId: cand.id })).toEqual({ outcome: "REJECTED", itemId: mail.itemId });
    expect(await owner.itemMessageLink.count({ where: { itemId: mail.itemId, messageId: chat.messageId } })).toBe(0);
    expect(await auditActions(cand.id)).toEqual(["correlation.candidate_queued", "correlation.rejected"]);
    expect(await handle(chat.messageId)).toMatchObject({ status: "ITEM_CREATED" }); // what the follow-up does
    expect(await owner.correlationCandidate.count({ where: { subjectId: chat.messageId } })).toBe(1); // no new candidate
  });

  it("only one of several simultaneous deciders wins", async () => {
    const { cand } = await pending();
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? confirmCandidate(f.principals.lead, { candidateId: cand.id }) : rejectCandidate(f.principals.member, { candidateId: cand.id }))));
    expect(results.filter((r) => r.outcome === "CONFIRMED" || r.outcome === "REJECTED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "REFUSED" && r.reason === "ALREADY_DECIDED")).toHaveLength(15);
    expect(await owner.auditLog.count({ where: { entityId: cand.id, action: { in: ["correlation.confirmed", "correlation.rejected"] } } })).toBe(1);
  });

  it("a decided candidate cannot be decided again", async () => {
    const { cand } = await pending();
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    expect(await rejectCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "ALREADY_DECIDED" });
    expect(await confirmCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "ALREADY_DECIDED" });
  });

  it("cannot confirm into a closed item (a person can still reject)", async () => {
    const { mail, cand } = await pending();
    for (const [kind, to, min] of [["p", "RESPONDED", 200], ["p", "RESOLUTION_PROPOSED", 201], ["a", "RESOLUTION_CONFIRMED", 202], ["a", "CLOSED", 203]] as const) {
      const base = { organizationId: f.organizationId, itemId: mail.itemId, to, occurredAt: at(min) };
      const out = await withTenant({ organizationId: f.organizationId }, (tx) => (kind === "p" ? propose(tx, { ...base, actor: { type: "SYSTEM" } }, engineOpts) : apply(tx, { ...base, actor: { type: "USER", principal: f.principals.admin } }, engineOpts)));
      expect(out.outcome).toBe("APPLIED");
    }
    expect(await confirmCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "TARGET_CLOSED" });
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).status).toBe("PENDING");
    expect(await rejectCandidate(f.principals.member, { candidateId: cand.id })).toMatchObject({ outcome: "REJECTED" });
  });

  it("splitting undoes a confirmation when nothing was built on it, and the message then gets its own item", async () => {
    const { mail, chat, cand } = await pending();
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    expect(await splitCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "SPLIT", itemId: mail.itemId });
    expect(await owner.itemMessageLink.count({ where: { itemId: mail.itemId, messageId: chat.messageId } })).toBe(0);
    expect(await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).toMatchObject({ status: "REJECTED", followUpAt: null });
    expect(await auditActions(cand.id)).toEqual(["correlation.candidate_queued", "correlation.confirmed", "correlation.split"]);
    expect(await handle(chat.messageId)).toMatchObject({ status: "ITEM_CREATED" });
  });

  it("refuses to split once messages from the thread drove the item's history, and changes nothing", async () => {
    const { mail, chat, cand } = await pending();
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    await handle((await chatMessage(ACK, 30, chat.threadId, "OUTBOUND")).messageId); // acknowledges the item
    const before = await owner.itemMessageLink.count({ where: { itemId: mail.itemId } });
    expect(await splitCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "THREAD_HAS_HISTORY" });
    expect(await owner.itemMessageLink.count({ where: { itemId: mail.itemId } })).toBe(before);
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).status).toBe("CONFIRMED");
    expect(await owner.auditLog.count({ where: { entityId: cand.id, action: "correlation.split" } })).toBe(0);
  });

  it("only a pending-then-confirmed candidate can be split", async () => {
    const { cand } = await pending();
    expect(await splitCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "NOT_CONFIRMED" });
  });
});

describe("who may decide and see", () => {
  it("viewers, auditors and people from other teams or organizations cannot decide", async () => {
    await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const cand = (await candidatesFor(chat.messageId))[0]!;
    for (const who of ["viewer", "auditor", "otherTeamMember"] as const) {
      await expect(confirmCandidate(f.principals[who], { candidateId: cand.id })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(rejectCandidate(f.principals[who], { candidateId: cand.id })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const stranger = await setup();
    expect(await confirmCandidate(stranger.fx.principals.admin, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "NOT_FOUND" }); // row-level security hides it
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).status).toBe("PENDING");
    expect(await owner.auditLog.count({ where: { entityId: cand.id, action: { startsWith: "correlation." }, NOT: { action: "correlation.candidate_queued" } } })).toBe(0);
  });

  it("lists candidates with the message text only to people who may view the item, and says who can decide", async () => {
    await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const mine = (await listCandidates(f.principals.member, { status: "PENDING", fieldKey: testKey })).find((c) => c.subject.messageId === chat.messageId);
    expect(mine).toMatchObject({ canDecide: true, status: "PENDING", subject: { text: CHAT } });
    expect(mine!.signals.length).toBe(4);
    expect((await listCandidates(f.principals.viewer, { status: "PENDING", fieldKey: testKey })).find((c) => c.subject.messageId === chat.messageId)).toMatchObject({ canDecide: false });
    // A person from another team cannot view the item, so sees nothing of the candidate or the message.
    expect((await listCandidates(f.principals.otherTeamMember, { status: "PENDING", fieldKey: testKey })).some((c) => c.subject.messageId === chat.messageId)).toBe(false);
    const stranger = await setup();
    expect(await listCandidates(stranger.fx.principals.admin, { status: "PENDING", fieldKey: testKey })).toEqual([]);
  });
});

describe("the delete that a split needs is as narrow as possible", () => {
  it("is confined to one organization by row-level security, and no other table gained a delete", async () => {
    const mail = await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const cand = (await candidatesFor(chat.messageId))[0]!;
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    const link = await owner.itemMessageLink.findFirstOrThrow({ where: { itemId: mail.itemId, messageId: chat.messageId } });
    const stranger = await setup();
    // Another organization's context cannot see or delete the row, even by id.
    expect((await withTenant({ organizationId: stranger.fx.organizationId }, (tx) => tx.itemMessageLink.deleteMany({ where: { id: link.id } }))).count).toBe(0);
    expect(await owner.itemMessageLink.count({ where: { id: link.id } })).toBe(1);
    // History tables are still append-only for the app role.
    await expect(withTenant({ organizationId: f.organizationId }, (tx) => tx.lifecycleEvent.deleteMany({ where: { itemId: mail.itemId } }))).rejects.toThrow();
    await expect(withTenant({ organizationId: f.organizationId }, (tx) => tx.correlationCandidate.deleteMany({ where: { id: cand.id } }))).rejects.toThrow();
  });
});

describe("follow-up after a decision", () => {
  const recorder = () => {
    const queued: Array<{ messageId: string; jobId: string }> = [];
    return { queued, deps: { enqueueAnalysis: async (messageId: string, jobId: string) => { queued.push({ messageId, jobId }); }, jobId: (m: string, c: string) => `analyze-${m}-after-${c}` } };
  };

  it("after a rejection the message is analyzed again, once, and the decision is stamped only afterwards", async () => {
    await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const cand = (await candidatesFor(chat.messageId))[0]!;
    expect(await runFollowUp(f.organizationId, cand.id, recorder().deps)).toEqual({ outcome: "SKIPPED", reason: "UNDECIDED" });
    await rejectCandidate(f.principals.member, { candidateId: cand.id });
    expect((await listAwaitingFollowUp(f.principals.member)).map((a) => a.candidateId)).toContain(cand.id);

    const failing = { enqueueAnalysis: async () => { throw new Error("redis down"); }, jobId: () => "x" };
    await expect(runFollowUp(f.organizationId, cand.id, failing)).rejects.toThrow("redis down");
    expect((await owner.correlationCandidate.findUniqueOrThrow({ where: { id: cand.id } })).followUpAt).toBeNull(); // not stamped: it can be retried

    const r = recorder();
    expect(await runFollowUp(f.organizationId, cand.id, r.deps)).toEqual({ outcome: "QUEUED", messages: 1 });
    expect(r.queued).toEqual([{ messageId: chat.messageId, jobId: `analyze-${chat.messageId}-after-${cand.id}` }]);
    expect(await runFollowUp(f.organizationId, cand.id, r.deps)).toEqual({ outcome: "SKIPPED", reason: "ALREADY_DONE" });
    expect(r.queued).toHaveLength(1);
    expect((await listAwaitingFollowUp(f.principals.member)).map((a) => a.candidateId)).not.toContain(cand.id);
  });

  it("after a confirmation our earlier replies in the attached thread are analyzed against the item", async () => {
    await mailItem();
    const chat = await chatMessage();
    await handle(chat.messageId);
    const earlyReply = await chatMessage(ACK, 30, chat.threadId, "OUTBOUND"); // skipped at the time: no item yet
    expect(await handle(earlyReply.messageId)).toMatchObject({ status: "SKIPPED", reason: "OUR_OWN_MESSAGE_NO_ITEM" });
    const cand = (await candidatesFor(chat.messageId))[0]!;
    await confirmCandidate(f.principals.member, { candidateId: cand.id });
    const r = recorder();
    expect(await runFollowUp(f.organizationId, cand.id, r.deps)).toEqual({ outcome: "QUEUED", messages: 1 });
    expect(r.queued.map((q) => q.messageId)).toEqual([earlyReply.messageId]);
    expect(await handle(earlyReply.messageId)).toMatchObject({ status: "ACKNOWLEDGED" }); // what that job does
    // That reply was already attached (role OTHER) when it drove the transition, so the link now records the history it carries...
    expect(await owner.itemMessageLink.findFirstOrThrow({ where: { messageId: earlyReply.messageId } })).toMatchObject({ role: "ACK" });
    // ...and the conversation can no longer be detached.
    expect(await splitCandidate(f.principals.member, { candidateId: cand.id })).toEqual({ outcome: "REFUSED", reason: "THREAD_HAS_HISTORY" });
  });

  it("people who cannot decide see no pending follow-ups", async () => {
    expect(await listAwaitingFollowUp(f.principals.viewer)).toEqual([]);
  });
});
