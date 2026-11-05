import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzerOutputSchema, EVIDENCE_REQUIRED, RECOMMENDED_ACTIONS, transitionTarget } from "./schemas";

const M = "11111111-1111-4111-8111-111111111111";
const schema = analyzerOutputSchema(z.object({ isAck: z.boolean() }).strict());
const valid = { result: { isAck: true }, confidence: 0.9, evidence: [{ messageId: M, quote: "hi" }], recommendedAction: "NONE", requiresHumanApproval: false };

describe("analyzer output envelope", () => {
  it("accepts a well-formed output", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });
  it("is strict: extra fields (tool calls, overrides, injected keys) are rejected, at every level", () => {
    for (const extra of [{ toolCalls: [] }, { systemOverride: "x" }, { action: "close" }, { result: { isAck: true, extra: 1 } }]) {
      expect(schema.safeParse({ ...valid, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(schema.safeParse({ ...valid, evidence: [{ messageId: M, quote: "hi", extra: 1 }] }).success).toBe(false);
  });
  it("rejects bad types, ranges and unknown actions", () => {
    const bad: Array<Record<string, unknown>> = [
      { confidence: 1.01 }, { confidence: -0.1 }, { confidence: "high" }, { requiresHumanApproval: "false" },
      { recommendedAction: "DELETE_ITEM" }, { recommendedAction: "transition_closed" }, { evidence: [{ messageId: "nope", quote: "x" }] },
      { evidence: [{ messageId: M, quote: "" }] }, { evidence: [{ messageId: M, quote: "x".repeat(501) }] },
      { evidence: Array.from({ length: 6 }, () => ({ messageId: M, quote: "x" })) }, { result: { isAck: "yes" } },
    ];
    for (const b of bad) expect(schema.safeParse({ ...valid, ...b }).success, JSON.stringify(b)).toBe(false);
    for (const missing of Object.keys(valid)) {
      const without = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== missing));
      expect(schema.safeParse(without).success, `missing ${missing}`).toBe(false);
    }
  });
});

describe("recommended actions", () => {
  it("maps TRANSITION_* to lifecycle states and everything else to null", () => {
    expect(transitionTarget("TRANSITION_RESOLUTION_CONFIRMED")).toBe("RESOLUTION_CONFIRMED");
    expect(transitionTarget("TRANSITION_ACKNOWLEDGED")).toBe("ACKNOWLEDGED");
    for (const a of RECOMMENDED_ACTIONS.filter((x) => !x.startsWith("TRANSITION_"))) expect(transitionTarget(a)).toBeNull();
  });
  it("covers every lifecycle state a recommendation can target", () => {
    const targets = RECOMMENDED_ACTIONS.map(transitionTarget).filter(Boolean);
    expect(new Set(targets)).toEqual(new Set(["ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"]));
  });
  it("requires evidence for everything except no-op style actions", () => {
    expect([...EVIDENCE_REQUIRED].sort()).toEqual(RECOMMENDED_ACTIONS.filter((a) => !["NONE", "NOT_ACTIONABLE", "NEEDS_REVIEW"].includes(a)).sort());
  });
});
