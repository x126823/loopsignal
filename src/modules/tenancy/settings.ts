import type { TenantTx } from "@/lib/db";
import { withTenant } from "@/lib/db";

/**
 * Organization.settings is one JSON object with a key per feature (for example `llm`, `retention`). Callers own their key's shape and
 * validate it; this module only reads and merges, so one feature can never overwrite another's settings.
 */
export async function getOrganizationSetting(organizationId: string, key: string): Promise<unknown> {
  return withTenant({ organizationId }, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const settings = org?.settings;
    return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>)[key] : undefined;
  });
}

/** Set one key, keeping every other key. Runs in the caller's transaction so it commits together with the caller's audit row. */
export async function setOrganizationSetting(tx: TenantTx, organizationId: string, key: string, value: unknown): Promise<void> {
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const current = org?.settings && typeof org.settings === "object" && !Array.isArray(org.settings) ? (org.settings as Record<string, unknown>) : {};
  await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...current, [key]: value } as object } });
}
