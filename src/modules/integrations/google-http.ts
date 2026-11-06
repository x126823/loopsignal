import { z } from "zod";
import { ProviderApiError, ProviderAuthError, ProviderRateLimitError } from "./types";

/**
 * The request core shared by every Google client (Gmail, Chat, the OAuth token endpoints): throttling and server errors are retried
 * with backoff and `Retry-After`; everything else maps to a typed error carrying a status code only, never a body, token or address
 * (rules 6 and 10). Responses are untrusted and are validated with Zod by the caller through `parse`.
 */
export interface GoogleHttpOptions {
  fetchImpl?: typeof fetch;
  /** Replaced in tests so backoff costs nothing. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

export function createGoogleHttp(opts: GoogleHttpOptions = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  /** One logical request: retries throttling and server errors, maps everything else to a typed error. Returns parsed JSON or null (204). */
  async function send(url: string, init: RequestInit): Promise<{ status: number; json: unknown }> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        if (attempt >= maxAttempts) throw new ProviderApiError(0); // network failure or timeout
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (res.ok) return { status: res.status, json };
      const reason = (json as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason ?? "";
      const throttled = res.status === 429 || (res.status === 403 && /ratelimit/i.test(reason));
      if (throttled || res.status >= 500) {
        if (attempt >= maxAttempts) throw throttled ? new ProviderRateLimitError() : new ProviderApiError(res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : baseDelay * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 401) throw new ProviderAuthError("unauthorized");
      if (res.status === 403) throw new ProviderAuthError("forbidden");
      if (res.status === 400 && (json as { error?: unknown } | null)?.error === "invalid_grant") throw new ProviderAuthError("invalid_grant");
      throw new ProviderApiError(res.status);
    }
  }

  const parse = <T>(schema: z.ZodType<T>, json: unknown, status = 200): T => {
    const r = schema.safeParse(json);
    if (!r.success) throw new ProviderApiError(status); // never echo issues: they can contain content
    return r.data;
  };

  return { send, parse };
}
export type GoogleHttp = ReturnType<typeof createGoogleHttp>;
