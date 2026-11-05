import { describe, expect, it } from "vitest";
import { ANALYZERS, type AnalyzerName } from "../analyzers";
import { FakeProvider } from "../fake-provider";
import { HeuristicProvider } from "../heuristic-provider";
import baseline from "./baselines/fake-heuristic-heuristic-1.json";
import { GOLDEN_SETS, runGolden, toBaseline, type Baseline } from "./harness";
import { REPLY_LABELS } from "./data/reply";

const names = Object.keys(GOLDEN_SETS) as AnalyzerName[];

describe("golden data integrity", () => {
  it("has unique case ids and message ids, and every case ends with the message being analyzed", () => {
    const caseIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const name of names) {
      for (const gc of GOLDEN_SETS[name]) {
        expect(caseIds.has(gc.id), `duplicate case id ${gc.id}`).toBe(false);
        caseIds.add(gc.id);
        expect(gc.messages.length).toBeGreaterThan(0);
        for (const m of gc.messages) {
          expect(messageIds.has(m.id), `duplicate message id in ${gc.id}`).toBe(false);
          messageIds.add(m.id);
          expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
        }
        const times = gc.messages.map((m) => m.sentAt.getTime());
        expect(times, `${gc.id} messages out of order`).toEqual([...times].sort((a, b) => a - b));
      }
    }
  });

  it("is large enough to mean something, and has both classes in every boolean set", () => {
    for (const name of names) expect(GOLDEN_SETS[name].length, name).toBeGreaterThanOrEqual(15);
    for (const [name, key] of [["intent_classifier", "actionable"], ["acknowledgment_detector", "isAcknowledgment"], ["substantive_response", "isSubstantive"]] as const) {
      const values = new Set(GOLDEN_SETS[name].map((c) => c.expected[key]));
      expect(values, name).toEqual(new Set([true, false]));
    }
  });

  it("only labels an ownership answer with a real candidate or null, and includes tricky negatives", () => {
    for (const gc of GOLDEN_SETS.ownership_resolver) {
      const owner = gc.expected["ownerUserId"];
      if (owner !== null) expect((gc.candidates ?? []).map((c) => c.id)).toContain(owner);
    }
    const negatives = GOLDEN_SETS.ownership_resolver.filter((c) => c.expected["ownerUserId"] === null);
    expect(negatives.length).toBeGreaterThanOrEqual(7);
  });

  it("never labels one reply as both an acknowledgment and a substantive response (rule 5)", () => {
    for (const l of REPLY_LABELS) expect(l.ack && l.sub, l.id).toBe(false);
    const pairs = REPLY_LABELS.map((l) => [l.id, GOLDEN_SETS.acknowledgment_detector.find((c) => c.id === `ack-${l.id}`)?.expected["isAcknowledgment"], GOLDEN_SETS.substantive_response.find((c) => c.id === `sub-${l.id}`)?.expected["isSubstantive"]] as const);
    for (const [id, ack, sub] of pairs) expect(ack === true && sub === true, id).toBe(false);
    expect(REPLY_LABELS.some((l) => l.ack)).toBe(true);
    expect(REPLY_LABELS.some((l) => l.sub)).toBe(true);
    expect(REPLY_LABELS.some((l) => !l.ack && !l.sub)).toBe(true);
  });
});

describe("recorded baseline (heuristic fake)", () => {
  it("is flagged as not meaningful for a real model", () => {
    expect((baseline as Baseline).notForProduction).toBe(true);
    expect(baseline.provider).toBe("fake-heuristic");
  });

  it("has not regressed, and is up to date with the prompt versions (re-run `npm run golden -- --write` after changing a prompt)", async () => {
    const report = await runGolden(new HeuristicProvider());
    for (const name of names) {
      const now = report[name];
      const was = (baseline as Baseline).analyzers[name]!;
      expect(now.promptVersion, `${name}: prompt version changed; re-record the baseline`).toBe(was.promptVersion);
      expect(now.promptVersion).toBe(ANALYZERS[name].promptVersion);
      expect(now.total, `${name}: golden set changed; re-record the baseline`).toBe(was.total);
      for (const metric of ["accuracy", "precision", "recall", "f1", "answered"] as const) expect(now[metric], `${name} ${metric}`).toBeGreaterThanOrEqual(was[metric]);
      expect(now.abstained).toBeLessThanOrEqual(was.abstained);
      if (was.wrongAssignments !== undefined) expect(now.wrongAssignments!, `${name} wrong assignments`).toBeLessThanOrEqual(was.wrongAssignments);
    }
  });

  it("matches what toBaseline would record now (so the file is not stale or hand-edited)", async () => {
    const provider = new HeuristicProvider();
    expect(toBaseline(provider, await runGolden(provider), true)).toEqual(baseline);
  });
});

describe("the harness scores honestly", () => {
  it("counts a provider that always abstains as abstained, not as correct, and as having found nothing", async () => {
    const report = await runGolden(new FakeProvider(() => ({ kind: "refusal" })));
    for (const name of names) {
      expect(report[name].answered).toBe(0);
      expect(report[name].abstained).toBe(report[name].total);
      expect(report[name].rows.every((r) => !r.correct && r.abstainedBecause === "REFUSED")).toBe(true);
      expect(report[name].recall, `${name}: abstaining must not score as perfect recall`).toBe(0);
    }
  });

  it("scores a provider that answers the opposite of the truth near zero", async () => {
    const wrong = new FakeProvider((req) => {
      const id = req.user.match(/<message_[0-9a-f]+ id="([0-9a-f-]{36})"/g)!.at(-1)!.match(/id="([0-9a-f-]{36})"/)![1]!;
      const text = req.user.match(/\n([\s\S]*?)\n<\/message_/g)!.at(-1)!.replace(/^\n|\n<\/message_$/g, "");
      const quote = text.slice(0, 20);
      const result = { intent_classifier: { actionable: false, kind: "other", priority: "NORMAL" }, ownership_resolver: { ownerUserId: null }, acknowledgment_detector: { isAcknowledgment: false }, substantive_response: { isSubstantive: false } }[req.analyzer];
      return { kind: "output", json: { result, confidence: 0.9, evidence: [{ messageId: id, quote }], recommendedAction: "NEEDS_REVIEW", requiresHumanApproval: false } };
    });
    const report = await runGolden(wrong);
    for (const name of names) expect(report[name].recall, name).toBe(0); // it finds none of the true positives
  });

  it("counts an ownership answer naming someone who is not a candidate as wrong, never as a pass", async () => {
    const stranger = "00000000-0000-4000-8000-0000000000aa";
    const report = await runGolden(new FakeProvider((req) => {
      const id = req.user.match(/id="([0-9a-f-]{36})"/)![1]!;
      const quote = req.user.match(/\n([^\n<]{4,30})/)![1]!.slice(0, 10);
      return { kind: "output", json: { result: { ownerUserId: stranger }, confidence: 0.99, evidence: [{ messageId: id, quote }], recommendedAction: "ASSIGN_OWNER", requiresHumanApproval: false } };
    }));
    const m = report.ownership_resolver;
    expect(m.rows.filter((r) => r.predicted === "INVALID_CANDIDATE").length).toBeGreaterThan(0);
    expect(m.rows.filter((r) => r.predicted === "INVALID_CANDIDATE").every((r) => !r.correct)).toBe(true);
    expect(m.wrongAssignments).toBeGreaterThan(0);
    expect(m.precision).toBe(0);
  });

  it("applies the evidence guard during evaluation: a fabricated quote makes the analyzer abstain", async () => {
    const report = await runGolden(new FakeProvider((req) => ({
      kind: "output",
      json: { result: { isAcknowledgment: true }, confidence: 0.99, evidence: [{ messageId: req.user.match(/id="([0-9a-f-]{36})"/)![1]!, quote: "this sentence is nowhere in the message" }], recommendedAction: "TRANSITION_ACKNOWLEDGED", requiresHumanApproval: false },
    })));
    expect(report.acknowledgment_detector.rows.every((r) => r.abstainedBecause !== null)).toBe(true);
  });

  it("is deterministic: two runs give identical reports", async () => {
    expect(await runGolden(new HeuristicProvider())).toEqual(await runGolden(new HeuristicProvider()));
  });
});
