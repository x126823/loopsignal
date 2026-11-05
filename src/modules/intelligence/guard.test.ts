import { describe, expect, it } from "vitest";
import { checkEvidence, forceApproval } from "./guard";
import type { AnalyzerOutput, RecommendedAction } from "./schemas";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const originals = new Map([[M1, "Thanks, we have received your request and will look into it."], [M2, "Totally unrelated second message."]]);
const out = (over: Partial<AnalyzerOutput<unknown>> = {}): AnalyzerOutput<unknown> => ({
  result: {}, confidence: 0.95, evidence: [{ messageId: M1, quote: "we have received your request" }],
  recommendedAction: "TRANSITION_ACKNOWLEDGED", requiresHumanApproval: false, ...over,
});

describe("checkEvidence", () => {
  it("accepts verbatim quotes from supplied messages", () => {
    expect(checkEvidence(out(), originals)).toBeNull();
    expect(checkEvidence(out({ evidence: [{ messageId: M1, quote: "Thanks" }, { messageId: M2, quote: "second message" }] }), originals)).toBeNull();
  });
  it("rejects a quote that is not a verbatim substring, however close", () => {
    for (const quote of ["we have received your request!", "WE HAVE RECEIVED", "we  have received", "we have received  your request", "we've received your request"]) {
      expect(checkEvidence(out({ evidence: [{ messageId: M1, quote }] }), originals), quote).toBe("EVIDENCE_NOT_VERBATIM");
    }
  });
  it("rejects a real quote attributed to the wrong message", () => {
    expect(checkEvidence(out({ evidence: [{ messageId: M2, quote: "we have received your request" }] }), originals)).toBe("EVIDENCE_NOT_VERBATIM");
  });
  it("rejects evidence citing a message the analyzer was never given", () => {
    expect(checkEvidence(out({ evidence: [{ messageId: "33333333-3333-4333-8333-333333333333", quote: "anything" }] }), originals)).toBe("EVIDENCE_UNKNOWN_MESSAGE");
  });
  it("rejects a quote that includes a redaction placeholder, since it is not in the original", () => {
    expect(checkEvidence(out({ evidence: [{ messageId: M1, quote: "password: [REDACTED:CREDENTIAL]" }] }), originals)).toBe("EVIDENCE_NOT_VERBATIM");
  });
  it("requires at least one quote for any action that asserts something", () => {
    const needs: RecommendedAction[] = ["TRACK", "ASSIGN_OWNER", "LINK_CANDIDATE", "TRANSITION_ACKNOWLEDGED", "TRANSITION_RESPONDED", "TRANSITION_IN_PROGRESS",
      "TRANSITION_RESOLUTION_PROPOSED", "TRANSITION_RESOLUTION_CONFIRMED", "TRANSITION_CLOSED", "TRANSITION_REOPENED"];
    for (const recommendedAction of needs) expect(checkEvidence(out({ recommendedAction, evidence: [] }), originals), recommendedAction).toBe("MISSING_EVIDENCE");
    for (const recommendedAction of ["NONE", "NOT_ACTIONABLE", "NEEDS_REVIEW"] as const) expect(checkEvidence(out({ recommendedAction, evidence: [] }), originals)).toBeNull();
  });
});

describe("forceApproval", () => {
  it("forces approval for confirm, close and reopen even at full confidence and when the model says no", () => {
    for (const recommendedAction of ["TRANSITION_RESOLUTION_CONFIRMED", "TRANSITION_CLOSED", "TRANSITION_REOPENED"] as const) {
      expect(forceApproval(out({ recommendedAction, confidence: 1, requiresHumanApproval: false }), 0.8), recommendedAction).toBe(true);
    }
  });
  it("forces approval below the confidence threshold", () => {
    expect(forceApproval(out({ confidence: 0.79 }), 0.8)).toBe(true);
    expect(forceApproval(out({ confidence: 0.8 }), 0.8)).toBe(false);
  });
  it("keeps the model's own request for approval, and does not add one for routine high-confidence steps", () => {
    expect(forceApproval(out({ requiresHumanApproval: true }), 0.8)).toBe(true);
    expect(forceApproval(out({ recommendedAction: "TRANSITION_RESPONDED" }), 0.8)).toBe(false);
  });
});
