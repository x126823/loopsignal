import type { ItemState } from "../../../generated/prisma/enums";

/**
 * Metric derivation (rule 4): the four metrics and the item's state are pure functions of its events.
 * Timestamps are never edited directly. A reopen starts a new cycle: item-level metrics then describe the
 * current cycle, and earlier cycles remain in the event stream.
 */
export interface EventForMetrics {
  seq: number;
  cycle: number;
  toState: ItemState;
  createdAt: Date;
}

export interface DerivedItem {
  state: ItemState;
  cycle: number;
  reopenCount: number;
  version: number;
  ackAt: Date | null;
  firstSubstantiveResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

export function deriveMetrics(events: readonly EventForMetrics[]): DerivedItem {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const d: DerivedItem = {
    state: "RECEIVED", cycle: 1, reopenCount: 0, version: 0,
    ackAt: null, firstSubstantiveResponseAt: null, resolvedAt: null, closedAt: null,
  };
  for (const e of ordered) {
    d.state = e.toState;
    d.cycle = e.cycle;
    d.version = e.seq;
    switch (e.toState) {
      case "REOPENED":
        d.reopenCount += 1;
        d.ackAt = d.firstSubstantiveResponseAt = d.resolvedAt = d.closedAt = null; // new cycle
        break;
      case "ACKNOWLEDGED": d.ackAt ??= e.createdAt; break; // acknowledgment is not a substantive response
      case "RESPONDED": d.firstSubstantiveResponseAt ??= e.createdAt; break;
      case "RESOLUTION_CONFIRMED": d.resolvedAt = e.createdAt; break; // a proposal is not a resolution
      case "CLOSED": d.closedAt = e.createdAt; break; // confirmed is not closed
      default: break;
    }
  }
  return d;
}
