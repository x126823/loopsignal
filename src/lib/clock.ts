/**
 * Time is injected, never read ambiently, wherever behavior depends on "now" (SLA timers, scans, warnings, breaches).
 * Production uses the system clock; tests use a ManualClock they advance by hand, which makes warn, breach and reopen
 * behavior deterministic.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. For tests and fixtures. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(start: Date | string | number) {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(to: Date | string | number): this {
    this.ms = new Date(to).getTime();
    return this;
  }

  advance(by: { seconds?: number; minutes?: number; hours?: number; days?: number }): this {
    this.ms += ((by.days ?? 0) * 86_400 + (by.hours ?? 0) * 3_600 + (by.minutes ?? 0) * 60 + (by.seconds ?? 0)) * 1000;
    return this;
  }
}
