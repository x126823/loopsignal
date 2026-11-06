// One chronological timeline for an item: what was said, what the system and people did, and when a deadline was missed. Pure.
// Message text is deliberately NOT part of it (the conversation card already shows it), so this list carries no content.
import type { ItemState } from "../../../generated/prisma/enums";

export type TimelineEntry =
  | { kind: "message"; key: string; at: Date; direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; sender: string | null; otherChannel: boolean }
  | { kind: "event"; key: string; at: Date; seq: number; fromState: ItemState | null; toState: ItemState; cycle: number; actor: string; reason: string | null; quote: string | null }
  | { kind: "deadline"; key: string; at: Date; timerType: "ACK" | "RESPONSE" | "RESOLVE" | "CLOSE"; cycle: number };

export interface TimelineInput {
  messages: ReadonlyArray<{ id: string; direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; sentAt: Date; sender: string | null; otherChannel: boolean }>;
  events: ReadonlyArray<{ seq: number; fromState: ItemState | null; toState: ItemState; cycle: number; createdAt: Date; actor: string; reason: string | null; quote: string | null }>;
  /** Timers that are overdue (or were finished late): each marks the moment its deadline passed. */
  missed: ReadonlyArray<{ id: string; type: "ACK" | "RESPONSE" | "RESOLVE" | "CLOSE"; cycle: number; dueAt: Date }>;
}

const RANK = { message: 0, deadline: 1, event: 2 } as const;

/** Oldest first. At the same instant: what people said, then the missed deadline, then what was done about it; ties keep a stable order. */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...input.messages.map((m): TimelineEntry => ({ kind: "message", key: `m-${m.id}`, at: m.sentAt, direction: m.direction, sender: m.sender, otherChannel: m.otherChannel })),
    ...input.events.map((e): TimelineEntry => ({ kind: "event", key: `e-${e.seq}`, at: e.createdAt, seq: e.seq, fromState: e.fromState, toState: e.toState, cycle: e.cycle, actor: e.actor, reason: e.reason, quote: e.quote })),
    ...input.missed.map((t): TimelineEntry => ({ kind: "deadline", key: `d-${t.id}`, at: t.dueAt, timerType: t.type, cycle: t.cycle })),
  ];
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime() || RANK[a.kind] - RANK[b.kind] || (a.kind === "event" && b.kind === "event" ? a.seq - b.seq : 0) || a.key.localeCompare(b.key));
}
