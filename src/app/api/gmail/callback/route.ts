import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { jobIds, QUEUES, queueHub } from "@/lib/queue";
import { ForbiddenError } from "@/modules/identity";
import { completeGmailConnect, ensureWatch, gmailEnabled, OAUTH_COOKIE, OAuthError, type OAuthFailure } from "@/modules/sources";
import { ProviderApiError, ProviderAuthError, ProviderRateLimitError } from "@/modules/integrations";
import type { NoticeKey } from "../../../_lib/notices";
import { getContext } from "../../../_lib/session";

export const dynamic = "force-dynamic";

const NOTICE_FOR: Record<OAuthFailure, NoticeKey> = {
  state_invalid: "gmail_state", state_expired: "gmail_state", wrong_user: "gmail_state", denied: "gmail_denied",
  no_refresh_token: "gmail_no_refresh", scope_missing: "gmail_scope", team_not_found: "gmail_failed",
};

/**
 * Where Google sends the admin back with a one-time code. The result is only ever shown as a fixed notice key. The code, the
 * state and the cookie are never logged; the state and cookie are verified inside completeGmailConnect.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const base = getEnv().APP_BASE_URL;
  const to = (path: string) => NextResponse.redirect(new URL(path, base));
  const done = (key: NoticeKey) => {
    const res = to(`/settings/connections?notice=${key}`);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/gmail" }); // the cookie is single-use whatever the outcome
    return res;
  };
  if (!gmailEnabled()) return new NextResponse(null, { status: 404 });
  const ctx = await getContext();
  if (!ctx) return to("/login");

  const params = request.nextUrl.searchParams;
  try {
    const connected = await completeGmailConnect(ctx.principal, {
      code: params.get("code"), state: params.get("state"), providerError: params.get("error"), cookieValue: request.cookies.get(OAUTH_COOKIE)?.value ?? null,
    });
    // Both follow-ups are best effort: the scheduled scan queues a sync and renews the watch anyway.
    const job = { organizationId: ctx.org.id, monitoredSourceId: connected.monitoredSourceId };
    await queueHub().enqueue(QUEUES.ingestSource, job, jobIds.ingestSource(job, `connect-${Date.now()}`))
      .catch((e: Error) => log("warn", "gmail.connect_sync_not_queued", { errorName: e.name }));
    await ensureWatch(ctx.org.id, connected.connectionId).catch((e: Error) => log("warn", "gmail.connect_watch_failed", { errorName: e.name }));
    return done(connected.reconnected ? "gmail_reconnected" : "gmail_connected");
  } catch (e) {
    if (e instanceof OAuthError) return done(NOTICE_FOR[e.code]);
    if (e instanceof ForbiddenError) return done("forbidden");
    if (e instanceof ProviderAuthError || e instanceof ProviderApiError || e instanceof ProviderRateLimitError) {
      log("warn", "gmail.connect_failed", { errorName: e.name });
      return done("gmail_failed");
    }
    throw e;
  }
}
