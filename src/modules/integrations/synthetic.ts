import { z } from "zod";
import {
  NormalizationError, type FetchPage, type NormalizedMessage, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";

/**
 * Synthetic provider: deterministic fake mailbox data for development and tests (CLAUDE.md rule 7). It speaks a
 * small made-up wire format, which `normalize` validates exactly like a real provider's untrusted payload.
 */
const payloadSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    direction: z.enum(["INBOUND", "OUTBOUND", "INTERNAL"]),
    from: z.object({ address: z.string().email().max(320), name: z.string().max(200).optional() }).strict(),
    subject: z.string().max(998).optional(),
    body: z.string().min(1).max(100_000),
    sentAt: z.string().datetime(),
  })
  .strict();
export type SyntheticPayload = z.infer<typeof payloadSchema>;

const BASE = Date.UTC(2026, 9, 5, 9, 0);
const stamp = (min: number) => new Date(BASE + min * 60_000).toISOString();

/** A small deterministic inbox: requests, acknowledgments, substantive replies and a resolution. */
export function syntheticInbox(mailbox: string): SyntheticPayload[] {
  const customer = (n: number) => ({ address: `customer${n}@customer.synthetic.test`, name: `Customer ${n}` });
  const agent = { address: "support@synthetic.loopsignal.test", name: "Support" };
  const threads: Array<{ key: string; subject: string; customer: number; turns: Array<["c" | "a", string]> }> = [
    { key: "label-printer", subject: "Label printer jams", customer: 31, turns: [["c", "The label printer jams on every third sheet."], ["a", "Thanks, we have this and will take a look."]] },
    { key: "sso-login", subject: "SSO login fails for two users", customer: 32, turns: [["c", "Two of our users cannot sign in through SSO since this morning."], ["a", "Received, looking into it now."], ["a", "The identity provider certificate expired. I have rotated it; please ask them to retry."]] },
    { key: "export-csv", subject: "CSV export is missing a column", customer: 33, turns: [["c", "The CSV export no longer includes the region column."]] },
    { key: "invoice-copy", subject: "Copy of last month's invoice", customer: 34, turns: [["c", "Could you send a copy of last month's invoice?"], ["a", "Attached is last month's invoice."]] },
    { key: "api-timeout", subject: "API timeouts on bulk upload", customer: 35, turns: [["c", "Bulk uploads over 5000 rows time out after 30 seconds."], ["a", "Understood, we are reproducing it."], ["a", "A fix is rolling out today; uploads will stream instead of timing out."]] },
    { key: "welcome", subject: "Welcome to the platform", customer: 36, turns: [["c", "Thanks for the warm welcome, everything is working well so far."]] },
  ];
  const out: SyntheticPayload[] = [];
  let minute = 0;
  for (const t of threads) {
    t.turns.forEach(([who, body], i) => {
      minute += 7;
      out.push({
        v: 1, id: `${mailbox}/${t.key}/${i}`, threadId: `${mailbox}/${t.key}`, direction: who === "c" ? "INBOUND" : "OUTBOUND",
        from: who === "c" ? customer(t.customer) : agent, subject: t.subject, body, sentAt: stamp(minute),
      });
    });
  }
  return out;
}

export interface SyntheticOptions {
  /** Override the data per mailbox (tests inject duplicates, malformed or oversized payloads). */
  events?: (mailbox: string) => unknown[];
}

export function createSyntheticAdapter(options: SyntheticOptions = {}): ProviderAdapter {
  const dataset = options.events ?? syntheticInbox;
  return {
    provider: "SYNTHETIC",

    async fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage> {
      const all = dataset(source.externalId);
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid synthetic cursor");
      const slice = all.slice(offset, offset + Math.max(1, limit));
      const end = offset + slice.length;
      const events: RawProviderEvent[] = slice.map((payload, i) => {
        const id = (payload as { id?: unknown } | null)?.id;
        return {
          provider: "SYNTHETIC", payload,
          externalId: typeof id === "string" && id ? id : `${source.externalId}/unidentified/${offset + i}`,
          receivedAt: new Date(BASE + (offset + i) * 60_000),
        };
      });
      return { events, nextCursor: String(end), hasMore: end < all.length };
    },

    normalize(event: RawProviderEvent): NormalizedMessage {
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new NormalizationError("invalid_payload"); // never echo issues: they can contain content
      const p = parsed.data;
      return {
        provider: "SYNTHETIC",
        externalMessageId: p.id,
        externalThreadId: p.threadId,
        sentAt: new Date(p.sentAt),
        direction: p.direction,
        sender: { address: p.from.address.toLowerCase(), ...(p.from.name ? { displayName: p.from.name } : {}) },
        ...(p.subject ? { subject: p.subject } : {}),
        bodyText: p.body,
      };
    },
  };
}
