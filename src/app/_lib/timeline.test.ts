import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline";

const t = (min: number) => new Date(Date.UTC(2026, 9, 5, 9, min));
const ev = (seq: number, min: number, to: "RECEIVED" | "ACKNOWLEDGED" | "RESPONDED") => ({ seq, fromState: null, toState: to, cycle: 1, createdAt: t(min), actor: "System", reason: null, quote: null });

describe("buildTimeline", () => {
  it("merges messages, events and missed deadlines, oldest first", () => {
    const out = buildTimeline({
      messages: [{ id: "a", direction: "INBOUND", sentAt: t(0), sender: "Pat", otherChannel: false }, { id: "b", direction: "OUTBOUND", sentAt: t(90), sender: "Carol", otherChannel: false }, { id: "c", direction: "INBOUND", sentAt: t(30), sender: "Pat", otherChannel: true }],
      events: [ev(1, 0, "RECEIVED"), ev(2, 90, "ACKNOWLEDGED")],
      missed: [{ id: "x", type: "ACK", cycle: 1, dueAt: t(60) }],
    });
    expect(out.map((e) => e.key)).toEqual(["m-a", "e-1", "m-c", "d-x", "m-b", "e-2"]);
    expect(out.find((e) => e.key === "m-c")).toMatchObject({ otherChannel: true });
  });

  it("orders simultaneous things as said, then missed, then done; and events by sequence", () => {
    const out = buildTimeline({
      messages: [{ id: "m", direction: "OUTBOUND", sentAt: t(5), sender: null, otherChannel: false }],
      events: [ev(3, 5, "RESPONDED"), ev(2, 5, "ACKNOWLEDGED")],
      missed: [{ id: "d", type: "RESPONSE", cycle: 1, dueAt: t(5) }],
    });
    expect(out.map((e) => e.key)).toEqual(["m-m", "d-d", "e-2", "e-3"]);
  });

  it("is empty for nothing, and never carries message text", () => {
    expect(buildTimeline({ messages: [], events: [], missed: [] })).toEqual([]);
    const only = buildTimeline({ messages: [{ id: "z", direction: "INBOUND", sentAt: t(1), sender: "Pat", otherChannel: false }], events: [], missed: [] });
    expect(JSON.stringify(only)).not.toMatch(/text|body/i);
  });
});
