import { z } from "zod";
import { findGmailMailboxSources } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { createGoogleKeySource } from "./keys";
import { verifyPubSubToken, type KeySource } from "@/modules/integrations";
import { gmailEnabled } from "./config";

/**
 * Pub/Sub push endpoint logic. Google signs every push with a token naming our audience and service account; anything else is
 * refused before the body is even parsed. A valid notification only says "mailbox X changed": it queues a sync of that
 * mailbox's sources and nothing more (the sync, not the notification, reads mail). Replays and duplicates collapse because the
 * job id includes the history id.
 */
export type PushOutcome =
  | { status: 204; queued: number }
  | { status: 400 | 401 | 404 };

const envelope = z.object({ message: z.object({ data: z.string().min(1).max(10_000) }) }).passthrough();
const notification = z.object({ emailAddress: z.string().email().max(320), historyId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]) });

export interface PushDeps { hub: QueueHub; keys?: KeySource; now?: () => number }

export async function handleGmailPush(input: { authorization: string | null; body: unknown }, deps: PushDeps): Promise<PushOutcome> {
  const env = getEnv();
  if (!gmailEnabled() || !env.GMAIL_PUBSUB_TOPIC || !env.GMAIL_PUSH_AUDIENCE || !env.GMAIL_PUSH_SERVICE_ACCOUNT) return { status: 404 };

  const token = /^Bearer (\S+)$/.exec(input.authorization ?? "")?.[1];
  if (!token) return { status: 401 };
  const verdict = await verifyPubSubToken(token, { audience: env.GMAIL_PUSH_AUDIENCE, serviceAccount: env.GMAIL_PUSH_SERVICE_ACCOUNT }, deps.keys ?? createGoogleKeySource(), deps.now?.());
  if (!verdict.ok) {
    log("warn", "gmail.push_rejected", { reason: verdict.reason });
    return { status: 401 };
  }

  const outer = envelope.safeParse(input.body);
  if (!outer.success) return { status: 400 };
  let inner;
  try { inner = notification.safeParse(JSON.parse(Buffer.from(outer.data.message.data, "base64").toString("utf8"))); } catch { return { status: 400 }; }
  if (!inner.success) return { status: 400 };

  // An unknown mailbox is not an error to Pub/Sub (a retry would not help): acknowledge it and queue nothing.
  const sources = await findGmailMailboxSources(inner.data.emailAddress.toLowerCase());
  for (const s of sources) {
    const job = { organizationId: s.organizationId, monitoredSourceId: s.monitoredSourceId };
    await deps.hub.enqueue(QUEUES.ingestSource, job, jobIds.ingestSource(job, `push-${inner.data.historyId}`));
  }
  log("info", "gmail.push_accepted", { queued: sources.length });
  return { status: 204, queued: sources.length };
}
