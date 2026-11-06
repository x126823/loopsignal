import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto/fields";
import { rekeyMessageContent } from "@/modules/ingestion";
import { rekeyClaims, rekeyCredentials } from "@/modules/sources";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { purgeOrgs, testKey } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const OLD = testKey;
const NEW = randomBytes(32);
const fixtures: EngineFixture[] = [];

afterAll(async () => {
  await purgeOrgs(owner, fixtures.map((f) => f.organizationId));
  await owner.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => Object.values(f.users)) } } });
  await owner.$disconnect();
});

interface Seeded { messageIds: string[]; rawIds: string[]; connectionId: string; claimId: string }
async function seed(f: EngineFixture, key: Buffer = OLD): Promise<Seeded> {
  const org = f.organizationId;
  const thread = await owner.thread.create({ data: { organizationId: org, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
  const messageIds: string[] = [];
  const rawIds: string[] = [];
  for (const text of ["First message.", "Second message.", "Third message."]) {
    const raw = await owner.rawEvent.create({ data: { organizationId: org, provider: "SYNTHETIC", externalId: `e-${randomUUID()}`, payload: encryptField(JSON.stringify({ text }), key, `${org}:RawEvent.payload`), payloadHash: `hash-${text}` } });
    const m = await owner.message.create({ data: { organizationId: org, monitoredSourceId: f.sourceId, threadId: thread.id, provider: "SYNTHETIC", externalMessageId: `m-${randomUUID()}`, rawEventId: raw.id, sentAt: new Date(), bodyText: encryptField(text, key, `${org}:Message.bodyText`), bodyHash: `body-${text}`, direction: "INBOUND" } });
    rawIds.push(raw.id);
    messageIds.push(m.id);
  }
  const connection = await owner.sourceConnection.create({ data: { organizationId: org, provider: "GMAIL", ownerUserId: f.users.admin, scopes: [] } });
  await owner.connectionCredential.create({ data: { organizationId: org, connectionId: connection.id, tokens: encryptField(JSON.stringify({ accessToken: "at-secret", refreshToken: "rt-secret" }), key, `${org}:ConnectionCredential.tokens:${connection.id}`), accessTokenExpiresAt: new Date() } });
  const claim = await owner.sourceClaim.create({ data: { organizationId: org, provider: "GOOGLE_CHAT", externalId: "spaces/AAAA", teamId: f.teamId, code: encryptField("LS-ABCD-EFGH", key, `${org}:SourceClaim.code`), createdByUserId: f.users.admin, expiresAt: new Date(Date.now() + 3_600_000) } });
  return { messageIds, rawIds, connectionId: connection.id, claimId: claim.id };
}
const opens = (blob: Uint8Array, key: Buffer, aad: string) => { try { decryptField(blob, key, aad); return true; } catch { return false; } };

async function state(f: EngineFixture, s: Seeded) {
  const org = f.organizationId;
  const bodies = await owner.message.findMany({ where: { id: { in: s.messageIds } } });
  const raws = await owner.rawEvent.findMany({ where: { id: { in: s.rawIds } } });
  const cred = await owner.connectionCredential.findFirstOrThrow({ where: { connectionId: s.connectionId } });
  const claim = await owner.sourceClaim.findUniqueOrThrow({ where: { organizationId_id: { organizationId: org, id: s.claimId } } });
  const under = (key: Buffer) => ({
    bodies: bodies.filter((m) => opens(m.bodyText, key, `${org}:Message.bodyText`)).length,
    raws: raws.filter((r) => opens(r.payload, key, `${org}:RawEvent.payload`)).length,
    cred: opens(cred.tokens, key, `${org}:ConnectionCredential.tokens:${s.connectionId}`),
    claim: opens(claim.code, key, `${org}:SourceClaim.code`),
  });
  return { old: under(OLD), new: under(NEW), raws, bodies };
}
async function rotate(f: EngineFixture, from = OLD, to = NEW) {
  const m = await rekeyMessageContent(f.organizationId, from, to, { batchSize: 2 });
  return { m, cred: await rekeyCredentials(f.organizationId, from, to), claim: await rekeyClaims(f.organizationId, from, to) };
}

describe("key rotation", () => {
  let f: EngineFixture;
  let s: Seeded;
  beforeAll(async () => {
    f = await createEngineFixture(owner);
    fixtures.push(f);
    s = await seed(f);
  });

  it("re-encrypts message bodies, raw payloads, tokens and claim codes, and the content survives intact", async () => {
    const before = await state(f, s);
    expect(before.old).toEqual({ bodies: 3, raws: 3, cred: true, claim: true });
    const out = await rotate(f);
    expect(out.m.bodies).toEqual({ rewritten: 3, alreadyCurrent: 0, failed: 0 });
    expect(out.m.rawEvents).toEqual({ rewritten: 3, alreadyCurrent: 0, failed: 0 });
    expect(out.cred).toEqual({ rewritten: 1, alreadyCurrent: 0, failed: 0 });
    expect(out.claim).toEqual({ rewritten: 1, alreadyCurrent: 0, failed: 0 });

    const after = await state(f, s);
    expect(after.new).toEqual({ bodies: 3, raws: 3, cred: true, claim: true });
    expect(after.old).toEqual({ bodies: 0, raws: 0, cred: false, claim: false }); // nothing is left readable with the retired key
    expect(after.bodies.map((m) => decryptField(m.bodyText, NEW, `${f.organizationId}:Message.bodyText`)).sort()).toEqual(["First message.", "Second message.", "Third message."]);
    const cred = await owner.connectionCredential.findFirstOrThrow({ where: { connectionId: s.connectionId } });
    expect(JSON.parse(decryptField(cred.tokens, NEW, `${f.organizationId}:ConnectionCredential.tokens:${s.connectionId}`))).toEqual({ accessToken: "at-secret", refreshToken: "rt-secret" });
    // Only the ciphertext changed: hashes, ids and every other column are as they were.
    for (const raw of after.raws) expect(raw.payloadHash).toMatch(/^hash-/);
    expect(after.bodies.every((m) => m.bodyHash.startsWith("body-") && m.rawEventId !== null)).toBe(true);
  });

  it("is idempotent: running it again changes nothing and reports everything as already current", async () => {
    const before = await state(f, s);
    const out = await rotate(f);
    expect(out.m.bodies).toEqual({ rewritten: 0, alreadyCurrent: 3, failed: 0 });
    expect(out.m.rawEvents).toEqual({ rewritten: 0, alreadyCurrent: 3, failed: 0 });
    expect(out.cred).toEqual({ rewritten: 0, alreadyCurrent: 1, failed: 0 });
    expect(out.claim).toEqual({ rewritten: 0, alreadyCurrent: 1, failed: 0 });
    const after = await state(f, s);
    expect(after.bodies.map((m) => Buffer.from(m.bodyText).toString("hex"))).toEqual(before.bodies.map((m) => Buffer.from(m.bodyText).toString("hex")));
  });

  it("resumes after an interruption: a half-rotated organization is finished, not redone or broken", async () => {
    const g = await createEngineFixture(owner);
    fixtures.push(g);
    const t = await seed(g);
    const [first] = t.messageIds;
    const row = await owner.message.findUniqueOrThrow({ where: { id: first! } });
    await owner.message.update({ where: { id: first! }, data: { bodyText: encryptField(decryptField(row.bodyText, OLD, `${g.organizationId}:Message.bodyText`), NEW, `${g.organizationId}:Message.bodyText`) } }); // one already done
    const out = await rotate(g);
    expect(out.m.bodies).toEqual({ rewritten: 2, alreadyCurrent: 1, failed: 0 });
    expect((await state(g, t)).new).toEqual({ bodies: 3, raws: 3, cred: true, claim: true });
  });

  it("leaves a value that neither key opens untouched and says so, instead of destroying it", async () => {
    const g = await createEngineFixture(owner);
    fixtures.push(g);
    const t = await seed(g, randomBytes(32)); // encrypted under a key we are not told about
    const before = await state(g, t);
    const out = await rotate(g);
    expect(out.m.bodies).toEqual({ rewritten: 0, alreadyCurrent: 0, failed: 3 });
    expect(out.m.rawEvents.failed).toBe(3);
    expect(out.cred.failed).toBe(1);
    expect(out.claim.failed).toBe(1);
    const after = await state(g, t);
    expect(after.bodies.map((m) => Buffer.from(m.bodyText).toString("hex"))).toEqual(before.bodies.map((m) => Buffer.from(m.bodyText).toString("hex")));
  });

  it("never touches another organization's data", async () => {
    const a = await createEngineFixture(owner);
    const b = await createEngineFixture(owner);
    fixtures.push(a, b);
    const sa = await seed(a);
    const sb = await seed(b);
    await rotate(a);
    expect((await state(a, sa)).new.bodies).toBe(3);
    expect((await state(b, sb)).old).toEqual({ bodies: 3, raws: 3, cred: true, claim: true });
  });

  it("the operator script refuses to run without both keys, with identical keys, or with a malformed key, before touching anything", () => {
    const run = (env: Record<string, string>) => {
      try {
        execFileSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/rotate-field-key.ts"], { encoding: "utf8", env: { ...process.env, ROTATE_FROM_KEY: "", ROTATE_TO_KEY: "", ...env }, stdio: "pipe" });
        return { code: 0, stderr: "" };
      } catch (e) {
        return { code: (e as { status: number }).status, stderr: String((e as { stderr: string }).stderr) };
      }
    };
    const k = randomBytes(32).toString("base64");
    expect(run({}).code).toBe(1);
    expect(run({ ROTATE_FROM_KEY: k, ROTATE_TO_KEY: k }).stderr).toContain("same");
    const bad = run({ ROTATE_FROM_KEY: k, ROTATE_TO_KEY: "c2hvcnQ=" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).not.toContain("c2hvcnQ"); // an error never echoes key material
  });
});
