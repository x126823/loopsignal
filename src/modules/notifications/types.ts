import { z } from "zod";

/**
 * What can notify, and what each notification may carry: ids and small enums only, never message text or item titles. The text a
 * person reads is built when they open the inbox, from these ids and only for items they may still view (rule 10).
 */
const uuid = z.string().uuid();
const timerType = z.enum(["ACK", "RESPONSE", "RESOLVE", "CLOSE"]);

export const PAYLOADS = {
  sla_warning: z.object({ itemId: uuid, timerId: uuid, timerType, cycle: z.number().int().min(1) }).strict(),
  sla_breach: z.object({ itemId: uuid, timerId: uuid, timerType, cycle: z.number().int().min(1) }).strict(),
  approval_requested: z.object({ itemId: uuid, approvalRequestId: uuid, transition: z.enum(["RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"]) }).strict(),
  review_correlation: z.object({ itemId: uuid, candidateId: uuid }).strict(),
  review_ownership: z.object({ itemId: uuid }).strict(),
} as const;

export type NotificationType = keyof typeof PAYLOADS;
export const NOTIFICATION_TYPES = Object.keys(PAYLOADS) as NotificationType[];
export const isNotificationType = (v: unknown): v is NotificationType => typeof v === "string" && Object.hasOwn(PAYLOADS, v);
export type PayloadOf<T extends NotificationType> = z.infer<(typeof PAYLOADS)[T]>;

export const CHANNELS = ["IN_APP", "EMAIL"] as const;
export type Channel = (typeof CHANNELS)[number];

/** In-app is on and email is off until a person opts in. (Email is only recorded for now; nothing is sent.) */
export const DEFAULT_ENABLED: Record<Channel, boolean> = { IN_APP: true, EMAIL: false };

export const TYPE_LABEL: Record<NotificationType, string> = {
  sla_warning: "A deadline is due soon",
  sla_breach: "A deadline was missed",
  approval_requested: "A decision is waiting for you",
  review_correlation: "A possible duplicate needs a decision",
  review_ownership: "An item needs an owner",
};

const TIMER_LABEL = { ACK: "acknowledge", RESPONSE: "first substantive response", RESOLVE: "resolve", CLOSE: "close" } as const;
const TRANSITION_LABEL = { RESOLUTION_CONFIRMED: "confirm the resolution of", CLOSED: "close", REOPENED: "reopen" } as const;

/** The sentence and link for a notification. Pure. `title` is the item's title, supplied only when the reader may view the item. */
export function describeNotification(type: NotificationType, payload: unknown, title: string): { text: string; href: string } | null {
  const p = PAYLOADS[type].safeParse(payload);
  if (!p.success) return null; // a malformed payload is never shown, so it can never mislead
  const d = p.data as Record<string, string | number>;
  switch (type) {
    case "sla_warning": return { text: `Due soon: ${TIMER_LABEL[d["timerType"] as keyof typeof TIMER_LABEL]} deadline on "${title}"`, href: `/items/${d["itemId"]}` };
    case "sla_breach": return { text: `Missed: ${TIMER_LABEL[d["timerType"] as keyof typeof TIMER_LABEL]} deadline on "${title}"`, href: `/items/${d["itemId"]}` };
    case "approval_requested": return { text: `Please decide whether to ${TRANSITION_LABEL[d["transition"] as keyof typeof TRANSITION_LABEL]} "${title}"`, href: `/items/${d["itemId"]}` };
    case "review_correlation": return { text: `A new message may be a duplicate of "${title}"`, href: "/review" };
    case "review_ownership": return { text: `"${title}" needs an owner`, href: `/items/${d["itemId"]}` };
  }
}
