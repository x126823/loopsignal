"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jobIds, QUEUES, queueHub } from "@/lib/queue";
import { assertCan, ForbiddenError } from "@/modules/identity";
import { linkChatPerson } from "@/modules/ingestion";
import { beginGmailConnect, ChatClaimError, ChatDisabledError, disconnectGmail, GmailDisabledError, OAUTH_COOKIE, OAuthError, removeChatSpace, startSpaceClaim, verifySpaceClaim } from "@/modules/sources";
import { chatClaimForm, claimIdForm, connectGmailForm, disconnectForm, formObject, linkPersonForm, removeSpaceForm, syncNowForm } from "../../../_lib/forms";
import type { NoticeKey } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";

/**
 * Connection management is for organization admins. Like every server action these are reachable by direct POST, so each one
 * re-resolves the caller and re-checks the role itself; hiding the buttons is a convenience, not the control.
 */
const PAGE = "/settings/connections";
const back = (key: NoticeKey): never => redirect(`${PAGE}?notice=${key}`);

/** Start the consent flow: sets the short-lived, HttpOnly cookie that binds the callback to this browser, then goes to Google. */
export async function connectGmailAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = connectGmailForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let url: string;
  try {
    const started = await beginGmailConnect(ctx.principal, { teamId: parsed.data.teamId });
    (await cookies()).set(OAUTH_COOKIE, started.cookieValue, {
      httpOnly: true, sameSite: "lax", secure: getEnv().NODE_ENV === "production", path: "/api/gmail", maxAge: started.maxAgeSec,
    });
    url = started.url;
  } catch (e) {
    if (e instanceof ForbiddenError) return back("forbidden");
    if (e instanceof GmailDisabledError) return back("gmail_disabled");
    if (e instanceof OAuthError) return back("not_found");
    throw e;
  }
  return redirect(url); // outside the try: redirect() works by throwing
}

export async function disconnectGmailAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = disconnectForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey;
  try {
    const outcome = await disconnectGmail(ctx.principal, parsed.data.connectionId);
    key = outcome === "NOT_FOUND" ? "not_found" : "gmail_disconnected";
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    key = "forbidden";
  }
  revalidatePath(PAGE);
  return back(key);
}

/** Queue a sync of one mailbox or space now instead of waiting for the next scheduled one. */
export async function syncNowAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = syncNowForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey = "sync_queued";
  try {
    assertCan(ctx.principal, "org:manage", { organizationId: ctx.org.id });
    const source = await withTenant({ organizationId: ctx.org.id, userId: ctx.user.id }, (tx) =>
      tx.monitoredSource.findFirst({ where: { id: parsed.data.sourceId, enabled: true, connection: { provider: { in: ["GMAIL", "GOOGLE_CHAT"] }, status: "ACTIVE" } } }));
    if (!source) key = "not_found";
    else {
      const job = { organizationId: ctx.org.id, monitoredSourceId: source.id };
      await queueHub().enqueue(QUEUES.ingestSource, job, jobIds.ingestSource(job, `manual-${Date.now()}`));
    }
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    key = "forbidden";
  }
  revalidatePath(PAGE);
  return back(key);
}

// ---- Google Chat ------------------------------------------------------------------------------------------------------------------

/** Ask to connect a space: creates the one-time code the admin must post in it. */
export async function startChatClaimAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = chatClaimForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey = "chat_claim_started";
  try {
    await startSpaceClaim(ctx.principal, parsed.data);
  } catch (e) {
    if (e instanceof ForbiddenError) key = "forbidden";
    else if (e instanceof ChatDisabledError) key = "chat_disabled";
    else if (e instanceof ChatClaimError) key = e.code === "invalid_space" ? "chat_invalid_space" : e.code === "already_bound" ? "chat_already_bound" : "not_found";
    else throw e;
  }
  revalidatePath(PAGE);
  return back(key);
}

export async function verifyChatClaimAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = claimIdForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey;
  try {
    const out = await verifySpaceClaim(ctx.principal, parsed.data.claimId);
    key = {
      VERIFIED: "chat_bound", CODE_NOT_SEEN: "chat_code_not_seen", APP_NOT_IN_SPACE: "chat_app_not_in_space", EXPIRED: "chat_claim_expired",
      NOT_PENDING: "chat_claim_gone", NOT_FOUND: "not_found", ALREADY_BOUND: "chat_already_bound", CLAIMED_EARLIER: "chat_claimed_earlier",
    }[out.outcome] as NoticeKey;
  } catch (e) {
    if (e instanceof ForbiddenError) key = "forbidden";
    else if (e instanceof ChatDisabledError) key = "chat_disabled";
    else throw e;
  }
  revalidatePath(PAGE);
  return back(key);
}

export async function removeChatSpaceAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = removeSpaceForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey;
  try {
    key = (await removeChatSpace(ctx.principal, parsed.data.sourceId)) === "NOT_FOUND" ? "not_found" : "chat_removed";
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    key = "forbidden";
  }
  revalidatePath(PAGE);
  return back(key);
}

/** Say which LoopSignal user a Chat person is (or that they are nobody on our team). */
export async function linkChatPersonAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = linkPersonForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey;
  try {
    const out = await linkChatPerson(ctx.principal, parsed.data);
    key = out === "LINKED" ? "chat_person_linked" : out === "UNLINKED" ? "chat_person_unlinked" : out === "UNCHANGED" ? "noop" : "chat_person_invalid";
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    key = "forbidden";
  }
  revalidatePath(PAGE);
  return back(key);
}
