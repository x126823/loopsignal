import { describe, expect, it } from "vitest";
import { ANALYZERS, acknowledgmentDetector, intentClassifier, ownershipResolver, substantiveResponseAnalyzer } from "./analyzers";
import { analyzerOutputSchema } from "./schemas";

const M = "11111111-1111-4111-8111-111111111111";
const base = { confidence: 0.9, evidence: [{ messageId: M, quote: "q" }], requiresHumanApproval: false };

describe("analyzer definitions", () => {
  it("have unique names, a prompt version, and instructions with no message content or template slots", () => {
    const defs = Object.values(ANALYZERS);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.promptVersion).toMatch(/^\d+$/);
      expect(d.instructions.length).toBeGreaterThan(200);
      expect(d.instructions).not.toMatch(/<untrusted|<message_|\{\{|\$\{/);
    }
  });

  it("registry keys match each analyzer's own name", () => {
    for (const [key, def] of Object.entries(ANALYZERS)) expect(def.name).toBe(key);
  });
});

describe("result schemas are strict", () => {
  it("intent: needs all three fields, valid enums, no extras", () => {
    const s = analyzerOutputSchema(intentClassifier.resultSchema);
    const ok = { ...base, recommendedAction: "TRACK", result: { actionable: true, kind: "request", priority: "HIGH" } };
    expect(s.safeParse(ok).success).toBe(true);
    for (const bad of [{ actionable: true }, { actionable: true, kind: "request", priority: "CRITICAL" }, { actionable: true, kind: "poem", priority: "LOW" }, { actionable: true, kind: "request", priority: "LOW", title: "leaks content" }]) {
      expect(s.safeParse({ ...ok, result: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("ownership: owner is a uuid or null, never free text", () => {
    const s = analyzerOutputSchema(ownershipResolver.resultSchema);
    expect(s.safeParse({ ...base, recommendedAction: "ASSIGN_OWNER", result: { ownerUserId: M } }).success).toBe(true);
    expect(s.safeParse({ ...base, recommendedAction: "NONE", result: { ownerUserId: null } }).success).toBe(true);
    expect(s.safeParse({ ...base, recommendedAction: "ASSIGN_OWNER", result: { ownerUserId: "Carol" } }).success).toBe(false);
  });
  it("acknowledgment and substantive: a single boolean each, no extras", () => {
    const ack = analyzerOutputSchema(acknowledgmentDetector.resultSchema);
    const sub = analyzerOutputSchema(substantiveResponseAnalyzer.resultSchema);
    expect(ack.safeParse({ ...base, recommendedAction: "NONE", result: { isAcknowledgment: false } }).success).toBe(true);
    expect(sub.safeParse({ ...base, recommendedAction: "NONE", result: { isSubstantive: false } }).success).toBe(true);
    expect(ack.safeParse({ ...base, recommendedAction: "NONE", result: { isAcknowledgment: "yes" } }).success).toBe(false);
    expect(sub.safeParse({ ...base, recommendedAction: "NONE", result: { isSubstantive: true, because: "..." } }).success).toBe(false);
  });
});
