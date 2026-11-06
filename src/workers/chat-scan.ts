// The Chat scan: runs on a schedule while the integration is enabled and queues a sync of every enabled Chat space. Polling is the only
// way new Chat messages arrive in this release (Workspace Events push is a documented follow-up). Idempotent: sync jobs are keyed by
// time bucket, so repeats collapse.
import { listOrganizationsWithChat } from "@/lib/db";
import { log } from "@/lib/log";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { enqueueOrganizationSync } from "@/modules/ingestion";
import { chatEnabled } from "@/modules/sources";

export const CHAT_SCAN_SCHEDULE_ID = "chat-scan-schedule";
export const CHAT_SCAN_EVERY_MS = 180_000;

/** Register the repeating scan. Only called when GOOGLE_CHAT_ENABLED is true; with the flag off no Chat schedule exists. */
export async function registerChatScanSchedule(hub: QueueHub, everyMs: number = CHAT_SCAN_EVERY_MS): Promise<void> {
  await hub.schedule(QUEUES.chatScan, CHAT_SCAN_SCHEDULE_ID, everyMs, {});
}

export interface ChatScanResult { organizations: number; syncsQueued: number; failures: number }

export async function handleChatScan(deps: { hub: QueueHub; now?: () => Date }): Promise<ChatScanResult> {
  const result: ChatScanResult = { organizations: 0, syncsQueued: 0, failures: 0 };
  if (!chatEnabled()) return result;
  const now = deps.now ?? (() => new Date());
  const bucket = Math.floor(now().getTime() / CHAT_SCAN_EVERY_MS);
  for (const organizationId of await listOrganizationsWithChat()) {
    result.organizations++;
    try {
      result.syncsQueued += (await enqueueOrganizationSync(organizationId, deps.hub, `poll-${bucket}`, { provider: "GOOGLE_CHAT" })).length;
    } catch (e) {
      result.failures++; // one organization's trouble must not stop the others
      log("error", "chat.scan_failed", { organizationId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return result;
}
