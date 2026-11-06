import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantTx } from "@/lib/db";
import { auditHashAt, auditHead } from "./audit";

/**
 * Audit anchors. The hash chain proves rows were not altered or removed from the MIDDLE, but deleting the newest rows leaves a shorter
 * chain that still verifies. An anchor is a signed snapshot of an organization's audit head (its sequence number and hash) that is
 * stored somewhere the database owner cannot reach. Later, the live chain must still contain that exact row. If the newest rows were
 * deleted, the head is behind the anchor; if anything before it was changed, the hash at that sequence differs.
 *
 * The signature (HMAC with a key kept apart from the database) stops anchors being forged or edited. An anchor holds ids and a hash,
 * never content.
 */
export interface Anchor { organizationId: string; seq: string; hash: string; at: string; mac: string }

const payload = (a: Omit<Anchor, "mac">) => `loopsignal-audit-anchor|${a.organizationId}|${a.seq}|${a.hash}|${a.at}`;
const sign = (key: string, a: Omit<Anchor, "mac">) => createHmac("sha256", key).update(payload(a)).digest("hex");

export function makeAnchor(key: string, organizationId: string, head: { seq: bigint; hash: string }, at: Date): Anchor {
  const base = { organizationId, seq: head.seq.toString(), hash: head.hash, at: at.toISOString() };
  return { ...base, mac: sign(key, base) };
}

export function anchorIsAuthentic(key: string, a: Anchor): boolean {
  if (typeof a.mac !== "string" || !/^[0-9a-f]{64}$/.test(a.mac)) return false;
  const expected = Buffer.from(sign(key, a), "hex");
  const given = Buffer.from(a.mac, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parse one line of an anchor file. Null if it is not a well-formed anchor (the MAC is checked separately). */
export function parseAnchorLine(line: string): Anchor | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const ok = typeof v["organizationId"] === "string" && /^[0-9a-f-]{36}$/.test(v["organizationId"]) && typeof v["seq"] === "string" && /^\d{1,18}$/.test(v["seq"])
      && typeof v["hash"] === "string" && /^[0-9a-f]{64}$/.test(v["hash"]) && typeof v["at"] === "string" && !Number.isNaN(Date.parse(v["at"])) && typeof v["mac"] === "string";
    return ok ? (v as unknown as Anchor) : null;
  } catch {
    return null;
  }
}

export type AnchorCheck = "OK" | "HEAD_BEHIND" | "MISSING" | "HASH_MISMATCH";

/** Does the live chain (in the transaction's organization) still contain the anchored row? The caller has already authenticated the anchor. */
export async function checkAnchor(tx: TenantTx, a: Anchor): Promise<AnchorCheck> {
  const seq = BigInt(a.seq);
  const head = await auditHead(tx);
  if (!head || head.seq < seq) return "HEAD_BEHIND"; // the newest rows are gone
  const hash = await auditHashAt(tx, seq);
  if (hash === null) return "MISSING";
  return hash === a.hash ? "OK" : "HASH_MISMATCH";
}
