import { createSign } from "node:crypto";
import { z } from "zod";
import { createGoogleHttp, type GoogleHttpOptions } from "./google-http";
import { ProviderAuthError } from "./types";

/**
 * App authentication for Google APIs (the Chat app acts as itself). A service account signs a short-lived JWT (RS256, node:crypto: no
 * new dependency), Google exchanges it for an access token, and the token is cached until shortly before it expires.
 *
 *  - The key file is validated here, and a bad one throws a message that never includes any of its content.
 *  - The `token_uri` inside the key file is IGNORED: tokens are only ever requested from the endpoint the caller passes, so a doctored
 *    key file cannot make us send a signed assertion to another host.
 *  - The private key and the tokens never leave this closure: they are not logged and not part of any error.
 */
const keyFile = z.object({ client_email: z.string().email(), private_key: z.string().min(1).includes("PRIVATE KEY") }).passthrough();
export interface ServiceAccountKey { clientEmail: string; privateKey: string }

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("The service account key is not valid JSON"); }
  const r = keyFile.safeParse(parsed);
  if (!r.success) throw new Error("The service account key is missing client_email or private_key");
  return { clientEmail: r.data.client_email, privateKey: r.data.private_key };
}

export interface ServiceAccountTokenOptions extends GoogleHttpOptions {
  key: ServiceAccountKey;
  /** The token endpoint to use: Google's, or the fake in tests. */
  tokenUrl: string;
  scopes: string[];
  now?: () => number;
}

const response = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const REFRESH_MARGIN_MS = 300_000;

export function createServiceAccountTokens(opts: ServiceAccountTokenOptions) {
  const http = createGoogleHttp(opts);
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: opts.key.clientEmail, scope: opts.scopes.join(" "), aud: opts.tokenUrl, iat, exp: iat + 3600 })}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(opts.key.privateKey).toString("base64url");
    } catch {
      throw new ProviderAuthError("invalid_grant"); // an unusable private key is a credential failure, not a crash
    }
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
    const { json } = await http.send(opts.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const t = http.parse(response, json);
    cached = { token: t.access_token, expiresAt: now() + t.expires_in * 1000 };
    return t.access_token;
  };

  return {
    /** A valid access token, minting one if needed. Concurrent callers share one exchange. */
    async getToken(): Promise<string> {
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
      inflight ??= mint().finally(() => { inflight = null; });
      return inflight;
    },
    /** Drop the cached token, after Google rejected it. */
    invalidate(): void { cached = null; },
  };
}
export type ServiceAccountTokens = ReturnType<typeof createServiceAccountTokens>;
