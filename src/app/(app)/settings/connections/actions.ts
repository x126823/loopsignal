"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jobIds, QUEUES, queueHub } from "@/lib/queue";
import { assertCan, ForbiddenError } from "@/modules/identity";
import { beginGmailConnect, disconnectGmail, GmailDisabledError, OAUTH_COOKIE, OAuthError } from "@/modules/sources";
import { connectGmailForm, disconnectForm, formObject, syncNowForm } from "../../../_lib/forms";
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

/** Queue a sync of one mailbox now instead of waiting for the next scheduled one. */
export async function syncNowAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = syncNowForm.safeParse(formObject(formData));
  if (!parsed.success) return back("invalid");
  let key: NoticeKey = "sync_queued";
  try {
    assertCan(ctx.principal, "org:manage", { organizationId: ctx.org.id });
    const source = await withTenant({ organizationId: ctx.org.id, userId: ctx.user.id }, (tx) =>
      tx.monitoredSource.findFirst({ where: { id: parsed.data.sourceId, enabled: true, connection: { provider: "GMAIL", status: "ACTIVE" } } }));
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
