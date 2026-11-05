import { describe, expect, it } from "vitest";
import { ManualClock, systemClock } from "./clock";

describe("clocks", () => {
  it("the system clock tracks real time", () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("a manual clock only moves when told to", () => {
    const c = new ManualClock("2026-10-05T09:00:00Z");
    expect(c.now().toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(c.now().toISOString()).toBe("2026-10-05T09:00:00.000Z"); // reading does not advance it
    c.advance({ hours: 2, minutes: 30 });
    expect(c.now().toISOString()).toBe("2026-10-05T11:30:00.000Z");
    c.advance({ days: 1, seconds: 15 });
    expect(c.now().toISOString()).toBe("2026-10-06T11:30:15.000Z");
    c.set("2026-01-01T00:00:00Z");
    expect(c.now().getUTCFullYear()).toBe(2026);
  });

  it("hands out independent Date objects, so callers cannot move it by mutating what they read", () => {
    const c = new ManualClock(0);
    c.now().setFullYear(2099);
    expect(c.now().getTime()).toBe(0);
  });
});
