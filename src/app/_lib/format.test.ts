import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent } from "./format";

describe("formatDuration", () => {
  it("uses the largest sensible units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(4500)).toBe("1h 15m");
    expect(formatDuration(47 * 3600 + 59 * 60)).toBe("47h 59m");
    expect(formatDuration(48 * 3600)).toBe("2d");
    expect(formatDuration(200_000)).toBe("2d 7h");
  });
  it("shows a dash for no data or nonsense", () => {
    for (const v of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatDuration(v)).toBe("—");
  });
  it("formats percentages", () => {
    expect(formatPercent(75)).toBe("75%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("—");
  });
});
