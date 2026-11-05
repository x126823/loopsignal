import { createHash } from "node:crypto";

/** Deterministic uuid from a key, so golden cases are stable and diffable. */
export function gid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface GoldenMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  sentAt: Date;
  text: string;
}

export interface GoldenCandidate {
  id: string;
  name: string;
  handle: string;
}

export interface GoldenCase<E> {
  id: string;
  /** Why this case is interesting (for people reading a failure). */
  note?: string;
  messages: GoldenMessage[];
  candidates?: GoldenCandidate[];
  /** System-measured facts passed alongside the messages (SLA risk only). */
  facts?: Record<string, string | number | boolean>;
  expected: E;
}

const T0 = Date.UTC(2026, 9, 5, 9, 0);

/** Build a case from a compact list of ["in" | "out" | "int", text]. The LAST message is the one being analyzed. */
export function goldenCase<E>(id: string, expected: E, turns: Array<["in" | "out" | "int", string]>, opts: { note?: string; candidates?: GoldenCandidate[]; facts?: Record<string, string | number | boolean> } = {}): GoldenCase<E> {
  const dir = { in: "INBOUND", out: "OUTBOUND", int: "INTERNAL" } as const;
  return {
    id,
    expected,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.candidates ? { candidates: opts.candidates } : {}),
    ...(opts.facts ? { facts: opts.facts } : {}),
    messages: turns.map(([d, text], i) => ({ id: gid(`${id}:${i}`), direction: dir[d], sentAt: new Date(T0 + i * 600_000), text })),
  };
}
