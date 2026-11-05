import { describe, expect, it } from "vitest";
import type { ItemState } from "../../generated/prisma/enums";
import type { AcknowledgmentResult, EvidenceItem, IntentResult, OwnershipResult, ProgressResult, RecommendedAction, ResolutionResult, SubstantiveResult } from "@/modules/intelligence";
import { acceptedOwner, citesOnly, decideProgress, decideReply, decideResolution, nextBudgetWindow, shouldTrack, verifyReply, type Direction, type Ok } from "./analysis-plan";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ev = (messageId = SUBJECT, quote = "q"): EvidenceItem => ({ messageId, quote });
const ok = <R>(result: R, recommendedAction: RecommendedAction, over: Partial<Ok<R>> = {}): Ok<R> => ({
  outcome: "OK", analysisRunId: "run", cached: false, result, confidence: 0.95, evidence: [ev()], recommendedAction, requiresHumanApproval: false, ...over,
});
const sub = (isSubstantive: boolean, over: Partial<Ok<SubstantiveResult>> = {}) => ok<SubstantiveResult>({ isSubstantive }, isSubstantive ? "TRANSITION_RESPONDED" : "NONE", over);
const ack = (isAcknowledgment: boolean, over: Partial<Ok<AcknowledgmentResult>> = {}) => ok<AcknowledgmentResult>({ isAcknowledgment }, isAcknowledgment ? "TRANSITION_ACKNOWLEDGED" : "NONE", over);

describe("rule verification", () => {
  it("citesOnly needs at least one citation and nothing but the subject message", () => {
    expect(citesOnly({ evidence: [ev()] }, SUBJECT)).toBe(true);
    expect(citesOnly({ evidence: [] }, SUBJECT)).toBe(false);
    expect(citesOnly({ evidence: [ev(OTHER)] }, SUBJECT)).toBe(false);
    expect(citesOnly({ evidence: [ev(), ev(OTHER)] }, SUBJECT)).toBe(false);
  });

  it("a message from the outside can never be our acknowledgment or response, however it is worded", () => {
    expect(verifyReply({ evidence: [ev()] }, { id: SUBJECT, direction: "INBOUND" })).toBe(false);
    expect(verifyReply({ evidence: [ev()] }, { id: SUBJECT, direction: "OUTBOUND" })).toBe(true);
    expect(verifyReply({ evidence: [ev()] }, { id: SUBJECT, direction: "INTERNAL" })).toBe(true);
    expect(verifyReply({ evidence: [ev(OTHER)] }, { id: SUBJECT, direction: "OUTBOUND" })).toBe(false); // cites some other message
  });
});

describe("shouldTrack", () => {
  const intent = (actionable: boolean, action: RecommendedAction) => ok<IntentResult>({ actionable, kind: "request", priority: "NORMAL" }, action);
  it("tracks only when the recommendation and the result agree", () => {
    expect(shouldTrack(intent(true, "TRACK"))).toBe(true);
    expect(shouldTrack(intent(false, "TRACK"))).toBe(false); // contradictory: not trusted
    expect(shouldTrack(intent(true, "NOT_ACTIONABLE"))).toBe(false);
    expect(shouldTrack(intent(true, "NEEDS_REVIEW"))).toBe(false);
    expect(shouldTrack(intent(false, "NOT_ACTIONABLE"))).toBe(false);
  });
});

describe("acceptedOwner", () => {
  const CAROL = { id: "33333333-3333-4333-8333-333333333333", name: "Carol Member", handle: "carol" };
  const BOB = { id: "44444444-4444-4444-8444-444444444444", name: "Bob Lead", handle: "bob" };
  const team = [CAROL, BOB];
  const owner = (ownerUserId: string | null, over: Partial<Ok<OwnershipResult>> = {}) =>
    ok<OwnershipResult>({ ownerUserId }, ownerUserId ? "ASSIGN_OWNER" : "NONE", { evidence: [ev(SUBJECT, "Carol, could you take this")], ...over });

  it("accepts a confident, valid, explicitly named candidate", () => {
    expect(acceptedOwner(owner(CAROL.id), team, SUBJECT)).toBe(CAROL.id);
    expect(acceptedOwner(owner(CAROL.id, { evidence: [ev(SUBJECT, "@carol")] }), team, SUBJECT)).toBe(CAROL.id); // by handle
  });
  it("rejects each missing condition on its own", () => {
    expect(acceptedOwner(owner(null), team, SUBJECT)).toBeNull();
    expect(acceptedOwner(owner(CAROL.id, { recommendedAction: "NONE" }), team, SUBJECT)).toBeNull();
    expect(acceptedOwner(owner(CAROL.id, { requiresHumanApproval: true }), team, SUBJECT)).toBeNull(); // low confidence or flagged
    expect(acceptedOwner(owner("55555555-5555-4555-8555-555555555555"), team, SUBJECT)).toBeNull(); // not a team member
    expect(acceptedOwner(owner(CAROL.id, { evidence: [ev(OTHER, "Carol")] }), team, SUBJECT)).toBeNull(); // cites another message
    expect(acceptedOwner(owner(CAROL.id, { evidence: [] }), team, SUBJECT)).toBeNull();
  });
  it("rejects an owner whose quoted evidence does not actually name them", () => {
    expect(acceptedOwner(owner(CAROL.id, { evidence: [ev(SUBJECT, "please take a look at this")] }), team, SUBJECT)).toBeNull();
    expect(acceptedOwner(owner(CAROL.id, { evidence: [ev(SUBJECT, "Bob, could you take this")] }), team, SUBJECT)).toBeNull(); // names someone else
  });
});

describe("decideReply (rule 5: acknowledgment is not a substantive response)", () => {
  const STATES: ItemState[] = ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"];
  const DIRS: Direction[] = ["INBOUND", "OUTBOUND", "INTERNAL"];
  const answers = <T,>(make: (b: boolean) => T): Array<[string, T | null]> => [["none", null], ["yes", make(true)], ["no", make(false)]];

  for (const state of STATES) {
    for (const direction of DIRS) {
      for (const [subName, s] of answers(sub)) {
        for (const [ackName, a] of answers(ack)) {
          it(`${state} / ${direction} / substantive=${subName} / ack=${ackName}`, () => {
            const subject = { id: SUBJECT, direction };
            const got = decideReply(state, subject, s, a).kind;
            const ours = direction !== "INBOUND";
            const subYes = ours && s?.result.isSubstantive === true;
            const ackYes = ours && a?.result.isAcknowledgment === true;
            const want = subYes && ackYes ? "CONTRADICTION"
              : subYes && ["RECEIVED", "ACKNOWLEDGED", "REOPENED"].includes(state) ? "RESPONDED"
              : ackYes && ["RECEIVED", "REOPENED"].includes(state) ? "ACKNOWLEDGED" : "NONE";
            expect(got).toBe(want);
          });
        }
      }
    }
  }

  it("a pure acknowledgment is never RESPONDED, and a substantive reply is never merely ACKNOWLEDGED", () => {
    const subject = { id: SUBJECT, direction: "OUTBOUND" as const };
    expect(decideReply("RECEIVED", subject, sub(false), ack(true)).kind).toBe("ACKNOWLEDGED");
    expect(decideReply("RECEIVED", subject, sub(true), ack(false)).kind).toBe("RESPONDED");
  });

  it("ignores an analyzer whose recommendation contradicts its own result or that cites the wrong message", () => {
    const subject = { id: SUBJECT, direction: "OUTBOUND" as const };
    expect(decideReply("RECEIVED", subject, sub(true, { recommendedAction: "TRANSITION_CLOSED" }), null).kind).toBe("NONE");
    expect(decideReply("RECEIVED", subject, sub(true, { recommendedAction: "NONE" }), null).kind).toBe("NONE");
    expect(decideReply("RECEIVED", subject, sub(true, { evidence: [ev(OTHER)] }), null).kind).toBe("NONE");
    expect(decideReply("RECEIVED", subject, null, ack(true, { evidence: [] })).kind).toBe("NONE");
  });
});

describe("nextBudgetWindow", () => {
  it("is five minutes after the next UTC midnight", () => {
    expect(nextBudgetWindow(new Date("2026-10-05T17:30:00Z")).toISOString()).toBe("2026-10-06T00:05:00.000Z");
    expect(nextBudgetWindow(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-11-01T00:05:00.000Z");
  });
});

describe("decideProgress", () => {
  const prog = (isProgress: boolean, over: Partial<Ok<ProgressResult>> = {}) => ok<ProgressResult>({ isProgress }, isProgress ? "TRANSITION_IN_PROGRESS" : "NONE", over);
  const STATES: ItemState[] = ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"];

  it("moves to IN_PROGRESS only from RESPONDED, only for our own verified reply", () => {
    for (const state of STATES) {
      for (const direction of ["INBOUND", "OUTBOUND", "INTERNAL"] as Direction[]) {
        const got = decideProgress(state, { id: SUBJECT, direction }, prog(true)).kind;
        expect(got, `${state}/${direction}`).toBe(state === "RESPONDED" && direction !== "INBOUND" ? "IN_PROGRESS" : "NONE");
      }
    }
  });
  it("ignores a recommendation that disagrees with its own result, cites another message, or is absent", () => {
    const subject = { id: SUBJECT, direction: "OUTBOUND" as const };
    expect(decideProgress("RESPONDED", subject, prog(false)).kind).toBe("NONE");
    expect(decideProgress("RESPONDED", subject, prog(true, { recommendedAction: "TRANSITION_RESOLUTION_CONFIRMED" })).kind).toBe("NONE");
    expect(decideProgress("RESPONDED", subject, prog(true, { evidence: [ev(OTHER)] })).kind).toBe("NONE");
    expect(decideProgress("RESPONDED", subject, null).kind).toBe("NONE");
  });
});

describe("decideResolution (rules 2 and 5)", () => {
  type Signal = ResolutionResult["signal"];
  const ACTION: Record<Signal, RecommendedAction> = {
    resolved_by_us: "TRANSITION_RESOLUTION_PROPOSED", confirmed_by_customer: "TRANSITION_RESOLUTION_CONFIRMED", rejected_by_customer: "TRANSITION_IN_PROGRESS", none: "NONE",
  };
  const res = (signal: Signal, over: Partial<Ok<ResolutionResult>> = {}) => ok<ResolutionResult>({ signal }, ACTION[signal], over);
  const STATES: ItemState[] = ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"];
  const SIGNALS: Signal[] = ["resolved_by_us", "confirmed_by_customer", "rejected_by_customer", "none"];

  for (const state of STATES) {
    for (const direction of ["INBOUND", "OUTBOUND", "INTERNAL"] as Direction[]) {
      for (const signal of SIGNALS) {
        it(`${state} / ${direction} / ${signal}`, () => {
          const got = decideResolution(state, { id: SUBJECT, direction }, res(signal)).kind;
          const ours = direction !== "INBOUND";
          const want = signal === "resolved_by_us" && ours && (state === "RESPONDED" || state === "IN_PROGRESS") ? "PROPOSE_RESOLUTION"
            : signal === "confirmed_by_customer" && !ours && state === "RESOLUTION_PROPOSED" ? "SUGGEST_CONFIRMATION"
            : signal === "rejected_by_customer" && !ours && state === "RESOLUTION_PROPOSED" ? "BACK_TO_IN_PROGRESS" : "NONE";
          expect(got).toBe(want);
        });
      }
    }
  }

  it("a confirmation is only ever a SUGGESTION: no decision yields confirmed or closed directly", () => {
    const kinds = new Set<string>();
    for (const state of STATES) for (const direction of ["INBOUND", "OUTBOUND", "INTERNAL"] as Direction[]) for (const signal of SIGNALS) kinds.add(decideResolution(state, { id: SUBJECT, direction }, res(signal)).kind);
    expect([...kinds].sort()).toEqual(["BACK_TO_IN_PROGRESS", "NONE", "PROPOSE_RESOLUTION", "SUGGEST_CONFIRMATION"]);
  });

  it("ignores an output whose action does not match its signal, or whose evidence is not the message itself", () => {
    const inbound = { id: SUBJECT, direction: "INBOUND" as const };
    expect(decideResolution("RESOLUTION_PROPOSED", inbound, res("confirmed_by_customer", { recommendedAction: "TRANSITION_CLOSED" })).kind).toBe("NONE");
    expect(decideResolution("RESOLUTION_PROPOSED", inbound, res("confirmed_by_customer", { recommendedAction: "NONE" })).kind).toBe("NONE");
    expect(decideResolution("RESOLUTION_PROPOSED", inbound, res("confirmed_by_customer", { evidence: [ev(OTHER)] })).kind).toBe("NONE");
    expect(decideResolution("RESOLUTION_PROPOSED", inbound, res("confirmed_by_customer", { evidence: [] })).kind).toBe("NONE");
    expect(decideResolution("RESOLUTION_PROPOSED", inbound, null).kind).toBe("NONE");
  });
});
