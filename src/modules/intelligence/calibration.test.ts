import { describe, expect, it } from "vitest";
import { recommendThreshold, type Sample } from "./calibration";

const s = (confidence: number, correct: boolean): Sample => ({ confidence, correct });

describe("recommendThreshold", () => {
  it("returns the lowest threshold that meets the target precision, skipping bands that fall short", () => {
    const samples = [
      ...Array.from({ length: 6 }, () => s(0.95, true)),
      ...Array.from({ length: 6 }, () => s(0.85, true)),
      s(0.85, false),
      ...Array.from({ length: 6 }, () => s(0.6, false)),
    ];
    // At >= 0.85 the accepted answers are 12 right of 13 (92%): below the 95% target. At >= 0.95 they are 6 of 6.
    expect(recommendThreshold(samples, { targetPrecision: 0.95 }).threshold).toBe(0.95);
    // With a looser target the 0.85 band qualifies, and 0.6 never does (it is all wrong).
    expect(recommendThreshold(samples, { targetPrecision: 0.9 }).threshold).toBe(0.85);
  });

  it("is conservative: a mixed low band is excluded, a clean high band is accepted", () => {
    const samples = [...Array.from({ length: 8 }, () => s(0.95, true)), ...Array.from({ length: 4 }, () => s(0.7, true)), ...Array.from({ length: 4 }, () => s(0.7, false))];
    const r = recommendThreshold(samples, { targetPrecision: 0.95 });
    expect(r.threshold).toBe(0.95);
    expect(r.precision).toBe(1);
    expect(r.support).toBe(8);
    expect(r.coverage).toBe(0.5);
  });

  it("returns null when no threshold reaches the target with enough support", () => {
    expect(recommendThreshold([s(0.9, true), s(0.9, false), s(0.8, true), s(0.8, false), s(0.7, true), s(0.7, false)], { targetPrecision: 0.99 }).threshold).toBeNull();
    expect(recommendThreshold([s(0.99, true), s(0.99, true)], { minSupport: 5 }).threshold).toBeNull(); // too few samples to trust
    expect(recommendThreshold([]).threshold).toBeNull();
  });

  it("accepts everything when everything is correct", () => {
    const r = recommendThreshold(Array.from({ length: 10 }, (_, i) => s(0.5 + i / 20, true)));
    expect(r).toMatchObject({ threshold: 0.5, precision: 1, support: 10, coverage: 1 });
  });
});
