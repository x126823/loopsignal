import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { listAllOrganizationIds, withTenant } from "@/lib/db";
import { anchorIsAuthentic, auditHead, checkAnchor, makeAnchor, parseAnchorLine, type Anchor, type AnchorCheck } from "@/modules/audit";

/**
 * Working with audit anchors (see modules/audit/anchor.ts for what an anchor is and why it exists): taking them, storing them, and checking
 * the live chains against the ones saved earlier. The daily job does this when AUDIT_ANCHOR_KEY is set; the ops commands do the same by hand.
 */
const MAX_ANCHORS_PER_ORGANIZATION = 1_000;

/** Read an anchor file (one JSON object per line). Lines that are not anchors are counted, not trusted. */
export function readAnchorFile(path: string): { anchors: Anchor[]; malformed: number } {
  if (!existsSync(path)) return { anchors: [], malformed: 0 };
  const anchors: Anchor[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const a = parseAnchorLine(line);
    if (a) anchors.push(a);
    else malformed++;
  }
  return { anchors, malformed };
}

export function appendAnchors(path: string, anchors: Anchor[]): void {
  if (anchors.length) appendFileSync(path, `${anchors.map((a) => JSON.stringify(a)).join("\n")}\n`, { mode: 0o600 });
}

/** A fresh anchor for each organization that has an audit log. `only` limits it to those organizations. */
export async function currentAnchors(key: string, opts: { only?: string[]; now?: () => Date } = {}): Promise<Anchor[]> {
  const out: Anchor[] = [];
  for (const organizationId of (await listAllOrganizationIds()).filter((id) => !opts.only || opts.only.includes(id))) {
    const head = await withTenant({ organizationId }, (tx) => auditHead(tx));
    if (head) out.push(makeAnchor(key, organizationId, head, (opts.now ?? (() => new Date()))()));
  }
  return out;
}

export interface AnchorFailure { organizationId: string; seq: string; check: Exclude<AnchorCheck, "OK"> }
export interface AnchorVerification { checked: number; invalid: number; failures: AnchorFailure[] }

/**
 * Check the live chains against saved anchors. An anchor whose signature does not verify is `invalid` (forged, edited or signed with
 * another key) and proves nothing either way. Every authentic anchor must still be found, unchanged, in its organization's chain.
 */
export async function verifyAnchors(key: string, anchors: Anchor[]): Promise<AnchorVerification> {
  const out: AnchorVerification = { checked: 0, invalid: 0, failures: [] };
  const byOrg = new Map<string, Anchor[]>();
  for (const a of anchors) {
    if (!anchorIsAuthentic(key, a)) { out.invalid++; continue; }
    byOrg.set(a.organizationId, [...(byOrg.get(a.organizationId) ?? []), a].slice(-MAX_ANCHORS_PER_ORGANIZATION));
  }
  for (const [organizationId, list] of byOrg) {
    await withTenant({ organizationId }, async (tx) => {
      for (const a of list) {
        out.checked++;
        const result = await checkAnchor(tx, a);
        if (result !== "OK") out.failures.push({ organizationId, seq: a.seq, check: result });
      }
    }, { timeoutMs: 60_000 });
  }
  return out;
}
