import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { z } from "zod";

/**
 * Verifies the signed token Google Pub/Sub attaches to every push request. Without this check anyone could POST to the push
 * endpoint; with it, only Google, acting as the service account we configured, can wake a sync. A rejected token yields a
 * stable reason code, never the token or its claims.
 */
const header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const claims = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  email: z.string(),
  email_verified: z.boolean().optional(),
  exp: z.number(),
});
const jwkSet = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string() }).passthrough()) });

export type TokenVerdict = { ok: true } | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "bad_claims" | "expired" | "wrong_audience" | "wrong_sender" };

export interface KeySource {
  /** Return the keys for `kid`. May refetch once when the kid is unknown (key rotation). */
  find(kid: string): Promise<JsonWebKey | null>;
}

/** Cache of Google's signing keys. Refetches at most once a minute when an unknown key id shows up, and every hour regardless. */
export function createKeySource(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): KeySource {
  let keys = new Map<string, JsonWebKey>();
  let fetchedAt = 0;
  const load = async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const parsed = jwkSet.safeParse(await res.json());
    if (!parsed.success) return;
    keys = new Map(parsed.data.keys.map((k) => [k.kid, k as unknown as JsonWebKey]));
    fetchedAt = now();
  };
  return {
    async find(kid) {
      if (now() - fetchedAt > 3_600_000) await load().catch(() => undefined);
      if (!keys.has(kid) && now() - fetchedAt > 60_000) await load().catch(() => undefined);
      return keys.get(kid) ?? null;
    },
  };
}

const b64json = (s: string): unknown => {
  try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return null; }
};

export async function verifyPubSubToken(token: string, expect: { audience: string; serviceAccount: string }, keys: KeySource, nowMs: number = Date.now()): Promise<TokenVerdict> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed" };
  const h = header.safeParse(b64json(parts[0]!));
  const c = claims.safeParse(b64json(parts[1]!));
  if (!h.success || !c.success) return { ok: false, reason: "malformed" };

  const jwk = await keys.find(h.data.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  // Claims are only trusted after the signature checks out.
  if (c.data.exp * 1000 < nowMs - 30_000) return { ok: false, reason: "expired" };
  if (c.data.aud !== expect.audience) return { ok: false, reason: "wrong_audience" };
  if (c.data.email !== expect.serviceAccount || c.data.email_verified === false) return { ok: false, reason: "wrong_sender" };
  return { ok: true };
}
