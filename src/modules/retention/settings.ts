import { z } from "zod";
import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "@/modules/identity";
import { getOrganizationSetting, setOrganizationSetting } from "@/modules/tenancy";

/**
 * How long stored content is kept, per organization (administrators only). Defaults were chosen with the user: raw provider payloads
 * 30 days after receipt; message bodies and analysis quotes 180 days after their item closed (or after receipt if never tied to an item).
 * Lifecycle events and the audit log hold ids and metadata, not content, and are kept indefinitely.
 *
 * Floors protect against accidents. Messages must outlive the longest first sync (a mailbox's backfill is up to 90 days, and an older
 * message would otherwise be fetched, stored and purged again), and a raw payload (a full copy of the message) must never outlive the
 * body it duplicates.
 */
export const RETENTION_DEFAULTS = { rawEventDays: 30, messageDays: 180 } as const;
export const RETENTION_LIMITS = { rawEventDays: { min: 7, max: 3650 }, messageDays: { min: 90, max: 3650 } } as const;

export const retentionSchema = z
  .object({
    rawEventDays: z.number().int().min(RETENTION_LIMITS.rawEventDays.min).max(RETENTION_LIMITS.rawEventDays.max),
    messageDays: z.number().int().min(RETENTION_LIMITS.messageDays.min).max(RETENTION_LIMITS.messageDays.max),
  })
  .strict()
  .refine((r) => r.rawEventDays <= r.messageDays, { message: "raw payloads cannot be kept longer than message bodies", path: ["rawEventDays"] });
export type Retention = z.infer<typeof retentionSchema>;

/** The organization's windows. A missing or invalid stored value falls back to the defaults, never to "keep forever" or "delete now". */
export async function getRetention(organizationId: string): Promise<Retention> {
  const parsed = retentionSchema.safeParse(await getOrganizationSetting(organizationId, "retention"));
  return parsed.success ? parsed.data : { ...RETENTION_DEFAULTS };
}

export class InvalidRetentionError extends Error {
  constructor() {
    super("The retention settings are not valid");
    this.name = "InvalidRetentionError";
  }
}

export async function setRetention(principal: Principal, input: unknown): Promise<Retention> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  const parsed = retentionSchema.safeParse(input);
  if (!parsed.success) throw new InvalidRetentionError();
  const before = await getRetention(principal.organizationId);
  await withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    await setOrganizationSetting(tx, principal.organizationId, "retention", parsed.data);
    await recordAudit(tx, {
      organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "retention.settings_changed", entityType: "Organization", entityId: principal.organizationId,
      metadata: { before, after: parsed.data },
    });
  });
  return parsed.data;
}
