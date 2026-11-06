// The Gmail scan: runs on a schedule while the integration is enabled. For every organization with an active Gmail connection it
// queues a sync of each mailbox (history polling is the source of truth; Pub/Sub push only makes it faster) and renews push watches
// that are about to lapse. Idempotent: sync jobs are keyed by time bucket, and renewing a fresh watch is skipped.
import { listOrganizationsWithGmail } from "@/lib/db";
import { log } from "@/lib/log";
import type { QueueHub } from "@/lib/queue";
import { QUEUES } from "@/lib/queue";
import { enqueueOrganizationSync } from "@/modules/ingestion";
import { gmailEnabled, renewDueWatches, type SourcesDeps } from "@/modules/sources";

export const GMAIL_SCAN_SCHEDULE_ID = "gmail-scan-schedule";
export const GMAIL_SCAN_EVERY_MS = 180_000;

/** Register the repeating scan. Only called when GMAIL_ENABLED is true; with the flag off no Gmail schedule exists. */
export async function registerGmailScanSchedule(hub: QueueHub, everyMs: number = GMAIL_SCAN_EVERY_MS): Promise<void> {
  await hub.schedule(QUEUES.gmailScan, GMAIL_SCAN_SCHEDULE_ID, everyMs, {});
}

export interface GmailScanResult { organizations: number; syncsQueued: number; watchesRenewed: number; failures: number }

export async function handleGmailScan(deps: { hub: QueueHub; now?: () => Date; sources?: SourcesDeps }): Promise<GmailScanResult> {
  const result: GmailScanResult = { organizations: 0, syncsQueued: 0, watchesRenewed: 0, failures: 0 };
  if (!gmailEnabled()) return result;
  const now = deps.now ?? (() => new Date());
  const bucket = Math.floor(now().getTime() / GMAIL_SCAN_EVERY_MS);
  for (const organizationId of await listOrganizationsWithGmail()) {
    result.organizations++;
    try {
      result.syncsQueued += (await enqueueOrganizationSync(organizationId, deps.hub, `poll-${bucket}`, { provider: "GMAIL" })).length;
      result.watchesRenewed += (await renewDueWatches(organizationId, { now, ...deps.sources })).renewed;
    } catch (e) {
      // One organization's trouble must not stop the others.
      result.failures++;
      log("error", "gmail.scan_failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return result;
}
