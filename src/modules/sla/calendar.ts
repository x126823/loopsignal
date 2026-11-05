import { z } from "zod";

/**
 * Business calendars: open hours per weekday in a named time zone, plus whole-day holidays. All math here is exact and
 * pure (no ambient clock), uses only the built-in Intl for time zones, and handles daylight-saving changes:
 *  - A local time that does not exist (the hour skipped when clocks go forward) is read as the same wall time after the
 *    change, so a 09:00 opening is never lost.
 *  - A local time that happens twice (when clocks go back) is read as its first occurrence.
 * Business time only advances inside open hours; outside them it is paused.
 */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM, 00:00 to 24:00");
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export const calendarSchema = z
  .object({
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown IANA time zone"),
    hours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(z.tuple([hhmm, hhmm])).max(6).optional()])) as Record<Weekday, z.ZodOptional<z.ZodArray<z.ZodTuple<[typeof hhmm, typeof hhmm]>>>>).strict(),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(1000).default([]),
  })
  .strict()
  .superRefine((cal, ctx) => {
    let any = false;
    for (const day of WEEKDAYS) {
      const ranges = cal.hours[day] ?? [];
      let last = -1;
      for (const [start, end] of ranges) {
        any = true;
        if (minutes(start) >= minutes(end)) ctx.addIssue({ code: "custom", message: `${day}: ${start}-${end} does not end after it starts`, path: ["hours", day] });
        if (minutes(start) < last) ctx.addIssue({ code: "custom", message: `${day}: ranges must be in order and not overlap`, path: ["hours", day] });
        last = minutes(end);
      }
    }
    if (!any) ctx.addIssue({ code: "custom", message: "a calendar needs at least one open range", path: ["hours"] });
    for (const h of cal.holidays) {
      const [y, m, d] = h.split("-").map(Number) as [number, number, number];
      const real = new Date(Date.UTC(y, m - 1, d));
      if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) ctx.addIssue({ code: "custom", message: `${h} is not a real date`, path: ["holidays"] });
    }
  });
export type BusinessCalendar = z.infer<typeof calendarSchema>;

// --- time zone arithmetic --------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

interface Local {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function localParts(utcMs: number, tz: string): Local {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p["year"]!, m: p["month"]!, d: p["day"]!, h: p["hour"]!, mi: p["minute"]!, s: p["second"]! };
}

/** Offset of `tz` from UTC at an instant, in milliseconds (positive east of UTC). Whole seconds, so 30-minute zones work. */
function offsetAt(utcMs: number, tz: string): number {
  const l = localParts(utcMs, tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - Math.floor(utcMs / 1000) * 1000;
}

/** The instant at which a wall-clock time occurs in `tz`, following the DST conventions above. */
function zonedToUtc(y: number, m: number, d: number, minuteOfDay: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d) + minuteOfDay * 60_000; // the wall time, read as if it were UTC
  const candidates = [...new Set([offsetAt(wall - 86_400_000, tz), offsetAt(wall + 86_400_000, tz)])]
    .map((off) => wall - off)
    .filter((t) => offsetAt(t, tz) === wall - t);
  if (candidates.length > 0) return Math.min(...candidates); // ambiguous (clocks went back): the first occurrence
  return wall - offsetAt(wall - 86_400_000, tz); // skipped (clocks went forward): the same wall time after the change
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Open intervals, as UTC milliseconds, that intersect [fromMs, toMs), in order. Lazy: callers stop when they have enough. */
function* openIntervals(cal: BusinessCalendar, fromMs: number, toMs = Infinity): Generator<[number, number]> {
  const holidays = new Set(cal.holidays);
  const start = localParts(fromMs, cal.timezone);
  let day = Date.UTC(start.y, start.m - 1, start.d);
  const end = toMs === Infinity ? null : localParts(toMs, cal.timezone);
  const lastDay = end ? Date.UTC(end.y, end.m - 1, end.d) : Infinity;
  for (let i = 0; i < 4_000 && day <= lastDay; i++, day += 86_400_000) {
    const date = new Date(day);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (holidays.has(isoDate(y, m, d))) continue;
    for (const [open, close] of cal.hours[WEEKDAYS[date.getUTCDay()]!] ?? []) {
      const a = zonedToUtc(y, m, d, minutes(open), cal.timezone);
      const b = zonedToUtc(y, m, d, minutes(close), cal.timezone); // "24:00" is midnight at the end of the day
      const lo = Math.max(a, fromMs);
      const hi = Math.min(b, toMs);
      if (hi > lo) yield [lo, hi];
    }
  }
}

/**
 * The instant at which `seconds` of business time have elapsed since `start`. With no calendar, time is continuous (24x7).
 * Starting outside open hours, counting begins at the next opening.
 */
export function addBusinessSeconds(start: Date, seconds: number, cal: BusinessCalendar | null): Date {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("seconds must be a non-negative number");
  if (cal === null) return new Date(start.getTime() + seconds * 1000);
  if (seconds === 0) return new Date(start.getTime());
  let remaining = seconds * 1000;
  for (const [lo, hi] of openIntervals(cal, start.getTime())) {
    if (hi - lo >= remaining) return new Date(lo + remaining);
    remaining -= hi - lo;
  }
  throw new RangeError("calendar has no open hours within range");
}

/** Whole seconds of business time between two instants (0 if `to` is not after `from`). */
export function businessSecondsBetween(from: Date, to: Date, cal: BusinessCalendar | null): number {
  if (to.getTime() <= from.getTime()) return 0;
  if (cal === null) return Math.floor((to.getTime() - from.getTime()) / 1000);
  let total = 0;
  for (const [lo, hi] of openIntervals(cal, from.getTime(), to.getTime())) total += hi - lo;
  return Math.floor(total / 1000);
}

/** Whether the business is open at an instant. */
export function isOpenAt(at: Date, cal: BusinessCalendar | null): boolean {
  if (cal === null) return true;
  for (const [lo, hi] of openIntervals(cal, at.getTime(), at.getTime() + 1)) if (lo <= at.getTime() && at.getTime() < hi) return true;
  return false;
}
