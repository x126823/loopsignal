import { describe, expect, it } from "vitest";
import { addBusinessSeconds, businessSecondsBetween, calendarSchema, isOpenAt, type BusinessCalendar } from "./calendar";

const H = 3600;
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const weekdays = (tz: string, ranges: Array<[string, string]> = [["09:00", "17:00"]], holidays: string[] = []): BusinessCalendar =>
  calendarSchema.parse({ timezone: tz, hours: { mon: ranges, tue: ranges, wed: ranges, thu: ranges, fri: ranges }, holidays });
const UTC = weekdays("UTC");
// 2026-10-05 is a Monday.

describe("calendar validation", () => {
  const ok = { timezone: "America/Toronto", hours: { mon: [["09:00", "17:00"]] }, holidays: ["2026-12-25"] };
  it("accepts a normal calendar, including 24:00 and split shifts", () => {
    expect(calendarSchema.safeParse(ok).success).toBe(true);
    expect(calendarSchema.safeParse({ timezone: "UTC", hours: { sat: [["00:00", "24:00"]] } }).success).toBe(true);
    expect(calendarSchema.safeParse({ timezone: "UTC", hours: { mon: [["09:00", "12:00"], ["13:00", "17:00"]] } }).success).toBe(true);
  });
  it("rejects unknown zones, bad times, backwards or overlapping ranges, and empty calendars", () => {
    const bad = (over: object) => calendarSchema.safeParse({ ...ok, ...over }).success;
    expect(bad({ timezone: "Mars/Olympus_Mons" })).toBe(false);
    expect(bad({ timezone: "" })).toBe(false);
    expect(bad({ hours: { mon: [["9:00", "17:00"]] } })).toBe(false);
    expect(bad({ hours: { mon: [["09:00", "25:00"]] } })).toBe(false);
    expect(bad({ hours: { mon: [["17:00", "09:00"]] } })).toBe(false);
    expect(bad({ hours: { mon: [["09:00", "09:00"]] } })).toBe(false);
    expect(bad({ hours: { mon: [["09:00", "13:00"], ["12:00", "17:00"]] } })).toBe(false);
    expect(bad({ hours: {} })).toBe(false);
    expect(bad({ hours: { mon: [] } })).toBe(false);
    expect(bad({ hours: { funday: [["09:00", "17:00"]] } })).toBe(false);
    expect(bad({ holidays: ["2026-02-30"] })).toBe(false);
    expect(bad({ holidays: ["12/25/2026"] })).toBe(false);
    expect(bad({ extra: true })).toBe(false);
  });
});

describe("addBusinessSeconds", () => {
  it("with no calendar, time is continuous", () => {
    expect(iso(addBusinessSeconds(at("2026-10-10T22:00:00Z"), 5 * H, null))).toBe("2026-10-11T03:00:00.000Z");
  });
  it("counts inside open hours", () => {
    expect(iso(addBusinessSeconds(at("2026-10-05T10:00:00Z"), H, UTC))).toBe("2026-10-05T11:00:00.000Z");
  });
  it("carries over the evening to the next morning, and over a weekend", () => {
    expect(iso(addBusinessSeconds(at("2026-10-05T16:30:00Z"), H, UTC))).toBe("2026-10-06T09:30:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-09T16:30:00Z"), H, UTC))).toBe("2026-10-12T09:30:00.000Z"); // Friday evening to Monday
  });
  it("starts counting at the next opening when it starts outside hours", () => {
    expect(iso(addBusinessSeconds(at("2026-10-10T12:00:00Z"), 1800, UTC))).toBe("2026-10-12T09:30:00.000Z"); // a Saturday
    expect(iso(addBusinessSeconds(at("2026-10-05T08:00:00Z"), 60, UTC))).toBe("2026-10-05T09:01:00.000Z"); // before opening
    expect(iso(addBusinessSeconds(at("2026-10-05T20:00:00Z"), 60, UTC))).toBe("2026-10-06T09:01:00.000Z"); // after closing
  });
  it("returns the start itself for zero seconds, and rejects negative or non-finite amounts", () => {
    expect(iso(addBusinessSeconds(at("2026-10-05T08:00:00Z"), 0, UTC))).toBe("2026-10-05T08:00:00.000Z");
    expect(() => addBusinessSeconds(at("2026-10-05T08:00:00Z"), -1, UTC)).toThrow(RangeError);
    expect(() => addBusinessSeconds(at("2026-10-05T08:00:00Z"), Number.NaN, UTC)).toThrow(RangeError);
    expect(() => addBusinessSeconds(at("2026-10-05T08:00:00Z"), Infinity, UTC)).toThrow(RangeError);
  });
  it("is exact at the opening and closing boundaries", () => {
    expect(iso(addBusinessSeconds(at("2026-10-05T09:00:00Z"), 8 * H, UTC))).toBe("2026-10-05T17:00:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T09:00:00Z"), 8 * H + 1, UTC))).toBe("2026-10-06T09:00:01.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T17:00:00Z"), 1, UTC))).toBe("2026-10-06T09:00:01.000Z"); // starting exactly at close
  });
  it("works over several days: a 40-hour week ends Friday at 17:00", () => {
    expect(iso(addBusinessSeconds(at("2026-10-05T09:00:00Z"), 40 * H, UTC))).toBe("2026-10-09T17:00:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T09:00:00Z"), 40 * H + 60, UTC))).toBe("2026-10-12T09:01:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T09:00:00Z"), 400 * H, UTC))).toBe("2026-12-11T17:00:00.000Z"); // ten five-day weeks end on the tenth Friday
  });
  it("skips holidays", () => {
    const withHoliday = weekdays("UTC", [["09:00", "17:00"]], ["2026-10-06"]);
    expect(iso(addBusinessSeconds(at("2026-10-05T16:30:00Z"), H, withHoliday))).toBe("2026-10-07T09:30:00.000Z");
    const longWeekend = weekdays("UTC", [["09:00", "17:00"]], ["2026-10-12", "2026-10-13"]);
    expect(iso(addBusinessSeconds(at("2026-10-09T16:30:00Z"), H, longWeekend))).toBe("2026-10-14T09:30:00.000Z");
  });
  it("handles split shifts, paused over the break", () => {
    const split = weekdays("UTC", [["09:00", "12:00"], ["13:00", "17:00"]]);
    expect(iso(addBusinessSeconds(at("2026-10-05T11:30:00Z"), H, split))).toBe("2026-10-05T13:30:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T12:30:00Z"), H, split))).toBe("2026-10-05T14:00:00.000Z"); // starts in the break
  });
  it("handles an all-day calendar ending at 24:00", () => {
    const always = calendarSchema.parse({ timezone: "UTC", hours: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["00:00", "24:00"]]])) });
    expect(iso(addBusinessSeconds(at("2026-10-10T22:00:00Z"), 5 * H, always))).toBe("2026-10-11T03:00:00.000Z");
    expect(iso(addBusinessSeconds(at("2026-10-05T00:00:00Z"), 24 * H, always))).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("businessSecondsBetween", () => {
  it("counts only open time, across evenings and weekends", () => {
    expect(businessSecondsBetween(at("2026-10-05T10:00:00Z"), at("2026-10-05T11:00:00Z"), UTC)).toBe(H);
    expect(businessSecondsBetween(at("2026-10-09T16:00:00Z"), at("2026-10-12T10:00:00Z"), UTC)).toBe(2 * H);
    expect(businessSecondsBetween(at("2026-10-10T00:00:00Z"), at("2026-10-12T00:00:00Z"), UTC)).toBe(0); // a weekend
  });
  it("is 0 when the end is not after the start, and continuous with no calendar", () => {
    expect(businessSecondsBetween(at("2026-10-05T11:00:00Z"), at("2026-10-05T10:00:00Z"), UTC)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-05T10:00:00Z"), at("2026-10-05T10:00:00Z"), UTC)).toBe(0);
    expect(businessSecondsBetween(at("2026-10-10T00:00:00Z"), at("2026-10-11T00:00:00Z"), null)).toBe(24 * H);
  });
  it("skips holidays and split-shift breaks", () => {
    expect(businessSecondsBetween(at("2026-10-05T00:00:00Z"), at("2026-10-08T00:00:00Z"), weekdays("UTC", [["09:00", "17:00"]], ["2026-10-06"]))).toBe(16 * H);
    expect(businessSecondsBetween(at("2026-10-05T00:00:00Z"), at("2026-10-06T00:00:00Z"), weekdays("UTC", [["09:00", "12:00"], ["13:00", "17:00"]]))).toBe(7 * H);
  });
});

describe("isOpenAt", () => {
  it("is true inside hours (start inclusive, end exclusive), false outside, on weekends and on holidays", () => {
    expect(isOpenAt(at("2026-10-05T09:00:00Z"), UTC)).toBe(true);
    expect(isOpenAt(at("2026-10-05T16:59:59Z"), UTC)).toBe(true);
    expect(isOpenAt(at("2026-10-05T17:00:00Z"), UTC)).toBe(false);
    expect(isOpenAt(at("2026-10-05T08:59:59Z"), UTC)).toBe(false);
    expect(isOpenAt(at("2026-10-10T12:00:00Z"), UTC)).toBe(false);
    expect(isOpenAt(at("2026-10-06T12:00:00Z"), weekdays("UTC", [["09:00", "17:00"]], ["2026-10-06"]))).toBe(false);
    expect(isOpenAt(at("2026-10-10T12:00:00Z"), null)).toBe(true);
  });
});

describe("time zones and daylight saving", () => {
  const allDay = (tz: string, days: string[]) => calendarSchema.parse({ timezone: tz, hours: Object.fromEntries(days.map((d) => [d, [["00:00", "24:00"]]])) });

  it("reads the working day in the calendar's own zone, not UTC", () => {
    const toronto = weekdays("America/Toronto");
    expect(isOpenAt(at("2026-10-05T13:00:00Z"), toronto)).toBe(true); // 09:00 EDT
    expect(isOpenAt(at("2026-10-05T12:59:00Z"), toronto)).toBe(false);
    expect(isOpenAt(at("2026-10-05T21:00:00Z"), toronto)).toBe(false); // 17:00 EDT
    expect(iso(addBusinessSeconds(at("2026-10-05T12:00:00Z"), H, toronto))).toBe("2026-10-05T14:00:00.000Z"); // opens 13:00Z
  });

  it("a weekday's hours are unaffected by the clocks changing overnight", () => {
    const toronto = weekdays("America/Toronto");
    // Friday 16:00 EST (21:00Z) plus two hours is Monday 10:00 EDT (14:00Z): 1h left Friday, 1h on Monday.
    expect(iso(addBusinessSeconds(at("2026-03-06T21:00:00Z"), 2 * H, toronto))).toBe("2026-03-09T14:00:00.000Z");
    expect(businessSecondsBetween(at("2026-03-06T21:00:00Z"), at("2026-03-09T14:00:00Z"), toronto)).toBe(2 * H);
    // The same in autumn: Friday 16:00 EDT (20:00Z) to Monday 10:00 EST (15:00Z).
    expect(iso(addBusinessSeconds(at("2026-10-30T20:00:00Z"), 2 * H, toronto))).toBe("2026-11-02T15:00:00.000Z");
  });

  it("a day that loses an hour (clocks go forward) is 23 hours long, and one that gains an hour (back) is 25", () => {
    const sun = allDay("America/Toronto", ["sun", "mon"]);
    expect(businessSecondsBetween(at("2026-03-08T05:00:00Z"), at("2026-03-09T04:00:00Z"), sun)).toBe(23 * H); // Mar 8 00:00 EST to Mar 9 00:00 EDT
    expect(businessSecondsBetween(at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z"), sun)).toBe(25 * H); // Nov 1 00:00 EDT to Nov 2 00:00 EST
    expect(iso(addBusinessSeconds(at("2026-03-08T05:00:00Z"), 23 * H, sun))).toBe("2026-03-09T04:00:00.000Z");
  });

  it("works in the southern hemisphere, where the changes fall in the opposite season", () => {
    const sun = allDay("Australia/Sydney", ["sun"]);
    expect(businessSecondsBetween(at("2026-04-04T13:00:00Z"), at("2026-04-05T14:00:00Z"), sun)).toBe(25 * H); // DST ends 5 Apr: 25-hour day
    expect(businessSecondsBetween(at("2026-10-03T14:00:00Z"), at("2026-10-04T13:00:00Z"), sun)).toBe(23 * H); // DST starts 4 Oct: 23-hour day
  });

  it("handles zones with half-hour offsets, with and without daylight saving", () => {
    const kolkata = weekdays("Asia/Kolkata"); // UTC+5:30
    expect(iso(addBusinessSeconds(at("2026-10-05T03:30:00Z"), H, kolkata))).toBe("2026-10-05T04:30:00.000Z"); // 09:00 IST opening
    expect(isOpenAt(at("2026-10-05T03:29:00Z"), kolkata)).toBe(false);
    const lordHowe = allDay("Australia/Lord_Howe", ["sun"]); // UTC+11 to +10:30: a 30-minute daylight-saving shift
    expect(businessSecondsBetween(at("2026-04-04T13:00:00Z"), at("2026-04-05T13:30:00Z"), lordHowe)).toBe(24 * H + 1800); // a 24.5-hour day
  });

  it("works in a zone with no daylight saving", () => {
    const manila = weekdays("Asia/Manila"); // UTC+8, the support team's night shift is 21:00-06:00 local
    expect(iso(addBusinessSeconds(at("2026-10-05T01:00:00Z"), H, manila))).toBe("2026-10-05T02:00:00.000Z"); // opens 09:00 PHT = 01:00Z
  });

  it("an opening time that does not exist (skipped hour) is read as the same wall time after the change, never lost", () => {
    const night = calendarSchema.parse({ timezone: "America/Toronto", hours: { sun: [["02:30", "05:30"]] } }); // 02:30 does not exist on 8 Mar 2026
    // 02:30 is read as 03:30 EDT (07:30Z); the shift ends 05:30 EDT (09:30Z): two real hours.
    expect(businessSecondsBetween(at("2026-03-08T05:00:00Z"), at("2026-03-09T04:00:00Z"), night)).toBe(2 * H);
    const inGap = calendarSchema.parse({ timezone: "America/Toronto", hours: { sun: [["02:30", "03:30"]] } });
    expect(businessSecondsBetween(at("2026-03-08T05:00:00Z"), at("2026-03-09T04:00:00Z"), inGap)).toBe(0); // entirely in the skipped hour
  });

  it("an opening time that happens twice (clocks go back) is read as its first occurrence", () => {
    const night = calendarSchema.parse({ timezone: "America/Toronto", hours: { sun: [["01:30", "02:30"]] } }); // 01:30 occurs at 05:30Z and 06:30Z on 1 Nov 2026
    expect(businessSecondsBetween(at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z"), night)).toBe(2 * H); // 01:30 EDT (05:30Z) to 02:30 EST (07:30Z)
  });
});

describe("addBusinessSeconds and businessSecondsBetween are inverses (fuzz)", () => {
  // Small deterministic generator so failures are reproducible.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const calendars: Array<[string, BusinessCalendar | null]> = [
    ["utc 9-5", UTC],
    ["toronto 9-5 + holidays", weekdays("America/Toronto", [["09:00", "17:00"]], ["2026-03-09", "2026-11-02"])],
    ["london split", weekdays("Europe/London", [["08:30", "12:30"], ["13:30", "17:30"]])],
    ["sydney 24x5", calendarSchema.parse({ timezone: "Australia/Sydney", hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["00:00", "24:00"]]])) })],
    ["kolkata 9-6", weekdays("Asia/Kolkata", [["09:00", "18:00"]])],
    ["24x7", null],
  ];
  for (const [name, cal] of calendars) {
    it(`round-trips for ${name}`, () => {
      const next = rng(name.length * 7919);
      const base = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 150; i++) {
        const start = new Date(base + Math.floor(next() * 365 * 86_400_000));
        const seconds = Math.floor(next() * 300 * H);
        const end = addBusinessSeconds(start, seconds, cal);
        expect(end.getTime(), `${name} #${i}`).toBeGreaterThanOrEqual(start.getTime());
        expect(businessSecondsBetween(start, end, cal), `${name} #${i} ${start.toISOString()} +${seconds}s`).toBe(seconds);
        // And it never lands in a closed period unless it is exactly at a closing instant.
        if (cal) expect(isOpenAt(end, cal) || isOpenAt(new Date(end.getTime() - 1000), cal) || seconds === 0, `${name} #${i} ends in closed time`).toBe(true);
      }
    });
    it(`is monotonic for ${name}`, () => {
      const start = new Date(Date.UTC(2026, 2, 5, 12));
      let prev = start.getTime();
      for (let s = 0; s <= 60 * H; s += 1800) {
        const t = addBusinessSeconds(start, s, cal).getTime();
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    });
  }
});
