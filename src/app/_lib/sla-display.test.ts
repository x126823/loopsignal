import { describe, expect, it } from "vitest";
import type { TimerView } from "@/modules/sla";
import { currentTimers, riskHint } from "./sla-display";

const d = new Date("2026-10-05T09:00:00Z");
const t = (type: TimerView["type"], state: TimerView["state"], cycle = 1): TimerView => ({ id: `${cycle}-${type}`, cycle, type, startedAt: d, dueAt: d, warnAt: d, state, resolvedAt: null });

describe("currentTimers", () => {
  it("keeps only the latest cycle, in ack, response, resolve, close order", () => {
    const all = [t("CLOSE", "RUNNING", 2), t("ACK", "MET", 1), t("RESOLVE", "RUNNING", 2), t("ACK", "RUNNING", 2), t("RESPONSE", "WARNED", 2)];
    expect(currentTimers(all).map((x) => `${x.cycle}:${x.type}`)).toEqual(["2:ACK", "2:RESPONSE", "2:RESOLVE", "2:CLOSE"]);
  });
  it("is empty when there are no timers", () => expect(currentTimers([])).toEqual([]));
});

describe("riskHint", () => {
  const analyses = [{ analyzer: "intent_classifier", result: { actionable: true } }, { analyzer: "sla_risk_analyzer", result: { risk: "HIGH" } }, { analyzer: "sla_risk_analyzer", result: { risk: "LOW" } }];
  it("shows the newest estimate while a timer is due soon", () => expect(riskHint([t("ACK", "WARNED")], analyses)).toBe("HIGH"));
  it("shows nothing once no timer is due soon, so a stale estimate never misleads", () => {
    expect(riskHint([t("ACK", "MET"), t("RESPONSE", "BREACHED")], analyses)).toBeNull();
    expect(riskHint([t("ACK", "RUNNING")], analyses)).toBeNull();
  });
  it("shows nothing when there is no estimate or it is malformed", () => {
    expect(riskHint([t("ACK", "WARNED")], [])).toBeNull();
    expect(riskHint([t("ACK", "WARNED")], [{ analyzer: "sla_risk_analyzer", result: { risk: "SEVERE" } }])).toBeNull();
    expect(riskHint([t("ACK", "WARNED")], [{ analyzer: "sla_risk_analyzer", result: null }])).toBeNull();
  });
});
