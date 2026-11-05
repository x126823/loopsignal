import { describe, expect, it } from "vitest";
import { describeActor, formatDateTime, STATE_LABEL, STATE_TONE, TRANSITION_LABEL } from "./labels";

describe("labels", () => {
  it("labels every lifecycle state, with a tone", () => {
    const states = ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"] as const;
    for (const s of states) {
      expect(STATE_LABEL[s].length).toBeGreaterThan(2);
      expect(STATE_TONE[s]).toBeTruthy();
    }
    expect(new Set(states.map((s) => STATE_LABEL[s])).size).toBe(states.length); // never two states with the same wording
  });

  it("keeps proposal, confirmation and closure distinct (rule 5)", () => {
    expect(TRANSITION_LABEL.RESOLUTION_PROPOSED).not.toBe(TRANSITION_LABEL.RESOLUTION_CONFIRMED);
    expect(TRANSITION_LABEL.RESOLUTION_CONFIRMED).not.toBe(TRANSITION_LABEL.CLOSED);
  });

  it("formats dates in UTC, independent of the machine, and shows a dash for none", () => {
    expect(formatDateTime(new Date("2026-10-05T09:12:44Z"))).toBe("2026-10-05 09:12 UTC");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("describes who acted without exposing ids", () => {
    expect(describeActor({ actorType: "USER", actorLabel: "Carol Member" })).toBe("Carol Member");
    expect(describeActor({ actorType: "USER", actorLabel: null })).toBe("A person");
    expect(describeActor({ actorType: "SYSTEM", actorLabel: null })).toBe("System");
    expect(describeActor({ actorType: "ANALYZER", actorLabel: "resolution_analyzer" })).toBe("AI recommendation (resolution analyzer)");
  });
});
