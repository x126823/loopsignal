import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { decryptField, parseFieldKey } from "../../src/lib/crypto/fields";

/**
 * Backup and restore drill (docs/runbooks/backup-restore.md). A backup nobody has restored is a hope, not a backup, and a restore that
 * "completed" can still be wrong: missing policies, lost grants, a guard trigger that did not come back, a broken audit chain.
 *
 * It dumps the live database (custom format), restores it into a SCRATCH database next to it, and then proves the copy is the real thing:
 * same rows, audit chains intact, row-level security and its policies present, the append-only guards still rejecting changes, the app role
 * confined to its tenant, and stored content still decryptable with the current key. The dump file (it holds data) and the scratch
 * database are always removed. `sabotage` damages the restore on purpose, to prove each check really catches what it claims to.
 */
export type Sabotage = "rls" | "audit" | "guard" | "rows" | "grants";
export interface Check { name: string; ok: boolean; detail: string }
export interface DrillReport { ok: boolean; checks: Check[]; seconds: { dump: number; restore: number; verify: number }; dumpBytes: number; scratch: string }

interface Conn { host: string; port: string; user: string; password: string; database: string }
const parseUrl = (url: string): Conn => {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
};
const hasLocal = (tool: string) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;

/** Run a Postgres client tool with `stdin`/`stdout` as given: locally when installed, otherwise inside the compose database container. */
function pgTool(tool: "pg_dump" | "pg_restore", c: Conn, args: string[], io: { stdin?: number; stdout?: number }): { status: number; stderr: string } {
  const useDocker = process.env["DRILL_DOCKER"] === "1" || !hasLocal(tool);
  const [cmd, argv] = useDocker
    ? ["docker", ["compose", ...(process.env["DRILL_COMPOSE_FILE"] ? ["-f", process.env["DRILL_COMPOSE_FILE"]] : []), "exec", "-T", "-e", `PGPASSWORD=${c.password}`, "postgres", tool, "-U", c.user, ...args]]
    : [tool, ["-h", c.host, "-p", c.port, "-U", c.user, ...args]];
  const r = spawnSync(cmd, argv, { env: { ...process.env, PGPASSWORD: c.password }, stdio: [io.stdin ?? "ignore", io.stdout ?? "ignore", "pipe"], encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? 1, stderr: String(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ") };
}

const q = async <T = Record<string, unknown>>(pool: Pool, text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];

export async function runDrill(opts: { sabotage?: Sabotage } = {}): Promise<DrillReport> {
  const ownerUrl = process.env["DATABASE_URL"]?.replace(/\?schema=\w+$/, "");
  const appUrl = process.env["APP_DATABASE_URL"]?.replace(/\?schema=\w+$/, "");
  const keyB64 = process.env["FIELD_ENCRYPTION_KEY"];
  if (!ownerUrl || !appUrl || !keyB64) throw new Error("DATABASE_URL, APP_DATABASE_URL and FIELD_ENCRYPTION_KEY must be set");
  const owner = parseUrl(ownerUrl);
  const scratch = `drill_${randomBytes(4).toString("hex")}`;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const dir = mkdtempSync(join(tmpdir(), "loopsignal-drill-"));
  const dumpFile = join(dir, "backup.dump");
  const admin = new Pool({ connectionString: ownerUrl, max: 2 });
  let restored: Pool | undefined;
  let appPool: Pool | undefined;
  const seconds = { dump: 0, restore: 0, verify: 0 };
  let dumpBytes = 0;

  try {
    // 1. Back up the live database.
    let t = Date.now();
    const out = openSync(dumpFile, "w");
    const dump = pgTool("pg_dump", owner, ["-Fc", owner.database], { stdout: out });
    closeSync(out);
    seconds.dump = (Date.now() - t) / 1000;
    check("backup completes", dump.status === 0, dump.stderr);
    dumpBytes = statSync(dumpFile).size;
    check("backup is not empty", dumpBytes > 10_000, `${dumpBytes} bytes`);
    if (!checks.every((c) => c.ok)) return { ok: false, checks, seconds, dumpBytes, scratch };

    // 2. Restore it into a scratch database (as a role that can restore ownership: the guards depend on who owns what).
    await admin.query(`CREATE DATABASE "${scratch}"`);
    t = Date.now();
    const input = openSync(dumpFile, "r");
    const restore = pgTool("pg_restore", owner, ["-d", scratch, "--exit-on-error"], { stdin: input });
    closeSync(input);
    seconds.restore = (Date.now() - t) / 1000;
    check("restore completes without errors", restore.status === 0, restore.stderr);
    if (restore.status !== 0) return { ok: false, checks, seconds, dumpBytes, scratch };

    const swapDb = (url: string) => { const u = new URL(url); u.pathname = `/${scratch}`; return u.toString(); };
    restored = new Pool({ connectionString: swapDb(ownerUrl), max: 2 });
    appPool = new Pool({ connectionString: swapDb(appUrl), max: 2 });
    const live = admin;

    // Damage the copy on purpose, when asked, so the checks below have something to catch.
    if (opts.sabotage) await sabotage(restored, opts.sabotage);

    // 3. Prove the restored copy is the real thing.
    t = Date.now();
    const tables = (await q<{ tablename: string }>(live, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.tablename);
    const mismatched: string[] = [];
    for (const table of tables) {
      const a = Number((await q<{ n: string }>(live, `SELECT count(*) n FROM "${table}"`))[0]!.n);
      const b = Number((await q<{ n: string }>(restored, `SELECT count(*) n FROM "${table}"`).catch(() => [{ n: "-1" }]))[0]!.n);
      if (a !== b) mismatched.push(`${table} ${a}->${b}`);
    }
    check("every table has the same number of rows", mismatched.length === 0, mismatched.join(", ") || `${tables.length} tables`);

    const orgs = (await q<{ id: string }>(restored, `SELECT id FROM "Organization"`)).map((r) => r.id);
    const brokenChains: string[] = [];
    for (const org of orgs) {
      const c = await restored.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        const bad = (await c.query(`SELECT audit_verify_chain($1::uuid) AS bad`, [org])).rows[0]?.bad as string | null;
        if (bad !== null) brokenChains.push(`${org.slice(0, 8)} at ${bad}`);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    }
    check("every organization's audit chain verifies", brokenChains.length === 0, brokenChains.join(", ") || `${orgs.length} organizations`);

    const rlsOf = (pool: Pool) => q<{ t: string; rls: boolean; forced: boolean; policies: string }>(pool, `
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
    const [liveRls, copyRls] = [await rlsOf(live), await rlsOf(restored)];
    const rlsDiff = liveRls.filter((r, i) => JSON.stringify(r) !== JSON.stringify(copyRls[i])).map((r) => r.t);
    check("row-level security, forcing and every policy came back", rlsDiff.length === 0 && liveRls.length === copyRls.length, rlsDiff.join(", ") || `${liveRls.filter((r) => r.rls).length} protected tables`);

    const grants = (pool: Pool) => q<{ g: string }>(pool, `SELECT grantee || ':' || table_name || ':' || privilege_type AS g FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('loopsignal_app', 'loopsignal_maint') ORDER BY 1`);
    const [liveGrants, copyGrants] = [await grants(live), await grants(restored)];
    const lost = liveGrants.filter((g) => !copyGrants.some((c) => c.g === g.g)).map((g) => g.g);
    check("the app and maintenance roles kept exactly their privileges", lost.length === 0 && liveGrants.length === copyGrants.length, lost.slice(0, 3).join(", ") || `${liveGrants.length} grants`);

    const guard = async (sql: string) => restored!.query(sql).then(() => "allowed", (e: Error) => (/append-only/.test(e.message) ? "rejected" : `error: ${e.message.slice(0, 60)}`));
    // The guards are tested on rows the drill inserts into the RESTORED copy itself, so the check never depends on what data happens to exist.
    const anyOrg = (await q<{ id: string }>(restored, `SELECT id FROM "Organization" LIMIT 1`))[0]?.id;
    let guards: string[] = [`error: no organization to test with`];
    if (anyOrg) {
      const raw = `drill-${randomBytes(4).toString("hex")}`;
      const inserted = await restored.query(`INSERT INTO "RawEvent" (id, "organizationId", provider, "externalId", payload, "payloadHash") VALUES (gen_random_uuid(), $1, 'SYNTHETIC', $2, '\\x00', 'drill') RETURNING id`, [anyOrg, raw]);
      const rawId = inserted.rows[0].id as string;
      const hasRow = async (t: string) => (await q(restored!, `SELECT 1 FROM "${t}" LIMIT 1`)).length > 0;
      guards = [await guard(`DELETE FROM "RawEvent" WHERE id = '${rawId}'`), await guard(`UPDATE "RawEvent" SET "payloadHash" = 'x' WHERE id = '${rawId}'`)];
      // Behaviour is tested on rows that exist; on an empty table the statement would change nothing and prove nothing, so the triggers are checked directly (below).
      if (await hasRow("AuditLog")) guards.push(await guard(`DELETE FROM "AuditLog" WHERE id = (SELECT id FROM "AuditLog" LIMIT 1)`));
      if (await hasRow("LifecycleEvent")) guards.push(await guard(`UPDATE "LifecycleEvent" SET reason = 'x' WHERE id = (SELECT id FROM "LifecycleEvent" LIMIT 1)`));
    }
    const triggers = await q<{ t: string; n: string }>(restored, `SELECT c.relname AS t, count(*)::text AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND g.tgname IN (c.relname || '_append_only', c.relname || '_no_truncate') AND c.relname IN ('RawEvent', 'LifecycleEvent', 'AuditLog') GROUP BY 1`);
    check("the append-only triggers are present and enabled on every append-only table", triggers.length === 3 && triggers.every((x) => x.n === "2"), triggers.map((x) => `${x.t}:${x.n}`).join(", ") || "none found");
    check("the append-only guards still reject changes, even from the owner", guards.every((g) => g === "rejected"), guards.join(", "));
    const maint = await q<{ owner: string }>(restored, `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'retention_purge_raw_events'`);
    check("the maintenance functions kept their owner", maint[0]?.owner === "loopsignal_maint", maint[0]?.owner ?? "missing");

    const org = orgs[0];
    if (org) {
      const expected = Number((await q<{ n: string }>(restored, `SELECT count(*) n FROM "Message" WHERE "organizationId" = $1`, [org]))[0]!.n);
      const c = await appPool.connect();
      let seen = -1, withoutContext = -1, otherOrg = -1;
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        seen = Number((await c.query(`SELECT count(*) n FROM "Message"`)).rows[0].n);
        otherOrg = Number((await c.query(`SELECT count(*) n FROM "Message" WHERE "organizationId" <> $1`, [org])).rows[0].n);
        await c.query("ROLLBACK");
        withoutContext = Number((await c.query(`SELECT count(*) n FROM "Message"`)).rows[0].n);
      } finally {
        c.release();
      }
      check("the app role sees its own tenant's rows and nothing else", seen === expected && otherOrg === 0 && withoutContext === 0, `own ${seen}/${expected}, other ${otherOrg}, no context ${withoutContext}`);

      const sample = (await q<{ organizationId: string; bodyText: Buffer }>(restored, `SELECT "organizationId", "bodyText" FROM "Message" WHERE "contentPurgedAt" IS NULL LIMIT 1`))[0];
      if (sample) {
        let ok = true;
        try { decryptField(sample.bodyText, parseFieldKey(keyB64), `${sample.organizationId}:Message.bodyText`); } catch { ok = false; }
        check("stored content decrypts with the current key", ok, ok ? "sample opened" : "FIELD_ENCRYPTION_KEY does not open the restored data");
      } else check("stored content decrypts with the current key", true, "no content to sample");
    } else check("the app role sees its own tenant's rows and nothing else", true, "no organizations to test");
    seconds.verify = (Date.now() - t) / 1000;
  } finally {
    await restored?.end().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true }); // the dump holds data
  }
  return { ok: checks.every((c) => c.ok), checks, seconds, dumpBytes, scratch };
}

async function sabotage(pool: Pool, kind: Sabotage): Promise<void> {
  switch (kind) {
    case "rls": await pool.query(`ALTER TABLE "Message" DISABLE ROW LEVEL SECURITY`); break;
    case "audit": {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`UPDATE "AuditLog" SET action = 'tampered' WHERE id = (SELECT id FROM "AuditLog" ORDER BY seq LIMIT 1)`);
        await c.query("COMMIT");
      } finally { c.release(); }
      break;
    }
    case "guard": await pool.query(`DROP TRIGGER "RawEvent_append_only" ON "RawEvent"`); break;
    case "rows": {
      const r = await pool.query(`DELETE FROM "ItemMessageLink" WHERE id = (SELECT id FROM "ItemMessageLink" LIMIT 1)`); // nothing references a link
      if (r.rowCount !== 1) throw new Error("There was no row to remove for the sabotage; seed the database first");
      break;
    }
    case "grants": await pool.query(`REVOKE UPDATE ON "Message" FROM loopsignal_app`); break;
  }
}
