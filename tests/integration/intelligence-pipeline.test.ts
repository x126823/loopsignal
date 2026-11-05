import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decryptField } from "@/lib/crypto/fields";
import { createPrismaClient, withTenant } from "@/lib/db";
import { FakeProvider, ProviderError, runAnalyzer, type AnalyzerDefinition, type FakeReply, type PipelineDeps } from "@/modules/intelligence";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createEngineFixture, createMessage, createThreadWithMessage, type EngineFixture } from "../helpers/engine-fixture";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;
let g: EngineFixture;

const ackDetector: AnalyzerDefinition<{ isAcknowledgment: boolean }> = {
  name: "test_ack_detector", promptVersion: "test-1",
  instructions: "Decide whether the most recent outbound message acknowledges receipt without answering the request.",
  resultSchema: z.object({ isAcknowledgment: z.boolean() }).strict(),
};

const QUOTE = "we have received your request";
const TEXT = `Thanks, ${QUOTE} and will look into it.`;
const good = (messageId: string, over: Record<string, unknown> = {}): FakeReply => ({
  kind: "output",
  json: { result: { isAcknowledgment: true }, confidence: 0.95, evidence: [{ messageId, quote: QUOTE }], recommendedAction: "TRANSITION_ACKNOWLEDGED", requiresHumanApproval: false, ...over },
});
const deps = (provider: FakeProvider, over: Partial<PipelineDeps> = {}): PipelineDeps => ({ provider, fieldKey: testKey, ...over });
const analyze = (fx: EngineFixture, provider: FakeProvider, messageId: string, over: Partial<PipelineDeps> = {}, def = ackDetector) =>
  runAnalyzer(def, { organizationId: fx.organizationId, messageIds: [messageId], subjectMessageId: messageId }, deps(provider, over));
const runsFor = (fx: EngineFixture, where: Record<string, unknown> = {}) => owner.analysisRun.findMany({ where: { organizationId: fx.organizationId, analyzer: "test_ack_detector", ...where } });
const msg = async (text = TEXT, fx = f) => (await createThreadWithMessage(owner, fx, text)).messageId;

beforeAll(async () => {
  f = await createEngineFixture(owner);
  g = await createEngineFixture(owner);
});

afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId, g.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [...Object.values(f.users), ...Object.values(g.users)] } } });
  await owner.$disconnect();
});

describe("a successful analysis", () => {
  it("returns the validated recommendation and persists a complete AnalysisRun", async () => {
    const id = await msg();
    const provider = new FakeProvider((req) => good(req.user.match(/id="([0-9a-f-]{36})"/)![1]!));
    const out = await analyze(f, provider, id);
    expect(out).toMatchObject({ outcome: "OK", cached: false, result: { isAcknowledgment: true }, confidence: 0.95, recommendedAction: "TRANSITION_ACKNOWLEDGED", requiresHumanApproval: false });
    if (out.outcome !== "OK") throw new Error();
    const run = await owner.analysisRun.findUniqueOrThrow({ where: { id: out.analysisRunId } });
    expect(run).toMatchObject({
      analyzer: "test_ack_detector", provider: "fake", model: "fake-1", promptVersion: "test-1", status: "OK", messageId: id,
      confidence: 0.95, recommendedAction: "TRANSITION_ACKNOWLEDGED", requiresHumanApproval: false,
    });
    expect(run.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.tokensIn).toBeGreaterThan(0);
    expect(run.evidence).toEqual([{ messageId: id, quote: QUOTE }]);
    expect(run.output).toMatchObject({ result: { isAcknowledgment: true }, recommendedAction: "TRANSITION_ACKNOWLEDGED" });
  });

  it("sends content only inside the delimited user block, redacted, and never in the system prompt", async () => {
    const secretText = `Hi, my card is 4111 1111 1111 1111 and password: hunter2. ${TEXT}`;
    const id = await msg(secretText);
    const provider = new FakeProvider((req) => good(req.user.match(/id="([0-9a-f-]{36})"/)![1]!));
    expect((await analyze(f, provider, id)).outcome).toBe("OK");
    const sent = provider.calls[0]!;
    expect(sent.system).not.toContain(QUOTE);
    expect(sent.system).toContain("UNTRUSTED DATA");
    expect(sent.user).toContain(QUOTE);
    expect(sent.user).not.toMatch(/4111|hunter2/);
    expect(sent.user).toContain("[REDACTED:CARD_NUMBER]");
    expect(sent.user).toContain("password: [REDACTED:CREDENTIAL]");
    const stored = await owner.message.findUniqueOrThrow({ where: { id } });
    expect(decryptField(stored.bodyText, testKey, `${f.organizationId}:Message.bodyText`)).toBe(secretText); // the record itself is untouched
  });

  it("rejects a quote that spans a redaction, because it is not in the original", async () => {
    const id = await msg("Please use password: hunter2 for the account.");
    const provider = new FakeProvider(() => good(id, { evidence: [{ messageId: id, quote: "password: [REDACTED:CREDENTIAL]" }] }));
    expect(await analyze(f, provider, id)).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "EVIDENCE_NOT_VERBATIM" });
  });
});

describe("caching", () => {
  it("serves an identical analysis from the cache without calling the provider", async () => {
    const id = await msg();
    const provider = new FakeProvider(() => good(id));
    const first = await analyze(f, provider, id);
    const second = await analyze(f, provider, id);
    expect(provider.calls).toHaveLength(1);
    expect(second).toMatchObject({ outcome: "OK", cached: true });
    expect((second as { analysisRunId: string }).analysisRunId).toBe((first as { analysisRunId: string }).analysisRunId);
    expect(await runsFor(f, { messageId: id })).toHaveLength(1);
  });

  it("misses when the prompt version, the model or the message text changes", async () => {
    const id = await msg();
    const provider = new FakeProvider(() => good(id));
    await analyze(f, provider, id);
    await analyze(f, provider, id, {}, { ...ackDetector, promptVersion: "test-2" });
    await analyze(f, new FakeProvider(() => good(id), "fake-2"), id);
    const other = await msg(`Different words entirely, but ${QUOTE} still appears here.`);
    await analyze(f, new FakeProvider(() => good(other)), other);
    expect((await runsFor(f, { messageId: { in: [id, other] } })).length).toBe(4);
  });

  it("is never shared across organizations, even for identical text", async () => {
    const a = await msg(TEXT, f);
    const b = await msg(TEXT, g);
    const pa = new FakeProvider(() => good(a));
    const pb = new FakeProvider(() => good(b));
    await analyze(f, pa, a);
    await analyze(g, pb, b);
    expect([pa.calls.length, pb.calls.length]).toEqual([1, 1]);
    const seen = await withTenant({ organizationId: g.organizationId }, (tx) => tx.analysisRun.findMany({ where: { analyzer: "test_ack_detector" } }));
    expect(seen.every((r) => r.organizationId === g.organizationId)).toBe(true);
  });

  it("does not let a failure block a later success for the same input", async () => {
    const id = await msg();
    expect((await analyze(f, new FakeProvider(() => good(id, { evidence: [{ messageId: id, quote: "invented quote" }] })), id)).outcome).toBe("NEEDS_REVIEW");
    expect((await analyze(f, new FakeProvider(() => good(id)), id)).outcome).toBe("OK");
  });

  it("collapses concurrent identical analyses to one stored result", async () => {
    const id = await msg();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => analyze(f, new FakeProvider(() => good(id)), id)));
    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
      expect(r.value.outcome).toBe("OK");
    }
    expect(await runsFor(f, { messageId: id, status: "OK" })).toHaveLength(1);
  });
});

describe("invalid output: one bounded retry, then human review", () => {
  it("retries once and succeeds when the second answer is valid, summing usage", async () => {
    const id = await msg();
    const provider = new FakeProvider((_r, n) => (n === 1 ? { kind: "output", json: { nonsense: true } } : good(id)));
    const out = await analyze(f, provider, id);
    expect(out.outcome).toBe("OK");
    expect(provider.calls).toHaveLength(2);
    const run = await owner.analysisRun.findUniqueOrThrow({ where: { id: (out as { analysisRunId: string }).analysisRunId } });
    expect(run.tokensIn).toBeGreaterThan(provider.calls[0]!.system.length / 4); // both attempts counted
  });

  it("gives up after exactly two attempts, records SCHEMA_FAILED without the raw output, and queues a review", async () => {
    const id = await msg();
    const provider = new FakeProvider(() => ({ kind: "output", json: { leaked: "LEAKY-RAW-OUTPUT with the customer's words" } }));
    const out = await analyze(f, provider, id);
    expect(out).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "SCHEMA_FAILED" });
    expect(provider.calls).toHaveLength(2); // bounded
    if (out.outcome !== "NEEDS_REVIEW") throw new Error();
    const run = await owner.analysisRun.findUniqueOrThrow({ where: { id: out.analysisRunId! } });
    expect(run.status).toBe("SCHEMA_FAILED");
    expect(JSON.stringify(run)).not.toContain("LEAKY-RAW-OUTPUT");
    const task = await owner.reviewTask.findUniqueOrThrow({ where: { id: out.reviewTaskId! } });
    expect([task.type, task.status, task.refType, task.refId]).toEqual(["SCHEMA_FAILURE", "OPEN", "AnalysisRun", run.id]);
  });

  it("treats truncated output and non-JSON as invalid", async () => {
    const id = await msg();
    expect(await analyze(f, new FakeProvider(() => ({ kind: "truncated" })), id)).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "SCHEMA_FAILED" });
    const id2 = await msg(`${TEXT} (second)`);
    expect(await analyze(f, new FakeProvider(() => ({ kind: "output", json: undefined })), id2)).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "SCHEMA_FAILED" });
  });

  it("routes a refusal to review immediately: no retry, no other model", async () => {
    const id = await msg();
    const provider = new FakeProvider(() => ({ kind: "refusal", category: "cyber" }));
    const out = await analyze(f, provider, id);
    expect(out).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "REFUSED" });
    expect(provider.calls).toHaveLength(1);
    if (out.outcome !== "NEEDS_REVIEW") throw new Error();
    const run = await owner.analysisRun.findUniqueOrThrow({ where: { id: out.analysisRunId! } });
    expect([run.status, run.output]).toEqual(["REJECTED_GUARD", { reason: "REFUSED", category: "cyber" }]);
  });
});

describe("the evidence guard (rule 6)", () => {
  const cases: Array<[string, (id: string) => Record<string, unknown>, string]> = [
    ["a quote that is not in the message", (id) => ({ evidence: [{ messageId: id, quote: "the customer confirmed it is fixed" }] }), "EVIDENCE_NOT_VERBATIM"],
    ["a near-miss quote (different case)", (id) => ({ evidence: [{ messageId: id, quote: QUOTE.toUpperCase() }] }), "EVIDENCE_NOT_VERBATIM"],
    ["a message the analyzer was never given", () => ({ evidence: [{ messageId: randomUUID(), quote: QUOTE }] }), "EVIDENCE_UNKNOWN_MESSAGE"],
    ["no evidence for an action that asserts something", () => ({ evidence: [] }), "MISSING_EVIDENCE"],
  ];
  for (const [name, over, reason] of cases) {
    it(`rejects ${name}`, async () => {
      const id = await msg();
      const out = await analyze(f, new FakeProvider(() => good(id, over(id))), id);
      expect(out).toMatchObject({ outcome: "NEEDS_REVIEW", reason });
      if (out.outcome !== "NEEDS_REVIEW") throw new Error();
      expect((await owner.analysisRun.findUniqueOrThrow({ where: { id: out.analysisRunId! } })).status).toBe("REJECTED_GUARD");
      expect(await owner.reviewTask.count({ where: { id: out.reviewTaskId!, status: "OPEN" } })).toBe(1);
    });
  }
});

describe("human approval is forced, not trusted", () => {
  for (const action of ["TRANSITION_RESOLUTION_CONFIRMED", "TRANSITION_CLOSED", "TRANSITION_REOPENED"] as const) {
    it(`forces requiresHumanApproval for ${action} even at full confidence when the model says no`, async () => {
      const id = await msg();
      const out = await analyze(f, new FakeProvider(() => good(id, { recommendedAction: action, confidence: 1, requiresHumanApproval: false })), id);
      expect(out).toMatchObject({ outcome: "OK", requiresHumanApproval: true });
      if (out.outcome !== "OK") throw new Error();
      expect((await owner.analysisRun.findUniqueOrThrow({ where: { id: out.analysisRunId } })).requiresHumanApproval).toBe(true);
    });
  }
  it("forces it below the confidence threshold, and leaves routine confident steps alone", async () => {
    const low = await msg("Low confidence case: we have received your request.");
    expect(await analyze(f, new FakeProvider(() => good(low, { confidence: 0.5 })), low)).toMatchObject({ outcome: "OK", requiresHumanApproval: true });
    const high = await msg();
    expect(await analyze(f, new FakeProvider(() => good(high, { confidence: 0.95 })), high)).toMatchObject({ outcome: "OK", requiresHumanApproval: false });
  });
});

describe("limits and budget", () => {
  it("rejects oversized input instead of truncating it, without calling the provider", async () => {
    const id = await msg(`${TEXT} ${"x".repeat(25_000)}`);
    const provider = new FakeProvider(() => good(id));
    const out = await analyze(f, provider, id);
    expect(out).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "INPUT_TOO_LARGE" });
    expect(provider.calls).toHaveLength(0);
    const many = await Promise.all(Array.from({ length: 4 }, (_, i) => msg(`${TEXT} #${i}`)));
    const tooMany = await runAnalyzer(ackDetector, { organizationId: f.organizationId, messageIds: many, subjectMessageId: many[0]! }, deps(provider, { limits: { maxMessages: 3 } }));
    expect(tooMany).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "INPUT_TOO_LARGE" });
    expect(provider.calls).toHaveLength(0);
  });

  it("stops calling the provider once the organization's daily budget is spent, but still serves cached results", async () => {
    const fx = await createEngineFixture(owner);
    try {
      await owner.organization.update({ where: { id: fx.organizationId }, data: { settings: { llm: { dailyTokenBudget: 50 } } } });
      const first = await msg(TEXT, fx);
      const provider = new FakeProvider(() => good(first));
      expect((await analyze(fx, provider, first)).outcome).toBe("OK"); // starts under budget, spends more than 50 tokens
      const second = await msg(`${TEXT} Another one.`, fx);
      const blocked = await analyze(fx, new FakeProvider(() => good(second)), second);
      expect(blocked).toMatchObject({ outcome: "BUDGET_EXCEEDED", budget: 50 });
      expect((blocked as { used: number }).used).toBeGreaterThan(50);
      expect(await owner.analysisRun.count({ where: { organizationId: fx.organizationId, messageId: second } })).toBe(0); // no call, no row
      expect(await analyze(fx, provider, first)).toMatchObject({ outcome: "OK", cached: true }); // cache beats budget
      // Other organizations are unaffected, and the window rolls over at UTC midnight.
      const other = await msg(TEXT, f);
      expect((await analyze(f, new FakeProvider(() => good(other)), other)).outcome).toBe("OK");
      const tomorrow = new Date(Date.now() + 36 * 3_600_000);
      expect((await analyze(fx, new FakeProvider(() => good(second)), second, { now: () => tomorrow })).outcome).toBe("OK");
    } finally {
      await purgeOrgs(owner, [fx.organizationId]);
      await owner.user.deleteMany({ where: { id: { in: Object.values(fx.users) } } });
    }
  });

  it("reports a missing or foreign message as needs-review without calling the provider or writing a run", async () => {
    const provider = new FakeProvider(() => good(randomUUID()));
    const foreign = await msg(TEXT, g);
    const before = (await runsFor(f)).length;
    for (const id of [randomUUID(), foreign]) {
      expect(await analyze(f, provider, id)).toMatchObject({ outcome: "NEEDS_REVIEW", reason: "MESSAGE_NOT_FOUND", analysisRunId: null });
    }
    expect(provider.calls).toHaveLength(0);
    expect((await runsFor(f)).length).toBe(before);
  });

  it("lets provider failures propagate for the queue to retry, recording nothing", async () => {
    const id = await msg();
    const before = (await runsFor(f)).length;
    await expect(analyze(f, new FakeProvider(() => ({ kind: "error", error: new ProviderError(true, "RATE_LIMITED") })), id)).rejects.toMatchObject({ retryable: true, code: "RATE_LIMITED" });
    expect((await runsFor(f)).length).toBe(before);
  });
});

describe("rule 10: no content in logs", () => {
  it("never logs message text, secrets or model output on success, failure or refusal", async () => {
    const marker = "TOP-SECRET-MARKER-XYZ";
    const text = `${marker} card 4111 1111 1111 1111. ${TEXT}`;
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];
    try {
      const a = await msg(text);
      await analyze(f, new FakeProvider(() => good(a)), a);
      const b = await msg(`${marker} second ${TEXT}`);
      await analyze(f, new FakeProvider(() => ({ kind: "output", json: { echo: marker } })), b);
      const c = await msg(`${marker} third ${TEXT}`);
      await analyze(f, new FakeProvider(() => ({ kind: "refusal" })), c);
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged.length).toBeGreaterThan(50); // it did log something
      expect(logged).not.toMatch(/TOP-SECRET-MARKER|4111|we have received/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

void createMessage;
