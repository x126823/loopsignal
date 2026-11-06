import { z } from "zod";
import { extractText, getHeader, decodeEncodedWords, parseAddress } from "./gmail-mime";
import type { GmailMessage, GoogleClient } from "./google";
import {
  NormalizationError, ProviderAuthError, ProviderCursorExpiredError,
  type FetchPage, type NormalizedMessage, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";

/**
 * Gmail adapter: fetch and normalize only. It reads mail with the read-only scope; it cannot send, label, archive or delete.
 *
 * Cursors (opaque to everyone else; `fetch` is the only code that reads them):
 *   null              first sync: read the last N days, then follow history from the mailbox's current historyId
 *   b.<H>.<pageToken> backfill in progress; H is the historyId captured BEFORE listing, so nothing sent meanwhile is missed
 *   h.<H>             caught up; the next fetch asks Gmail what changed since H
 *   h.<H>.<pageToken> history paging in progress
 * If Gmail no longer has history from H (a gap), the adapter restarts a bounded backfill and flags the page `RESYNC`. Every
 * message is deduplicated downstream by (organization, provider, message id), so reading some twice never duplicates anything.
 *
 * The stored raw payload is a projection of the Gmail message that drops fields that change over time (labels other than
 * "sent", historyId): otherwise a message read again after being marked read would look like a conflicting re-send.
 */
const CURSOR = /^(h|b)\.(\d{1,20})(?:\.(.{1,2000}))?$/;
const SYNC_LABELS = ["INBOX", "SENT"];
const SKIP_LABELS = ["DRAFT", "SPAM", "TRASH"];
const READ_CONCURRENCY = 4;

export interface GmailAuth {
  /** A valid access token (refreshing it if it is about to expire). */
  getToken(): Promise<string>;
  /** Force a refresh, after Gmail rejected the token we had. */
  refresh(): Promise<string>;
}

export interface GmailAdapterOptions {
  client: GoogleClient;
  auth: GmailAuth;
  backfillDays: number;
}

const payloadSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  mailbox: z.string().email().max(320),
  /** True when the message carries Gmail's SENT label: the mailbox owner sent it. */
  sent: z.boolean(),
  sentAtMs: z.number().int().positive(),
  from: z.string().min(1).max(2000),
  subject: z.string().max(2000).optional(),
  text: z.string().max(100_000),
  hasAttachments: z.boolean(),
}).strict();
export type GmailPayload = z.infer<typeof payloadSchema>;

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Project a Gmail message to the stable payload, or null when the message is not one we track (draft, spam, trash, other labels). */
export function projectMessage(m: GmailMessage, mailbox: string): GmailPayload | null {
  if (m.labelIds.some((l) => SKIP_LABELS.includes(l))) return null;
  if (!m.labelIds.some((l) => SYNC_LABELS.includes(l))) return null;
  const { text, hasAttachments } = extractText(m.payload);
  const subject = getHeader(m.payload, "subject");
  return {
    v: 1, id: m.id, threadId: m.threadId, mailbox: mailbox.toLowerCase(), sent: m.labelIds.includes("SENT"), sentAtMs: Number(m.internalDate),
    from: getHeader(m.payload, "from") ?? "", ...(subject ? { subject } : {}), text: text || "[no text content]", hasAttachments,
  };
}

export function createGmailAdapter(options: GmailAdapterOptions): ProviderAdapter {
  const { client, auth } = options;

  /** Run a call with the current token; if Gmail says the token is bad, refresh once and try again. */
  async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(await auth.getToken());
    } catch (e) {
      if (e instanceof ProviderAuthError && e.code === "unauthorized") return call(await auth.refresh());
      throw e;
    }
  }

  async function readMessages(ids: string[], mailbox: string): Promise<RawProviderEvent[]> {
    const out: Array<RawProviderEvent | null> = new Array(ids.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const message = await withToken((t) => client.getMessage(t, ids[i]!));
        const payload = message ? projectMessage(message, mailbox) : null;
        if (message && payload) out[i] = { provider: "GMAIL", externalId: message.id, receivedAt: new Date(Number(message.internalDate)), payload };
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, worker));
    return out.filter((e): e is RawProviderEvent => e !== null);
  }

  /** Read a page of the last N days. `startHistoryId` is fixed on the first page and carried in the cursor. */
  async function backfillPage(mailbox: string, limit: number, start: { historyId?: string; pageToken?: string }): Promise<{ events: RawProviderEvent[]; nextCursor: string; hasMore: boolean }> {
    const historyId = start.historyId ?? (await withToken((t) => client.getProfile(t))).historyId;
    const query = `(in:inbox OR in:sent) newer_than:${options.backfillDays}d`;
    const page = await withToken((t) => client.listMessages(t, { query, pageToken: start.pageToken, maxResults: limit }));
    const events = await readMessages(page.ids, mailbox);
    return page.nextPageToken
      ? { events, nextCursor: `b.${historyId}.${page.nextPageToken}`, hasMore: true }
      : { events, nextCursor: `h.${historyId}`, hasMore: false };
  }

  return {
    provider: "GMAIL",

    async fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage> {
      if (source.kind !== "MAILBOX") throw new Error("The Gmail adapter reads mailboxes only");
      const mailbox = source.externalId.toLowerCase();
      const size = Math.max(1, Math.min(limit, 100));
      if (cursor === null) return backfillPage(mailbox, size, {});

      const m = CURSOR.exec(cursor);
      if (!m) return { ...(await backfillPage(mailbox, size, {})), notice: "RESYNC" }; // unreadable cursor: treat like a gap
      const [, kind, historyId, pageToken] = m;
      if (kind === "b") {
        if (!pageToken) return { ...(await backfillPage(mailbox, size, {})), notice: "RESYNC" };
        return backfillPage(mailbox, size, { historyId: historyId!, pageToken });
      }
      try {
        const page = await withToken((t) => client.listHistory(t, { startHistoryId: historyId!, pageToken, maxResults: size }));
        const events = await readMessages(page.ids, mailbox);
        return page.nextPageToken
          ? { events, nextCursor: `h.${historyId}.${page.nextPageToken}`, hasMore: true }
          : { events, nextCursor: `h.${page.historyId}`, hasMore: false };
      } catch (e) {
        if (!(e instanceof ProviderCursorExpiredError)) throw e;
        return { ...(await backfillPage(mailbox, size, {})), notice: "RESYNC" };
      }
    },

    normalize(event: RawProviderEvent): NormalizedMessage {
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new NormalizationError("invalid_payload"); // never echo issues: they can contain content
      const p = parsed.data;
      const sender = parseAddress(p.from);
      if (!sender) throw new NormalizationError("invalid_sender");
      const direction = p.sent || sender.address === p.mailbox ? "OUTBOUND" : domainOf(sender.address) === domainOf(p.mailbox) ? "INTERNAL" : "INBOUND";
      const subject = p.subject ? decodeEncodedWords(p.subject).trim().slice(0, 998) : "";
      return {
        provider: "GMAIL",
        externalMessageId: p.id,
        externalThreadId: p.threadId,
        sentAt: new Date(p.sentAtMs),
        direction,
        sender: { address: sender.address, ...(sender.name ? { displayName: sender.name } : {}) },
        ...(subject ? { subject } : {}),
        bodyText: p.text || "[no text content]",
      };
    },
  };
}
