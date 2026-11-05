import { describe, expect, it } from "vitest";
import type { ItemState } from "../../../generated/prisma/enums";
import { deriveMetrics } from "./metrics";
import { HUMAN_DECISION_STATES, ITEM_STATES, ruleFor, TRANSITIONS } from "./transitions";

const LEGAL = new Set([
  "RECEIVED>ACKNOWLEDGED", "RECEIVED>RESPONDED", "ACKNOWLEDGED>RESPONDED",
  "RECEIVED>IN_PROGRESS", "ACKNOWLEDGED>IN_PROGRESS", "RESPONDED>IN_PROGRESS",
  "RESPONDED>RESOLUTION_PROPOSED", "IN_PROGRESS>RESOLUTION_PROPOSED", "RESOLUTION_PROPOSED>IN_PROGRESS",
  "RESOLUTION_PROPOSED>RESOLUTION_CONFIRMED", "RESOLUTION_CONFIRMED>CLOSED",
  "CLOSED>REOPENED", "RESOLUTION_CONFIRMED>REOPENED",
  "REOPENED>ACKNOWLEDGED", "REOPENED>RESPONDED", "REOPENED>IN_PROGRESS",
]);

describe("transition table (exhaustive over all state pairs)", () => {
  for (const from of ITEM_STATES) {
    for (const to of ITEM_STATES) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(ruleFor(from, to) !== undefined).toBe(legal);
      });
    }
  }

  it("has exactly the documented legal transitions and no duplicates", () => {
    expect(TRANSITIONS.length).toBe(LEGAL.size);
    expect(new Set(TRANSITIONS.map((r) => `${r.from}>${r.to}`))).toEqual(LEGAL);
  });

  it("never lets automated actors apply confirmation, closure or reopening (rule 2)", () => {
    for (const r of TRANSITIONS.filter((t) => HUMAN_DECISION_STATES.has(t.to))) {
      expect(r.automated, `${r.from}>${r.to}`).toBe(false);
      expect(r.human, `${r.from}>${r.to}`).toBe(true);
      expect(r.suggestible, `${r.from}>${r.to}`).toBe(true);
    }
  });

  it("only humans can confirm or close, and each needs its own RBAC action", () => {
    expect(ruleFor("RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED")).toMatchObject({ automated: false, human: true, action: "item:confirm" });
    expect(ruleFor("RESOLUTION_CONFIRMED", "CLOSED")).toMatchObject({ automated: false, human: true, action: "item:close" });
  });

  it("lets only automated actors move a fresh item through acknowledgment, response and progress", () => {
    for (const k of ["RECEIVED>ACKNOWLEDGED", "RECEIVED>RESPONDED", "ACKNOWLEDGED>RESPONDED", "RECEIVED>IN_PROGRESS"]) {
      const [from, to] = k.split(">") as [ItemState, ItemState];
      expect(ruleFor(from, to)).toMatchObject({ automated: true, human: false });
    }
  });

  it("does not allow skipping straight to confirmation or closure", () => {
    for (const from of ITEM_STATES.filter((s) => s !== "RESOLUTION_PROPOSED")) expect(ruleFor(from, "RESOLUTION_CONFIRMED")).toBeUndefined();
    for (const from of ITEM_STATES.filter((s) => s !== "RESOLUTION_CONFIRMED")) expect(ruleFor(from, "CLOSED")).toBeUndefined();
  });
});

const ev = (seq: number, toState: ItemState, min: number, cycle = 1) => ({ seq, toState, cycle, createdAt: new Date(Date.UTC(2026, 9, 5, 9, min)) });
const t = (min: number) => new Date(Date.UTC(2026, 9, 5, 9, min));

describe("deriveMetrics", () => {
  it("starts RECEIVED with no metrics", () => {
    expect(deriveMetrics([ev(1, "RECEIVED", 0)])).toMatchObject({ state: "RECEIVED", ackAt: null, firstSubstantiveResponseAt: null, resolvedAt: null, closedAt: null, version: 1 });
  });

  it("keeps acknowledgment separate from the first substantive response", () => {
    const d = deriveMetrics([ev(1, "RECEIVED", 0), ev(2, "ACKNOWLEDGED", 5)]);
    expect(d.ackAt).toEqual(t(5));
    expect(d.firstSubstantiveResponseAt).toBeNull();
  });

  it("does not treat a proposal as a resolution or confirmation as closure", () => {
    const proposed = deriveMetrics([ev(1, "RECEIVED", 0), ev(2, "RESPONDED", 5), ev(3, "RESOLUTION_PROPOSED", 9)]);
    expect([proposed.resolvedAt, proposed.closedAt]).toEqual([null, null]);
    const confirmed = deriveMetrics([ev(1, "RECEIVED", 0), ev(2, "RESPONDED", 5), ev(3, "RESOLUTION_PROPOSED", 9), ev(4, "RESOLUTION_CONFIRMED", 20)]);
    expect([confirmed.resolvedAt, confirmed.closedAt]).toEqual([t(20), null]);
  });

  it("keeps the first response time when progress is reached before and after it", () => {
    // ACK, then IN_PROGRESS, RESPONDED is legal from RESPONDED only; here: ACK -> RESPONDED -> IN_PROGRESS -> proposal rejected -> IN_PROGRESS
    const d = deriveMetrics([
      ev(1, "RECEIVED", 0), ev(2, "ACKNOWLEDGED", 5), ev(3, "RESPONDED", 12), ev(4, "IN_PROGRESS", 20),
      ev(5, "RESOLUTION_PROPOSED", 30), ev(6, "IN_PROGRESS", 40),
    ]);
    expect([d.ackAt, d.firstSubstantiveResponseAt, d.state]).toEqual([t(5), t(12), "IN_PROGRESS"]);
  });

  it("starts a new cycle on reopen: item metrics reset, count increments, order comes from seq not time", () => {
    const events = [
      ev(1, "RECEIVED", 0), ev(2, "ACKNOWLEDGED", 5), ev(3, "RESPONDED", 10), ev(4, "RESOLUTION_PROPOSED", 15),
      ev(5, "RESOLUTION_CONFIRMED", 20), ev(6, "CLOSED", 25), ev(7, "REOPENED", 90, 2), ev(8, "ACKNOWLEDGED", 95, 2),
    ];
    const d = deriveMetrics([...events].reverse()); // input order must not matter
    expect(d).toMatchObject({ state: "ACKNOWLEDGED", cycle: 2, reopenCount: 1, version: 8, ackAt: t(95), firstSubstantiveResponseAt: null, resolvedAt: null, closedAt: null });
  });

  it("breaks timestamp ties with seq", () => {
    const same = t(5);
    const d = deriveMetrics([
      { seq: 2, cycle: 1, toState: "RESPONDED", createdAt: same },
      { seq: 3, cycle: 1, toState: "RESOLUTION_PROPOSED", createdAt: same },
      { seq: 1, cycle: 1, toState: "RECEIVED", createdAt: t(0) },
    ]);
    expect(d.state).toBe("RESOLUTION_PROPOSED");
  });
});
