import { z } from "zod";
import type { ChatClient, ChatMessage } from "./google-chat";
import {
  NormalizationError, ProviderApiError, ProviderAuthError,
  type FetchPage, type NormalizedMessage, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";

/**
 * Google Chat adapter: fetch and normalize only. It reads the messages of a space the Chat app was added to, as the app.
 *
 * Cursor (opaque to everyone else):
 *   null                    first read: messages from the last N days
 *   t.<createTime>          caught up to this message's creation time; the next read asks for messages after it
 *   t.<createTime>.<token>  mid-listing: the listing's starting point is fixed and the page token continues it
 * Messages are read oldest first, so the cursor only moves forward. A stale page token restarts that one listing from its starting point
 * (reading a message twice is harmless: ingestion dedupes on the message name). Two messages created in the same microsecond across two
 * separate listings is the one theoretical gap, and is documented rather than guessed around.
 *
 * Direction: people are INBOUND (ingestion later turns a message from a person linked to one of our users into OUTBOUND); other apps and
 * bots are INTERNAL and never tracked as requests. Chat has no subject line, and message text is encrypted at rest while a subject is stored in
 * the clear (it becomes the item's title), so the subject is built from who wrote the message, never from what they wrote.
 */
const CURSOR = /^t\.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)(?:\.(.{1,2000}))?$/;

export interface ChatTokens { getToken(): Promise<string>; invalidate(): void }
export interface ChatAdapterOptions { client: ChatClient; tokens: ChatTokens; backfillDays: number; now?: () => Date }

const payloadSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(500),
  space: z.string().min(1).max(200),
  thread: z.string().min(1).max(500),
  createTime: z.string().min(1).max(40),
  senderId: z.string().min(1).max(200),
  senderName: z.string().max(500).optional(),
  senderType: z.enum(["HUMAN", "BOT", "UNKNOWN"]),
  text: z.string().max(100_000),
}).strict();
export type ChatPayload = z.infer<typeof payloadSchema>;

/** Microseconds since the epoch of an RFC 3339 UTC timestamp, so two timestamps that differ only below a millisecond still order. */
function micros(ts: string): bigint {
  const m = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(ts);
  const whole = BigInt(Date.parse(`${m?.[1] ?? ts}Z`)) * 1000n;
  return whole + BigInt(((m?.[2] ?? "") + "000000").slice(0, 6));
}

/** Stable projection of a Chat message. Drops fields that change after posting (edit time, annotations, reactions). */
export function projectChatMessage(m: ChatMessage, space: string): ChatPayload {
  const type = m.sender?.type === "HUMAN" ? "HUMAN" : m.sender?.type === "BOT" ? "BOT" : "UNKNOWN";
  return {
    v: 1, name: m.name, space, thread: m.thread?.name ?? m.name, createTime: m.createTime,
    senderId: m.sender?.name ?? "users/unknown", ...(m.sender?.displayName ? { senderName: m.sender.displayName } : {}), senderType: type,
    text: (m.text ?? "").slice(0, 100_000),
  };
}

export function createChatAdapter(options: ChatAdapterOptions): ProviderAdapter {
  const now = options.now ?? (() => new Date());

  async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(await options.tokens.getToken());
    } catch (e) {
      if (e instanceof ProviderAuthError && e.code === "unauthorized") {
        options.tokens.invalidate();
        return call(await options.tokens.getToken());
      }
      throw e;
    }
  }

  return {
    provider: "GOOGLE_CHAT",

    async fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage> {
      if (source.kind !== "SPACE") throw new Error("The Chat adapter reads spaces only");
      const space = source.externalId;
      const parsed = cursor === null ? null : CURSOR.exec(cursor);
      const start = parsed?.[1] ?? new Date(now().getTime() - options.backfillDays * 86_400_000).toISOString();
      let pageToken = parsed?.[2];

      let page;
      try {
        page = await withToken((t) => options.client.listMessages(t, space, { afterCreateTime: start, pageToken, pageSize: limit }));
      } catch (e) {
        // A page token that has gone stale: restart this one listing from where it began. Everything re-read is deduplicated downstream.
        if (!(pageToken && e instanceof ProviderApiError && e.status === 400)) throw e;
        pageToken = undefined;
        page = await withToken((t) => options.client.listMessages(t, space, { afterCreateTime: start, pageSize: limit }));
      }

      const events: RawProviderEvent[] = page.messages.map((m) => ({ provider: "GOOGLE_CHAT", externalId: m.name, receivedAt: new Date(m.createTime), payload: projectChatMessage(m, space) }));
      if (page.nextPageToken) return { events, nextCursor: `t.${start}.${page.nextPageToken}`, hasMore: true };
      // End of the listing: move forward to the newest message we saw (never backwards).
      const newest = page.messages.reduce<string>((best, m) => (micros(m.createTime) > micros(best) ? m.createTime : best), start);
      return { events, nextCursor: `t.${newest}`, hasMore: false };
    },

    normalize(event: RawProviderEvent): NormalizedMessage {
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new NormalizationError("invalid_payload"); // never echo issues: they can contain content
      const p = parsed.data;
      const sentAt = new Date(p.createTime);
      if (Number.isNaN(sentAt.getTime())) throw new NormalizationError("invalid_time");
      return {
        provider: "GOOGLE_CHAT",
        externalMessageId: p.name,
        externalThreadId: p.thread,
        sentAt,
        direction: p.senderType === "BOT" ? "INTERNAL" : "INBOUND",
        sender: { address: p.senderId, ...(p.senderName ? { displayName: p.senderName } : {}) },
        subject: `Chat message from ${(p.senderName ?? "someone").slice(0, 80)}`,
        bodyText: p.text.trim() || "[no text content]",
      };
    },
  };
}
