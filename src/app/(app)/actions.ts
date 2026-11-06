"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { jobIds, QUEUES, queueHub } from "@/lib/queue";
import { confirmCandidate, listAwaitingFollowUp, rejectCandidate, splitCandidate, type DecisionOutcome as CorrelationOutcome } from "@/modules/correlation";
import { ForbiddenError } from "@/modules/identity";
import { apply, assignOwner, decideApproval, LifecycleConflictError, resolveReviewTask } from "@/modules/lifecycle";
import { listUserOrganizations } from "@/modules/tenancy";
import { approvalForm, correlationForm, formObject, orgForm, ownerForm, reviewForm, transitionForm } from "../_lib/forms";
import { noticeForCorrelation, noticeForDecision, noticeForOutcome, noticeForOwner, noticeForReview, type NoticeKey } from "../_lib/notices";
import { ORG_COOKIE, requireContext } from "../_lib/session";

/**
 * Server actions are reachable by direct POST, so each one: (1) re-resolves the caller and their role from the database,
 * (2) validates the form with Zod and treats every field as untrusted, (3) calls the lifecycle engine, which re-checks
 * legality and permission itself, and (4) reports the outcome through a fixed notice key. A hidden or edited form field
 * gains nothing: the engine decides.
 *
 * `redirect()` works by throwing, so it is only ever called AFTER the try/catch, never inside it.
 */
async function finish(path: string, work: () => Promise<NoticeKey>): Promise<never> {
  let key: NoticeKey;
  try {
    key = await work();
  } catch (e) {
    if (e instanceof ForbiddenError) key = "forbidden";
    else if (e instanceof LifecycleConflictError) key = "conflict";
    else throw e; // unexpected: surface it, do not hide it
  }
  revalidatePath(path);
  return redirect(`${path}?notice=${key}`);
}

const tenant = (ctx: Awaited<ReturnType<typeof requireContext>>) => ({ organizationId: ctx.org.id, userId: ctx.user.id });

/** A person moves an item: propose or reject a resolution, confirm it, close it, or reopen it. */
export async function transitionAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = transitionForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/approvals?notice=invalid");
  const f = parsed.data;
  await finish(`/items/${f.itemId}`, async () =>
    noticeForOutcome(await withTenant(tenant(ctx), (tx) =>
      apply(tx, {
        organizationId: ctx.org.id, itemId: f.itemId, to: f.to, occurredAt: new Date(), expectedVersion: f.expectedVersion,
        ...(f.reason ? { reason: f.reason } : {}), actor: { type: "USER", principal: ctx.principal },
      }))));
}

/** A person approves or rejects a pending request (for example a suggested confirmation or reopening). */
export async function decideApprovalAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = approvalForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/approvals?notice=invalid");
  const f = parsed.data;
  await finish(`/items/${f.itemId}`, async () =>
    noticeForDecision(await withTenant(tenant(ctx), (tx) =>
      decideApproval(tx, {
        organizationId: ctx.org.id, approvalRequestId: f.approvalRequestId, decision: f.decision, principal: ctx.principal, occurredAt: new Date(),
        expectedVersion: f.expectedVersion, ...(f.reason ? { reason: f.reason } : {}),
      }))));
}

export async function assignOwnerAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = ownerForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/approvals?notice=invalid");
  const f = parsed.data;
  await finish(`/items/${f.itemId}`, async () =>
    noticeForOwner(await withTenant(tenant(ctx), (tx) => assignOwner(tx, { organizationId: ctx.org.id, itemId: f.itemId, userId: f.userId, principal: ctx.principal, occurredAt: new Date() }))));
}

export async function resolveReviewAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = reviewForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/review?notice=invalid");
  const f = parsed.data;
  await finish("/review", async () => noticeForReview(await resolveReviewTask(ctx.principal, { id: f.taskId, status: f.status, ...(f.resolution ? { resolution: f.resolution } : {}) })));
}

/** Choose the active organization. The choice is validated against the user's real memberships, so a forged value does nothing. */
export async function switchOrganizationAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = orgForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/approvals?notice=invalid");
  const member = (await listUserOrganizations(ctx.user.id)).some((o) => o.id === parsed.data.organizationId);
  if (!member) redirect("/approvals?notice=forbidden");
  (await cookies()).set(ORG_COOKIE, parsed.data.organizationId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  redirect("/approvals");
}

/**
 * Queue the follow-up a decision calls for. The decision is already saved; if the queue is unreachable the person is told and the
 * review page offers a retry, so a decision is never lost or silently half-done.
 */
async function queueFollowUp(organizationId: string, candidateId: string): Promise<boolean> {
  try {
    await queueHub().enqueue(QUEUES.correlationFollowUp, { organizationId, candidateId }, jobIds.correlationFollowUp({ organizationId, candidateId }));
    return true;
  } catch {
    return false;
  }
}

async function decideCorrelation(formData: FormData, run: (ctx: Awaited<ReturnType<typeof requireContext>>, candidateId: string) => Promise<CorrelationOutcome>): Promise<void> {
  const ctx = await requireContext();
  const parsed = correlationForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/review?notice=invalid");
  const f = parsed.data;
  const back = f.from === "item" && f.itemId ? `/items/${f.itemId}` : "/review";
  await finish(back, async () => {
    const out = await run(ctx, f.candidateId);
    if (out.outcome === "REFUSED") return noticeForCorrelation(out);
    return (await queueFollowUp(ctx.org.id, f.candidateId)) ? noticeForCorrelation(out) : "follow_up_failed";
  });
}

/** A person says a message is about the same matter as an item we already track: its conversation is attached to that item. */
export async function confirmCorrelationAction(formData: FormData): Promise<void> {
  await decideCorrelation(formData, (ctx, candidateId) => confirmCandidate(ctx.principal, { candidateId }));
}
/** A person says it is a different matter: the message goes on to be tracked as its own item. */
export async function rejectCorrelationAction(formData: FormData): Promise<void> {
  await decideCorrelation(formData, (ctx, candidateId) => rejectCandidate(ctx.principal, { candidateId }));
}
/** A person detaches an attached conversation again (refused once it has moved the item forward). */
export async function splitCorrelationAction(formData: FormData): Promise<void> {
  await decideCorrelation(formData, (ctx, candidateId) => splitCandidate(ctx.principal, { candidateId }));
}

/** Retry the follow-up of a decision whose follow-up could not be queued. Safe to repeat: it is stamped once it succeeds. */
export async function retryFollowUpAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = correlationForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/review?notice=invalid");
  await finish("/review", async () => {
    const awaiting = await listAwaitingFollowUp(ctx.principal); // only people who may decide, and only decisions that are still waiting
    if (!awaiting.some((a) => a.candidateId === parsed.data.candidateId)) return "not_found";
    return (await queueFollowUp(ctx.org.id, parsed.data.candidateId)) ? "follow_up_retried" : "follow_up_failed";
  });
}
