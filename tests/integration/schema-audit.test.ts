import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant } from "@/lib/db";
import { recordAudit, verifyAuditChain } from "@/modules/audit";
import { createOrgFixture, purgeOrgs, type OrgFixture } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const raw = createPrismaClient(process.env["APP_DATABASE_URL"]!);
let a: OrgFixture;
let b: OrgFixture;

const APPEND_ONLY = ["RawEvent", "LifecycleEvent", "AuditLog"];

beforeAll(async () => {
  a = await createOrgFixture(owner);
  b = await createOrgFixture(owner);
});

afterAll(async () => {
  await purgeOrgs(owner, [a.organizationId, b.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
  await owner.$disconnect();
  await raw.$disconnect();
});

describe("catalog: every tenant table is protected", () => {
  it("has RLS enabled and forced, with select and insert policies, on every table with organizationId", async () => {
    const rows = await owner.$queryRaw<Array<{ t: string; rls: boolean; forced: boolean; cmds: string[] }>>`
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             coalesce((SELECT array_agg(p.cmd) FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public'), '{}') AS cmds
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns k
                    WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organizationId')`;
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const r of rows) {
      expect({ table: r.t, rls: r.rls, forced: r.forced }).toEqual({ table: r.t, rls: true, forced: true });
      expect(r.cmds, r.t).toEqual(expect.arrayContaining(["SELECT", "INSERT"]));
      if (APPEND_ONLY.includes(r.t)) expect(r.cmds, r.t).not.toEqual(expect.arrayContaining(["UPDATE"]));
    }
  });

  it("gives the app role no UPDATE or DELETE on append-only tables", async () => {
    for (const t of APPEND_ONLY) {
      const [p] = await raw.$queryRawUnsafe<Array<{ u: boolean; d: boolean; tr: boolean }>>(
        `SELECT has_table_privilege(current_user, '"${t}"', 'UPDATE') u, has_table_privilege(current_user, '"${t}"', 'DELETE') d,
                has_table_privilege(current_user, '"${t}"', 'TRUNCATE') tr`);
      expect(p, t).toEqual({ u: false, d: false, tr: false });
    }
  });
});

describe("append-only tables reject UPDATE, DELETE and TRUNCATE", () => {
  let eventId = "";
  let rawEventId = "";
  let auditId = "";

  beforeAll(async () => {
    eventId = (await owner.lifecycleEvent.create({
      data: { organizationId: a.organizationId, itemId: a.itemId, toState: "RECEIVED", actorType: "SYSTEM" },
    })).id;
    rawEventId = (await owner.rawEvent.create({
      data: { organizationId: a.organizationId, provider: "SYNTHETIC", externalId: randomUUID(), payload: Buffer.from("x"), payloadHash: "h" },
    })).id;
    auditId = (await owner.auditLog.create({
      data: { organizationId: a.organizationId, actorType: "SYSTEM", action: "test.fixture", entityType: "Test" },
    })).id;
  });

  const cases: Array<[string, () => string]> = [
    ["LifecycleEvent", () => eventId],
    ["RawEvent", () => rawEventId],
    ["AuditLog", () => auditId],
  ];

  for (const [table, id] of cases) {
    it(`${table}: the owner cannot UPDATE, DELETE or TRUNCATE`, async () => {
      await expect(owner.$executeRawUnsafe(`UPDATE "${table}" SET "organizationId" = "organizationId" WHERE id = '${id()}'`)).rejects.toThrow(/append-only/);
      await expect(owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = '${id()}'`)).rejects.toThrow(/append-only/);
      // RawEvent is referenced by Message, so Postgres may refuse TRUNCATE on the FK before the trigger runs.
      // Either way it is rejected. (CASCADE is deliberately not used: a regression would wipe referencing tables.)
      await expect(owner.$executeRawUnsafe(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only|referenced in a foreign key/);
    });

    it(`${table}: the app role is refused too`, async () => {
      await expect(raw.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = '${id()}'`)).rejects.toThrow();
      await expect(raw.$executeRawUnsafe(`UPDATE "${table}" SET "organizationId" = "organizationId"`)).rejects.toThrow();
    });
  }

  it("the Prisma extension refuses mutations with a clear error before they reach the database", async () => {
    await expect(withTenant({ organizationId: a.organizationId }, (tx) =>
      tx.lifecycleEvent.update({ where: { id: eventId }, data: { reason: "edit" } }))).rejects.toThrow(/append-only/);
    await expect(withTenant({ organizationId: a.organizationId }, (tx) =>
      tx.auditLog.deleteMany({}))).rejects.toThrow(/append-only/);
  });

  it("the row is unchanged after all attempts", async () => {
    expect((await owner.lifecycleEvent.findUniqueOrThrow({ where: { id: eventId } })).reason).toBeNull();
  });
});

describe("audit hash chain", () => {
  it("assigns contiguous seq, links prevHash, and verifies", async () => {
    const org = a.organizationId;
    await withTenant({ organizationId: org }, async (tx) => {
      for (const action of ["chain.one", "chain.two", "chain.three"]) {
        await recordAudit(tx, { organizationId: org, actorType: "SYSTEM", action, entityType: "Test", metadata: { n: action } });
      }
    });
    const rows = await owner.auditLog.findMany({ where: { organizationId: org }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(rows[0]!.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
    expect(await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).toEqual({ intact: true });
  });

  it("ignores caller-supplied seq, prevHash and hash", async () => {
    const row = await owner.auditLog.create({
      data: { organizationId: b.organizationId, seq: 99n, prevHash: "forged", hash: "forged", actorType: "SYSTEM", action: "x", entityType: "T" },
    });
    expect(row.seq).toBe(1n);
    expect(row.prevHash).toBeNull();
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes concurrent appends: no duplicate or skipped seq, chain intact", async () => {
    const org = b.organizationId;
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      withTenant({ organizationId: org }, (tx) =>
        recordAudit(tx, { organizationId: org, actorType: "SYSTEM", action: `concurrent.${i}`, entityType: "Test" }))));
    const seqs = (await owner.auditLog.findMany({ where: { organizationId: org }, orderBy: { seq: "asc" } })).map((r) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).toEqual({ intact: true });
  });

  it("detects tampering and deletion (break-glass edits made as superuser)", async () => {
    const org = a.organizationId;
    const rows = await owner.auditLog.findMany({ where: { organizationId: org }, orderBy: { seq: "asc" } });
    const target = rows[1]!;
    const tamper = (sql: string) => owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe(sql);
    });
    // Edit a row's metadata in place.
    await tamper(`UPDATE "AuditLog" SET metadata = '{"forged":true}' WHERE id = '${target.id}'`);
    expect((await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).firstBadSeq).toBe(Number(target.seq));
    // Restore it, then delete it to create a gap.
    await tamper(`UPDATE "AuditLog" SET metadata = '${JSON.stringify(target.metadata)}'::jsonb WHERE id = '${target.id}'`);
    expect(await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).toEqual({ intact: true });
    await tamper(`DELETE FROM "AuditLog" WHERE id = '${target.id}'`);
    expect((await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).intact).toBe(false);
  });

  it("refuses to verify another organization's chain", async () => {
    await expect(withTenant({ organizationId: a.organizationId }, (tx) => verifyAuditChain(tx, b.organizationId))).rejects.toThrow();
  });

  it("is invisible across tenants", async () => {
    const seen = await withTenant({ organizationId: a.organizationId }, (tx) => tx.auditLog.findMany());
    expect(seen.every((r) => r.organizationId === a.organizationId)).toBe(true);
  });

  it("rolls the change back when its audit entry fails (same transaction)", async () => {
    const name = `ghost-${randomUUID()}`;
    await expect(withTenant({ organizationId: a.organizationId }, async (tx) => {
      await tx.team.create({ data: { organizationId: a.organizationId, name } });
      await recordAudit(tx, { organizationId: a.organizationId, actorType: "SYSTEM", action: "x", entityType: "Team", metadata: { body: "leak" } });
    })).rejects.toThrow(/not allowed/);
    expect(await owner.team.count({ where: { organizationId: a.organizationId, name } })).toBe(0);
  });

  it("rejects metadata that could carry content or secrets", async () => {
    for (const metadata of [{ body: "x" }, { nested: { accessToken: "x" } }, { list: [{ password: "x" }] }, { subject: "x" }]) {
      await expect(withTenant({ organizationId: a.organizationId }, (tx) =>
        recordAudit(tx, { organizationId: a.organizationId, actorType: "SYSTEM", action: "x", entityType: "T", metadata }))).rejects.toThrow(/not allowed/);
    }
  });
});

describe("integrity constraints", () => {
  it("allows one open item per thread and frees the thread once CLOSED", async () => {
    const dup = () => owner.trackedItem.create({
      data: { organizationId: a.organizationId, teamId: a.teamId, originMessageId: a.messageId, threadId: a.threadId, title: "dup" },
    });
    await expect(dup()).rejects.toThrow();
    await owner.$executeRawUnsafe(`UPDATE "TrackedItem" SET state = 'CLOSED' WHERE id = '${a.itemId}'`);
    const second = await dup();
    expect(second.id).not.toBe(a.itemId);
    await expect(dup()).rejects.toThrow();
  });

  it("dedups messages on (organization, provider, externalMessageId)", async () => {
    const m = await owner.message.findUniqueOrThrow({ where: { id: a.messageId } });
    await expect(owner.message.create({
      data: { organizationId: a.organizationId, monitoredSourceId: a.sourceId, threadId: a.threadId, provider: m.provider,
              externalMessageId: m.externalMessageId, sentAt: new Date(), bodyText: Buffer.from("x"), bodyHash: "h", direction: "INBOUND" },
    })).rejects.toThrow();
  });

  it("rejects cross-tenant references (required and optional FKs)", async () => {
    await expect(owner.trackedItem.create({
      data: { organizationId: a.organizationId, teamId: b.teamId, originMessageId: a.messageId, threadId: randomUUID(), title: "x" },
    })).rejects.toThrow();
    await expect(owner.monitoredSource.create({
      data: { organizationId: a.organizationId, connectionId: a.connectionId, kind: "LABEL", externalId: "x", teamId: b.teamId },
    })).rejects.toThrow();
    await expect(owner.itemMessageLink.create({
      data: { organizationId: a.organizationId, itemId: a.itemId, messageId: b.messageId, role: "OTHER" },
    })).rejects.toThrow();
  });

  it("enforces value ranges", async () => {
    const run = (confidence: number) => owner.analysisRun.create({
      data: { organizationId: a.organizationId, analyzer: "t", provider: "fake", model: "m", promptVersion: "1",
              inputHash: randomUUID(), output: {}, evidence: [], status: "OK", confidence },
    });
    await expect(run(1.5)).rejects.toThrow();
    await expect(run(0.9)).resolves.toBeTruthy();
    await expect(owner.lifecycleEvent.create({
      data: { organizationId: a.organizationId, itemId: a.itemId, cycle: 0, toState: "RECEIVED", actorType: "SYSTEM" },
    })).rejects.toThrow();
  });

  it("scopes the AnalysisRun cache key by organization", async () => {
    const key = { analyzer: "cache-test", inputHash: "same", promptVersion: "1" };
    const base = { provider: "fake", model: "m", output: {}, evidence: [], status: "OK" as const };
    await owner.analysisRun.create({ data: { organizationId: a.organizationId, ...key, ...base } });
    await owner.analysisRun.create({ data: { organizationId: b.organizationId, ...key, ...base } });
    await expect(owner.analysisRun.create({ data: { organizationId: a.organizationId, ...key, ...base } })).rejects.toThrow();
  });

  it("stores bodies encrypted, never as plaintext", async () => {
    const m = await owner.message.findUniqueOrThrow({ where: { id: a.messageId } });
    expect(Buffer.from(m.bodyText).includes(Buffer.from("synthetic problem"))).toBe(false);
  });
});

describe("tenant isolation on the new tables", () => {
  it("hides another organization's rows through withTenant", async () => {
    const as = (organizationId: string) => ({ organizationId });
    expect((await withTenant(as(b.organizationId), (tx) => tx.message.findMany())).map((m) => m.id)).not.toContain(a.messageId);
    expect(await withTenant(as(b.organizationId), (tx) => tx.trackedItem.findUnique({ where: { id: a.itemId } }))).toBeNull();
    expect(await withTenant(as(b.organizationId), (tx) => tx.thread.count({ where: { id: a.threadId } }))).toBe(0);
  });

  it("hides them from the raw app role under the wrong org setting, and with none", async () => {
    const withOrg = (org: string) => raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
      return tx.trackedItem.findMany();
    });
    expect((await withOrg(b.organizationId)).some((i) => i.organizationId === a.organizationId)).toBe(false);
    expect(await raw.trackedItem.findMany()).toEqual([]);
  });

  it("rejects writes naming another organization (extension, and RLS alone)", async () => {
    await expect(withTenant({ organizationId: b.organizationId }, (tx) =>
      tx.thread.create({ data: { organizationId: a.organizationId, provider: "SYNTHETIC", externalThreadId: "x" } }))).rejects.toThrow(/Cross-tenant/);
    await expect(raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${b.organizationId}, true)`;
      return tx.thread.create({ data: { organizationId: a.organizationId, provider: "SYNTHETIC", externalThreadId: "y" } });
    })).rejects.toThrow();
  });
});
