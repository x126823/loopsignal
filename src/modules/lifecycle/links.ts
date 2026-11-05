// Attaching messages from another channel to an existing item. This changes which messages an item shows and what its replies
// can act on. It never changes item state or the four metrics (rule 1 is about those), so it needs no transition. Callers
// (the correlation module) authorize, audit in the same transaction, and pass their own tenant transaction.
import { withTenant, type TenantTx } from "@/lib/db";
import type { ThreadItem } from "./queries";

/** Attach every message currently in `threadId` to the item, with role OTHER. Idempotent. Returns the attached message ids. */
export async function linkThreadToItem(tx: TenantTx, req: { organizationId: string; itemId: string; threadId: string }): Promise<{ messageIds: string[]; created: number }> {
  const messages = await tx.message.findMany({ where: { threadId: req.threadId }, select: { id: true } });
  const { count } = await tx.itemMessageLink.createMany({
    data: messages.map((m) => ({ organizationId: req.organizationId, itemId: req.itemId, messageId: m.id, role: "OTHER" as const })),
    skipDuplicates: true,
  });
  return { messageIds: messages.map((m) => m.id), created: count };
}

export type UnlinkOutcome = { outcome: "UNLINKED"; removed: number } | { outcome: "BLOCKED"; reason: "THREAD_HAS_HISTORY" };

/**
 * Detach a thread from an item. Refused when any of its messages already drove a lifecycle transition (their link role is no
 * longer OTHER): the item's history cites them, and history is never rewritten.
 */
export async function unlinkThreadFromItem(tx: TenantTx, req: { itemId: string; threadId: string }): Promise<UnlinkOutcome> {
  const links = await tx.itemMessageLink.findMany({ where: { itemId: req.itemId, message: { threadId: req.threadId } }, select: { id: true, role: true } });
  if (links.some((l) => l.role !== "OTHER")) return { outcome: "BLOCKED", reason: "THREAD_HAS_HISTORY" };
  const { count } = await tx.itemMessageLink.deleteMany({ where: { id: { in: links.map((l) => l.id) } } });
  return { outcome: "UNLINKED", removed: count };
}

/** The item an unowned thread was attached to from another channel (most recent first), or null. Read-only. */
export async function findLinkedItem(organizationId: string, threadId: string): Promise<ThreadItem | null> {
  return withTenant({ organizationId }, async (tx) => {
    const link = await tx.itemMessageLink.findFirst({
      where: { message: { threadId }, item: { threadId: { not: threadId } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { item: true },
    });
    const item = link?.item;
    return item ? { id: item.id, state: item.state, teamId: item.teamId, originMessageId: item.originMessageId, version: item.version, closedAt: item.closedAt } : null;
  });
}

/** Threads attached to an item from other channels. Read-only; callers authorize. */
export async function listLinkedThreadIds(organizationId: string, itemId: string): Promise<string[]> {
  return withTenant({ organizationId }, async (tx) => {
    const item = await tx.trackedItem.findUnique({ where: { id: itemId }, select: { threadId: true } });
    if (!item) return [];
    const rows = await tx.itemMessageLink.findMany({ where: { itemId, role: { not: "ORIGIN" }, message: { threadId: { not: item.threadId } } }, select: { message: { select: { threadId: true } } } });
    return [...new Set(rows.map((r) => r.message.threadId))];
  });
}

export interface CorrelationTarget {
  id: string;
  teamId: string;
  title: string;
  state: ThreadItem["state"];
  originMessageId: string;
  threadId: string;
}

/** Open items that a new message could belong to, newest first. Bounded; callers narrow further by message time. Read-only. */
export async function listOpenItemsForCorrelation(organizationId: string, opts: { excludeThreadId: string; limit?: number }): Promise<CorrelationTarget[]> {
  return withTenant({ organizationId }, async (tx) => {
    const items = await tx.trackedItem.findMany({
      where: { state: { not: "CLOSED" }, threadId: { not: opts.excludeThreadId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit ?? 300,
    });
    return items.map((i) => ({ id: i.id, teamId: i.teamId, title: i.title, state: i.state, originMessageId: i.originMessageId, threadId: i.threadId }));
  });
}

export interface ItemHeader {
  id: string;
  teamId: string;
  title: string;
  state: ThreadItem["state"];
  threadId: string;
}

/** The few item fields a caller needs to authorize an action on it, inside the caller's transaction. */
export async function loadItemHeader(tx: TenantTx, itemId: string): Promise<ItemHeader | null> {
  const i = await tx.trackedItem.findUnique({ where: { id: itemId } });
  return i && { id: i.id, teamId: i.teamId, title: i.title, state: i.state, threadId: i.threadId };
}

/** Close the open review task(s) about one subject, inside the caller's transaction. Returns how many were closed. */
export async function closeReviewTasksFor(tx: TenantTx, req: { type: "CORRELATION"; refType: string; refId: string; status: "RESOLVED" | "DISMISSED"; resolution: string }): Promise<number> {
  const { count } = await tx.reviewTask.updateMany({
    where: { type: req.type, refType: req.refType, refId: req.refId, status: "OPEN" },
    data: { status: req.status, resolution: req.resolution.slice(0, 500) },
  });
  return count;
}
