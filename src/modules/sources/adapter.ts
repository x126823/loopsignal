import { getEnv } from "@/lib/env";
import {
  createGmailAdapter, ProviderAuthError, UnsupportedProviderError,
  type AdapterContext, type FetchPage, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "@/modules/integrations";
import { gmailEnabled, resolveDeps, type SourcesDeps } from "./config";
import { ConnectionAuthFailedError, getAccessToken, markConnectionAuthFailed } from "./credentials";

/**
 * The Gmail adapter for one connection, wired to that connection's stored credentials. When Google refuses the credentials
 * for good, the connection is marked ERROR (and audited) and the sync stops until a person reconnects.
 */
export function gmailAdapterFor(ctx: AdapterContext, deps: SourcesDeps = {}): ProviderAdapter {
  if (!gmailEnabled()) throw new UnsupportedProviderError("GMAIL"); // flag off: no Gmail adapter exists
  const resolved = resolveDeps(deps);
  const { organizationId, connectionId } = ctx;
  const inner = createGmailAdapter({
    client: resolved.client,
    backfillDays: getEnv().GMAIL_BACKFILL_DAYS,
    auth: {
      getToken: () => getAccessToken(organizationId, connectionId, deps),
      refresh: () => getAccessToken(organizationId, connectionId, deps, { force: true }),
    },
  });
  return {
    provider: "GMAIL",
    normalize: (event: RawProviderEvent) => inner.normalize(event),
    async fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage> {
      try {
        return await inner.fetch(source, cursor, limit);
      } catch (e) {
        if (!(e instanceof ProviderAuthError)) throw e;
        await markConnectionAuthFailed(organizationId, connectionId, e.code);
        throw new ConnectionAuthFailedError();
      }
    },
  };
}
