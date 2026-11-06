// Deterministic scoring of "is this new message about an item we already track in another channel?". Pure: no database, no
// clock, no model. The score only decides whether a candidate is SHOWN to a person; nothing is ever linked because of it
// (rule 9: uncertain matches go to human review, and here every match does).
//
// The recorded rationale holds counts and numbers, never message text or the identifiers found in it, so what is stored in
// the clear says nothing about the encrypted content (rule 10).

export interface MessageFeatures {
  threadId: string;
  monitoredSourceId: string;
  sentAt: Date;
  subject: string | null;
  text: string;
  senderAddress: string | null;
  senderName: string | null;
}

export type SignalName = "time" | "sender" | "reference" | "text";

export interface Signal {
  name: SignalName;
  /** 0..1: how strongly this signal points to the same matter. */
  value: number;
  weight: number;
  /** A short, content-free description for reviewers. */
  detail: string;
}

export interface Score {
  score: number;
  signals: Signal[];
  /** True when the pair cannot be a candidate at all (same thread or same source, or too far apart in time). */
  excluded: false | "SAME_THREAD" | "SAME_SOURCE" | "TOO_FAR_APART";
}

/** A candidate is queued for a person only at or above this score. Below it the message simply starts its own item. */
export const SHOW_THRESHOLD = 0.45;
/** Messages further apart than this are never candidates. */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

const WEIGHTS: Record<SignalName, number> = { time: 0.2, sender: 0.2, reference: 0.25, text: 0.35 };

const STOPWORDS = new Set(
  "the and for are but not you your our out has have had was were with this that from they them their what when where which who will would could should can cant cannot get got just now all any one two its it's his her him she there then than too very into onto over under about after before again also been being does did doing done more most some such only own same other each few both those these here why how please thanks thank hello hi dear regards team need help issue problem".split(" "),
);

export const normalizeText = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/** Reference-like tokens: ticket and order numbers, "#1234", "INV-0042", long digit runs, error codes. */
export function extractReferences(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/#\d{3,}|\b[A-Za-z]{2,6}-\d{2,}\b|\b\d{5,}\b|\b0x[0-9a-fA-F]{3,}\b|\bE\d{3,}\b/g)) out.add(m[0].toLowerCase());
  return out;
}

const timeValue = (deltaMs: number): number => {
  const h = deltaMs / 3_600_000;
  return h <= 0.5 ? 1 : h <= 2 ? 0.8 : h <= 8 ? 0.4 : h <= 24 ? 0.15 : 0;
};

const addr = (s: string | null) => s?.trim().toLowerCase() || null;
const name = (s: string | null) => s?.trim().toLowerCase().replace(/\s+/g, " ") || null;

function senderValue(a: MessageFeatures, b: MessageFeatures): { value: number; detail: string } {
  const [x, y] = [addr(a.senderAddress), addr(b.senderAddress)];
  if (x && y && x === y) return { value: 1, detail: "same sender address" };
  const [n, m] = [name(a.senderName), name(b.senderName)];
  if (n && m && n.length >= 3 && n === m) return { value: 0.8, detail: "same sender name" };
  return { value: 0, detail: "different senders" };
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
};

/** Score how likely `message` (the new one) and `other` (the tracked item's origin message) are about the same matter. */
export function scorePair(message: MessageFeatures, other: MessageFeatures): Score {
  const none = (excluded: Score["excluded"]): Score => ({ score: 0, signals: [], excluded });
  if (message.threadId === other.threadId) return none("SAME_THREAD");
  if (message.monitoredSourceId === other.monitoredSourceId) return none("SAME_SOURCE"); // same channel: separate threads are separate matters
  const delta = Math.abs(message.sentAt.getTime() - other.sentAt.getTime());
  if (delta > MAX_WINDOW_MS) return none("TOO_FAR_APART");

  const words = (m: MessageFeatures) => new Set(normalizeText(`${m.subject ?? ""} ${m.text}`));
  const shared = [...extractReferences(`${message.subject ?? ""} ${message.text}`)].filter((r) => extractReferences(`${other.subject ?? ""} ${other.text}`).has(r)).length;
  const sim = jaccard(words(message), words(other));
  const sender = senderValue(message, other);

  const signals: Signal[] = [
    { name: "time", value: timeValue(delta), weight: WEIGHTS.time, detail: `${Math.round(delta / 60_000)} minutes apart` },
    { name: "sender", value: sender.value, weight: WEIGHTS.sender, detail: sender.detail },
    { name: "reference", value: shared > 0 ? 1 : 0, weight: WEIGHTS.reference, detail: shared > 0 ? `${shared} shared reference number${shared === 1 ? "" : "s"}` : "no shared reference numbers" },
    { name: "text", value: Math.min(1, sim / 0.4), weight: WEIGHTS.text, detail: `${Math.round(sim * 100)}% wording overlap` },
  ];
  let score = signals.reduce((sum, s) => sum + s.value * s.weight, 0);
  // Being close in time or from the same person is not evidence about the matter itself. Without a shared reference or
  // real wording overlap, the score cannot reach the review threshold.
  if (shared === 0 && sim < 0.1) score = Math.min(score, SHOW_THRESHOLD - 0.1);
  return { score: Math.round(Math.min(1, score) * 1000) / 1000, signals, excluded: false };
}
