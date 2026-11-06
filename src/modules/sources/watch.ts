import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { ProviderAuthError } from "@/modules/integrations";
import { resolveDeps, type SourcesDeps } from "./config";
import { markConnectionAuthFailed, withAccessToken } from "./credentials";

/**
 * Gmail push watches. A watch asks Gmail to publish mailbox changes to our Pub/Sub topic. It lapses after 7 days, so the
 * scan renews every watch that has less than a day left. Push is only an accelerator: polling syncs the mailbox anyway, so a
 * lapsed or failed watch delays mail, it never loses any.
 */
const RENEW_WITHIN_MS = 24 * 3_600_000;

export async function ensureWatch(organizationId: string, connectionId: string, deps: SourcesDeps = {}): Promise<Date | null> {
  const topic = getEnv().GMAIL_PUBSUB_TOPIC;
  if (!topic) return null;
  const { client } = resolveDeps(deps);
  const watch = await withAccessToken(organizationId, connectionId, deps, (token) => client.watch(token, { topicName: topic }));
  await withTenant({ organizationId }, (tx) => tx.connectionCredential.updateMany({ where: { connectionId }, data: { watchExpiresAt: watch.expiresAt } }));
  return watch.expiresAt;
}

export interface RenewalSummary { checked: number; renewed: number; failed: number }

/** Renew the watches of one organization's active Gmail connections that are missing or close to lapsing. One failure never stops the rest. */
export async function renewDueWatches(organizationId: string, deps: SourcesDeps = {}): Promise<RenewalSummary> {
  const summary: RenewalSummary = { checked: 0, renewed: 0, failed: 0 };
  if (!getEnv().GMAIL_PUBSUB_TOPIC) return summary;
  const { now } = resolveDeps(deps);
  const due = await withTenant({ organizationId }, async (tx) => {
    const creds = await tx.connectionCredential.findMany({ where: { connection: { provider: "GMAIL", status: "ACTIVE" } }, select: { connectionId: true, watchExpiresAt: true } });
    return creds.filter((c) => !c.watchExpiresAt || c.watchExpiresAt.getTime() - now().getTime() < RENEW_WITHIN_MS);
  });
  summary.checked = due.length;
  for (const c of due) {
    try {
      await ensureWatch(organizationId, c.connectionId, deps);
      summary.renewed++;
    } catch (e) {
      summary.failed++;
      if (e instanceof ProviderAuthError) await markConnectionAuthFailed(organizationId, c.connectionId, e.code);
      log("error", "gmail.watch_renewal_failed", { organizationId, connectionId: c.connectionId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return summary;
}
