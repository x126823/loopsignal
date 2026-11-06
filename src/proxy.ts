import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, formActionOriginsFor } from "@/lib/security-headers";

/**
 * Applies the Content Security Policy with a fresh nonce on every request (see src/lib/security-headers.ts). Every page here is rendered
 * dynamically, which is what lets Next.js attach the nonce to its own scripts. It does NOT make authorization decisions: every page and
 * server action resolves the caller itself (src/app/_lib/session.ts), because a proxy is not a place to rely on for access control.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    formActionOrigins: formActionOriginsFor({ NODE_ENV: process.env.NODE_ENV, GOOGLE_TEST_BASE_URL: process.env["GOOGLE_TEST_BASE_URL"] }),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
