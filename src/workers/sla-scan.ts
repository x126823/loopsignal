// The SLA scan: runs on a schedule, re-derives timers for every organization with SLA policies, and queues an advisory
// risk assessment for each timer that just entered its warning window. Idempotent: a replayed scan finds nothing new
// to warn about, and risk jobs are de-duplicated by timer id.
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { jobIds, QUEUES, type QueueHub } from "@/lib/queue";
import { scanAll, type ScanAllResult } from "@/modules/sla";

export const SLA_SCAN_SCHEDULE_ID = "sla-scan-schedule";
export const SLA_SCAN_EVERY_MS = 60_000;

/** Register the repeating scan. Safe to call on every worker start: the scheduler is keyed by id. */
export async function registerSlaScanSchedule(hub: QueueHub, everyMs: number = SLA_SCAN_EVERY_MS): Promise<void> {
  await hub.schedule(QUEUES.slaScan, SLA_SCAN_SCHEDULE_ID, everyMs, {});
}

export async function handleSlaScan(deps: { hub: QueueHub; clock?: Clock }): Promise<ScanAllResult & { riskJobs: number }> {
  const result = await scanAll({ clock: deps.clock ?? systemClock });
  let riskJobs = 0;
  for (const t of result.warned) {
    try {
      await deps.hub.enqueue(QUEUES.slaRisk, { organizationId: t.organizationId, itemId: t.itemId, timerId: t.timerId }, jobIds.slaRisk({ organizationId: t.organizationId, itemId: t.itemId, timerId: t.timerId }));
      riskJobs++;
    } catch (e) {
      // A failure to queue an advisory job must never fail the scan: the timers themselves are already settled.
      log("warn", "sla.risk_enqueue_failed", { organizationId: t.organizationId, itemId: t.itemId, errorName: e instanceof Error ? e.name : "unknown" });
    }
  }
  return { ...result, riskJobs };
}
