import { withTenant } from "@/lib/db";
import type { ItemState } from "../../../generated/prisma/enums";

export interface ThreadItem {
  id: string;
  state: ItemState;
  teamId: string;
  originMessageId: string;
  version: number;
  closedAt: Date | null;
}

/** The most recent item on a thread (open or closed), or null. Read-only. */
export async function findThreadItem(organizationId: string, threadId: string): Promise<ThreadItem | null> {
  return withTenant({ organizationId }, async (tx) => {
    const item = await tx.trackedItem.findFirst({ where: { threadId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    return item && { id: item.id, state: item.state, teamId: item.teamId, originMessageId: item.originMessageId, version: item.version, closedAt: item.closedAt };
  });
}

export type ReviewKind = "LOW_CONFIDENCE" | "CORRELATION" | "SCHEMA_FAILURE" | "OWNERSHIP";

/** Queue a human review task. Idempotent: an open task for the same subject is reused. Does not touch item state. */
export async function queueReviewTask(organizationId: string, task: { type: ReviewKind; refType: string; refId: string }): Promise<{ id: string; created: boolean }> {
  return withTenant({ organizationId }, async (tx) => {
    const open = await tx.reviewTask.findFirst({ where: { type: task.type, refType: task.refType, refId: task.refId, status: "OPEN" } });
    if (open) return { id: open.id, created: false };
    const created = await tx.reviewTask.create({ data: { organizationId, type: task.type, refType: task.refType, refId: task.refId } });
    return { id: created.id, created: true };
  });
}
