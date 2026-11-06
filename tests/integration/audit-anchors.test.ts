import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The anchor settings are read lazily from the environment: set them before anything runs.
const KEY = randomBytes(24).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "loopsignal-anchors-"));
const FILE = join(dir, "anchors.jsonl");
Object.assign(process.env, { AUDIT_ANCHOR_KEY: KEY, AUDIT_ANCHOR_FILE: FILE });

const { createPrismaClient, withTenant } = await import("@/lib/db");
const { checkAnchor, makeAnchor, verifyAuditChain, auditHead } = await import("@/modules/audit");
const { currentAnchors, readAnchorFile, setRetention, verifyAllAuditChains, verifyAnchors } = await import("@/modules/retention");
const { createEngineFixture } = await import("../helpers/engine-fixture");
const { purgeOrgs } = await import("../helpers/fixtures");

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const fixtures: Array<Awaited<ReturnType<typeof createEngineFixture>>> = [];
const logged: string[] = [];

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterAll(async () => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  await purgeOrgs(owner, fixtures.map((f) => f.organizationId));
  await owner.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => Object.values(f.users)) } } });
  await owner.$disconnect();
});

/** An organization with several audit rows. */
async function org(rows = 4) {
  const f = await createEngineFixture(owner);
  fixtures.push(f);
  for (let i = 0; i < rows; i++) await setRetention(f.principals.admin, { rawEventDays: 10 + i, messageDays: 100 + i });
  return f;
}
const head = (organizationId: string) => withTenant({ organizationId }, (tx) => auditHead(tx));
const anchorOf = async (organizationId: string) => makeAnchor(KEY, organizationId, (await head(organizationId))!, new Date());
const check = (organizationId: string, a: Awaited<ReturnType<typeof anchorOf>>) => withTenant({ organizationId }, (tx) => checkAnchor(tx, a));
const chain = (organizationId: string) => withTenant({ organizationId }, (tx) => verifyAuditChain(tx, organizationId));
/** Break-glass changes, as someone with superuser access could make them. */
const breakGlass = (sql: string, params: unknown[]) => owner.$transaction(async (tx) => {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
  await tx.$executeRawUnsafe(sql, ...params);
});

describe("an anchor against the live chain", () => {
  it("still holds while the chain grows, which is how it is meant to be used", async () => {
    const f = await org();
    const a = await anchorOf(f.organizationId);
    await setRetention(f.principals.admin, { rawEventDays: 40, messageDays: 140 });
    expect(await check(f.organizationId, a)).toBe("OK");
  });

  it("reveals deleted NEWEST rows, which the hash chain alone cannot", async () => {
    const f = await org();
    const a = await anchorOf(f.organizationId);
    await breakGlass(`DELETE FROM "AuditLog" WHERE "organizationId" = $1::uuid AND seq >= $2::bigint`, [f.organizationId, a.seq]);
    expect(await chain(f.organizationId)).toEqual({ intact: true }); // the shorter chain still verifies: this is the gap
    expect(await check(f.organizationId, a)).toBe("HEAD_BEHIND"); // the anchor is what notices
  });

  it("reveals an altered row, and a removed one", async () => {
    const f = await org();
    const a = await anchorOf(f.organizationId);
    await breakGlass(`UPDATE "AuditLog" SET action = 'edited.later' WHERE "organizationId" = $1::uuid AND seq = $2::bigint`, [f.organizationId, a.seq]);
    expect(await check(f.organizationId, a)).toBe("OK"); // the hash column was not recomputed, so the anchored hash is still there...
    const g = await org();
    const b = await anchorOf(g.organizationId);
    await breakGlass(`UPDATE "AuditLog" SET hash = $3 WHERE "organizationId" = $1::uuid AND seq = $2::bigint`, [g.organizationId, b.seq, "f".repeat(64)]);
    expect(await check(g.organizationId, b)).toBe("HASH_MISMATCH"); // ...but a recomputed hash is a different row
    const h = await org(5);
    const c = { ...(await anchorOf(h.organizationId)), seq: "2" };
    await breakGlass(`DELETE FROM "AuditLog" WHERE "organizationId" = $1::uuid AND seq = 2`, [h.organizationId]);
    expect(await check(h.organizationId, makeAnchor(KEY, h.organizationId, { seq: 2n, hash: c.hash }, new Date()))).toBe("MISSING");
  });
});

describe("verifying saved anchors", () => {
  it("accepts good anchors, ignores forged ones without treating them as proof, and keeps organizations apart", async () => {
    const a = await org();
    const b = await org();
    const good = [await anchorOf(a.organizationId), await anchorOf(b.organizationId)];
    const forged = { ...good[0]!, seq: "1", mac: "0".repeat(64) };
    const wrongKey = makeAnchor("x".repeat(40), a.organizationId, (await head(a.organizationId))!, new Date());
    const other = await verifyAnchors(KEY, [...good, forged, wrongKey]);
    expect(other).toEqual({ checked: 2, invalid: 2, failures: [] });
    // A real anchor presented under another organization's id does not match that organization's chain.
    const swapped = makeAnchor(KEY, b.organizationId, (await head(a.organizationId))!, new Date());
    const res = await verifyAnchors(KEY, [swapped]);
    expect(res.failures.map((x) => x.check)).toEqual(expect.arrayContaining([expect.stringMatching(/HEAD_BEHIND|HASH_MISMATCH|MISSING/)]));
  });
});

describe("the daily check with anchors on", () => {
  it("anchors a healthy chain every time (logged and saved), and checks every earlier anchor", async () => {
    const f = await org();
    const before = readAnchorFile(FILE).anchors.filter((a) => a.organizationId === f.organizationId).length;
    expect(await verifyAllAuditChains({ only: [f.organizationId] })).toMatchObject({ organizations: 1, intact: 1, broken: 0, anchorMismatches: 0 });
    expect(await verifyAllAuditChains({ only: [f.organizationId] })).toMatchObject({ intact: 1, anchorMismatches: 0 });
    const mine = readAnchorFile(FILE).anchors.filter((a) => a.organizationId === f.organizationId);
    expect(mine.length - before).toBe(2);
    expect(mine.every((a) => /^[0-9a-f]{64}$/.test(a.mac) && /^\d+$/.test(a.seq))).toBe(true);
    expect(BigInt(mine.at(-1)!.seq)).toBeGreaterThan(BigInt(mine.at(-2)!.seq)); // the head moved on (each check is itself recorded)
    expect(logged.some((l) => l.includes('"audit.anchor"') && l.includes(f.organizationId))).toBe(true);
    expect(readFileSync(FILE, "utf8")).not.toMatch(/retention|settings|Confidential/); // ids and hashes only
  });

  it("notices deleted newest rows even though the chain itself still verifies, records it, alerts, and refuses to anchor the damage", async () => {
    const f = await org();
    await verifyAllAuditChains({ only: [f.organizationId] }); // anchors the healthy chain
    const anchored = readAnchorFile(FILE).anchors.filter((a) => a.organizationId === f.organizationId).at(-1)!;
    await breakGlass(`DELETE FROM "AuditLog" WHERE "organizationId" = $1::uuid AND seq >= $2::bigint`, [f.organizationId, anchored.seq]);
    expect(await chain(f.organizationId)).toEqual({ intact: true });
    const lines = readFileSync(FILE, "utf8").split("\n").length;
    const out = await verifyAllAuditChains({ only: [f.organizationId] });
    expect(out).toMatchObject({ organizations: 1, anchorMismatches: 1, broken: 0, intact: 0 });
    const entry = await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "audit.chain_verified" }, orderBy: { seq: "desc" } });
    expect(entry.metadata).toEqual({ intact: false, anchorMismatches: 1 });
    expect(logged.some((l) => l.includes("audit.anchor_mismatch") && l.includes('"level":"error"') && l.includes(f.organizationId))).toBe(true);
    expect(logged.some((l) => l.includes("alert.raised") && l.includes("audit.anchor_mismatch") && l.includes(f.organizationId))).toBe(true);
    expect(readFileSync(FILE, "utf8").split("\n").length).toBe(lines); // nothing new was anchored for the damaged chain
  });

  it("ignores an anchor an attacker wrote into the file (it does not verify), but says so", async () => {
    const f = await org();
    const forged = { ...(await anchorOf(f.organizationId)), mac: "1".repeat(64), seq: "999999" };
    writeFileSync(FILE, `${readFileSync(FILE, "utf8")}${JSON.stringify(forged)}\nthis line is not an anchor\n`);
    expect(await verifyAllAuditChains({ only: [f.organizationId] })).toMatchObject({ intact: 1, anchorMismatches: 0 });
    expect(logged.some((l) => l.includes("audit.anchor_invalid") && l.includes(f.organizationId))).toBe(true);
    expect(logged.some((l) => l.includes("audit.anchor_file_malformed"))).toBe(true);
  });

  it("the status screen says whether anchors are on", async () => {
    const f = await org();
    const { getRetentionStatus } = await import("@/modules/retention");
    expect((await getRetentionStatus(f.principals.admin)).anchorsConfigured).toBe(true);
  });

  it("emits one anchor per organization that has an audit log", async () => {
    const f = await org();
    const anchors = await currentAnchors(KEY, { only: [f.organizationId] });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ organizationId: f.organizationId });
    expect(existsSync(FILE)).toBe(true);
  });
});

describe("ops:audit-anchors", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/audit-anchors.ts", ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, AUDIT_ANCHOR_KEY: KEY, ...env } }), err: "" };
    } catch (e) {
      return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
    }
  };

  it("needs the key and a command, and never prints anything but ids and hashes", () => {
    expect(run(["emit"], { AUDIT_ANCHOR_KEY: "" }).code).toBe(1);
    expect(run(["emit"], { AUDIT_ANCHOR_KEY: "short" }).code).toBe(1);
    expect(run([]).code).toBe(1);
    expect(run(["verify"]).err).toContain("Usage");
    expect(run(["verify", "--file", join(dir, "does-not-exist.jsonl")]).code).toBe(1);
  }, 120_000);

  it("emits anchors that verify, and verification fails (exit 1, naming the organization) once newest rows have been deleted", async () => {
    const f = await org();
    const emitted = run(["emit"]);
    expect(emitted.code).toBe(0);
    const mine = emitted.out.split("\n").filter((l) => l.includes(f.organizationId));
    expect(mine).toHaveLength(1);
    const saved = join(dir, "emitted.jsonl");
    writeFileSync(saved, `${mine.join("\n")}\n`);
    const ok = run(["verify", "--file", saved]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out.trim().split("\n").at(-1)!)).toMatchObject({ event: "anchors.verified", checked: 1, invalid: 0, mismatches: 0 });

    const seq = JSON.parse(mine[0]!).seq as string;
    await breakGlass(`DELETE FROM "AuditLog" WHERE "organizationId" = $1::uuid AND seq >= $2::bigint`, [f.organizationId, seq]);
    const bad = run(["verify", "--file", saved]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(`organization ${f.organizationId}`);
    expect(bad.err).toContain("HEAD_BEHIND");
    expect(bad.err + bad.out).not.toMatch(/[0-9a-f]{64}/); // not even hashes are echoed back
  }, 120_000);
});
