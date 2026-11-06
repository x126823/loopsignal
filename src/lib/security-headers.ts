/**
 * Browser-side defenses (SECURITY.md: XSS, clickjacking, mixed content). Pure, so it is unit-tested; src/proxy.ts applies the per-request
 * policy and next.config.ts applies the static headers.
 *
 * The policy is nonce-based: a script runs only if it carries this request's random nonce (or was loaded by one that does), so injected
 * markup cannot execute. The one inline style allowance is for style ATTRIBUTES (the dashboard's bar widths); attributes cannot run script.
 * `form-action` lists the OAuth provider because a form that redirects to Google's consent screen is a form submission to that origin.
 */
export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Extra origins a form may end up on: the consent screen, and (tests only) the fake Google. */
  formActionOrigins?: string[];
}

export function buildCsp({ nonce, isDev, formActionOrigins = [] }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`, // dev only: React rebuilds server stacks with eval
    // Dev only: the dev server injects its own <style> elements without a nonce (production serves CSS as files), and 'unsafe-inline' is
    // ignored whenever a nonce is present, so development drops the nonce here.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`, // dev only: hot reload
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${formActionOrigins.length ? ` ${formActionOrigins.join(" ")}` : ""}`,
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Headers that never vary per request. HSTS is production-only (it would pin localhost to https in development). */
export function staticSecurityHeaders(isProd: boolean): Array<{ key: string; value: string }> {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  ];
}

/** Origins a form submission may be redirected to: Google's consent screen, plus the test double when one is configured (never in production). */
export function formActionOriginsFor(env: { NODE_ENV?: string | undefined; GOOGLE_TEST_BASE_URL?: string | undefined }): string[] {
  const origins = ["https://accounts.google.com"];
  if (env.NODE_ENV !== "production" && env.GOOGLE_TEST_BASE_URL) {
    try { origins.push(new URL(env.GOOGLE_TEST_BASE_URL).origin); } catch { /* an invalid value is ignored here; the env schema reports it */ }
  }
  return origins;
}
