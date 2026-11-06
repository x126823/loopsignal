// Notifications. Created by workers (system context, no user), read and managed by the person they are for (user context, where
// row-level security shows only that person's own rows). Creation is idempotent per (recipient, channel, event).
import type { Prisma } from "../../../generated/prisma/client";
import { withTenant } from "@/lib/db";
import { can, type Principal } from "@/modules/identity";
import { listItemTitles } from "@/modules/lifecycle";
import { CHANNELS, DEFAULT_ENABLED, describeNotification, isNotificationType, NOTIFICATION_TYPES, PAYLOADS, type Channel, type NotificationType, type PayloadOf } from "./types";

const userCtx = (p: Principal) => ({ organizationId: p.organizationId, userId: p.userId });

/**
 * Notify people about one event. The payload is validated (ids and enums only). Each recipient gets an in-app notification unless
 * they turned it off, and an email record only if they turned it on (nothing is sent by email yet: those rows wait for a delivery
 * step). `dedupeKey` names the event, so replaying the job that raised it never notifies anyone twice.
 */
export async function createNotifications<T extends NotificationType>(
  organizationId: string, req: { type: T; recipients: readonly string[]; payload: PayloadOf<T>; dedupeKey: string },
): Promise<{ inApp: number; email: number }> {
  const payload = PAYLOADS[req.type].parse(req.payload);
  const recipients = [...new Set(req.recipients)];
  if (recipients.length === 0) return { inApp: 0, email: 0 };
  return withTenant({ organizationId }, async (tx) => {
    const prefs = await tx.notificationPreference.findMany({ where: { userId: { in: recipients }, type: req.type } });
    const enabled = (userId: string, channel: Channel) => prefs.find((p) => p.userId === userId && p.channel === channel)?.enabled ?? DEFAULT_ENABLED[channel];
    const out = { inApp: 0, email: 0 };
    for (const channel of CHANNELS) {
      const who = recipients.filter((u) => enabled(u, channel));
      if (who.length === 0) continue;
      const { count } = await tx.notification.createMany({
        data: who.map((recipientUserId) => ({ organizationId, recipientUserId, type: req.type, payload: payload as Prisma.InputJsonValue, channel, dedupeKey: req.dedupeKey })),
        skipDuplicates: true,
      });
      if (channel === "IN_APP") out.inApp = count; else out.email = count;
    }
    return out;
  });
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  text: string;
  href: string;
  createdAt: Date;
  readAt: Date | null;
}

/**
 * A person's own in-app notifications, newest first. A notification about an item they can no longer view is left out, and one with
 * a malformed payload is never shown. Returns text built from item titles, so never log it (rule 10).
 */
export async function listNotifications(principal: Principal, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationView[]> {
  const rows = await withTenant(userCtx(principal), (tx) =>
    tx.notification.findMany({
      where: { channel: "IN_APP", recipientUserId: principal.userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit ?? 50,
    }));
  const itemIds = rows.flatMap((r) => { const id = (r.payload as { itemId?: unknown } | null)?.itemId; return typeof id === "string" ? [id] : []; });
  const titles = await listItemTitles(principal, itemIds);
  return rows.flatMap((r): NotificationView[] => {
    if (!isNotificationType(r.type)) return [];
    const itemId = (r.payload as { itemId?: unknown } | null)?.itemId;
    const item = typeof itemId === "string" ? titles.get(itemId) : undefined;
    if (!item || !can(principal, "item:view", { organizationId: principal.organizationId, teamId: item.teamId })) return [];
    const d = describeNotification(r.type, r.payload, item.title);
    return d ? [{ id: r.id, type: r.type, text: d.text, href: d.href, createdAt: r.createdAt, readAt: r.readAt }] : [];
  });
}

/** How many unread in-app notifications the person can actually open. */
export async function countUnread(principal: Principal): Promise<number> {
  return (await listNotifications(principal, { unreadOnly: true, limit: 100 })).length;
}

/** Mark some (or all) of the person's own notifications read. Others' rows are untouchable: by the filter and by row-level security. */
export async function markRead(principal: Principal, req: { ids: readonly string[] } | { all: true }): Promise<number> {
  return withTenant(userCtx(principal), async (tx) => {
    const { count } = await tx.notification.updateMany({
      where: { channel: "IN_APP", recipientUserId: principal.userId, readAt: null, ...("all" in req ? {} : { id: { in: [...req.ids] } }) },
      data: { readAt: new Date() },
    });
    return count;
  });
}

export interface PreferenceRow {
  type: NotificationType;
  channel: Channel;
  enabled: boolean;
  /** True while the person has never changed it (the default applies). */
  isDefault: boolean;
}

/** Every type and channel with the person's effective setting. */
export async function listPreferences(principal: Principal): Promise<PreferenceRow[]> {
  const rows = await withTenant(userCtx(principal), (tx) => tx.notificationPreference.findMany({ where: { userId: principal.userId } }));
  return NOTIFICATION_TYPES.flatMap((type) => CHANNELS.map((channel): PreferenceRow => {
    const row = rows.find((r) => r.type === type && r.channel === channel);
    return { type, channel, enabled: row?.enabled ?? DEFAULT_ENABLED[channel], isDefault: !row };
  }));
}

/** Change one of the person's own settings. Anything that is not a known type and channel is refused. */
export async function setPreference(principal: Principal, req: { type: string; channel: string; enabled: boolean }): Promise<{ outcome: "SAVED" } | { outcome: "REFUSED"; reason: "UNKNOWN_TYPE" | "UNKNOWN_CHANNEL" }> {
  if (!isNotificationType(req.type)) return { outcome: "REFUSED", reason: "UNKNOWN_TYPE" };
  if (!(CHANNELS as readonly string[]).includes(req.channel)) return { outcome: "REFUSED", reason: "UNKNOWN_CHANNEL" };
  const channel = req.channel as Channel;
  await withTenant(userCtx(principal), (tx) =>
    tx.notificationPreference.upsert({
      where: { organizationId_userId_type_channel: { organizationId: principal.organizationId, userId: principal.userId, type: req.type as NotificationType, channel } },
      create: { organizationId: principal.organizationId, userId: principal.userId, type: req.type, channel, enabled: req.enabled },
      update: { enabled: req.enabled },
    }));
  return { outcome: "SAVED" };
}
