// A rehearsal of docs/runbooks/production-checklist.md on this machine: everything on that list that can be checked WITHOUT your real
// environment, run for real. It builds a throwaway database from zero, boots the actual web and worker processes in production mode,
// and reports PASS or FAIL for each check (exit 1 on any FAIL). It does not touch the development database, and it cannot check anything
// that depends on your deployment (secret store, https, identity provider, alerting, backups schedule, real Google); those are listed at the end.
//
//   npm run build && npm run rehearse:production
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { encode } from "next-auth/jwt";
import { Pool } from "pg";
import { Queue } from "bullmq";
import { redisConnection } from "../src/lib/queue";

const WEB_PORT = 3020;
const results: Array<{ ok: boolean; name: string; detail: string }> = [];
const check = (ok: boolean, name: string, detail = "") => { results.push({ ok, name, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const ownerUrl = new URL(process.env["DATABASE_URL"]!.replace(/\?schema=\w+$/, ""));
const appUrl = new URL(process.env["APP_DATABASE_URL"]!.replace(/\?schema=\w+$/, ""));
const scratch = `rehearsal_${randomBytes(3).toString("hex")}`;
const dbUrl = (u: URL) => { const c = new URL(u); c.pathname = `/${scratch}`; return `${c.toString()}?schema=public`; };
const prefix = `rehearsal-${randomBytes(3).toString("hex")}`;
const FIELD_KEY = randomBytes(32).toString("base64");
const AUTH_SECRET = randomBytes(24).toString("base64");

/** A production-like environment built from scratch: nothing is inherited from this machine's development .env except what Next.js itself reads from the project's .env file, which every variable below overrides. */
const prodEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"]!, HOME: process.env["HOME"]!, NODE_ENV: "production",
  DATABASE_URL: dbUrl(ownerUrl), APP_DATABASE_URL: dbUrl(appUrl), REDIS_URL: process.env["REDIS_URL"]!, QUEUE_PREFIX: prefix,
  AUTH_SECRET, FIELD_ENCRYPTION_KEY: FIELD_KEY, AUTH_URL: `http://localhost:${WEB_PORT}`, AUTH_DEV_LOGIN: "false",
  GMAIL_ENABLED: "false", GOOGLE_CHAT_ENABLED: "false", LLM_PROVIDER: "fake", GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "", GOOGLE_TEST_BASE_URL: "",
  GMAIL_PUBSUB_TOPIC: "", GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: "", MAINTENANCE_JOBS_ENABLED: "true", ...extra,
});

const children: ChildProcess[] = [];
const killPort = (port: number) => { try { for (const pid of execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }) /* listeners only: this script holds client connections to the port and must not kill itself */.split("\n").filter(Boolean)) process.kill(Number(pid)); } catch { /* nothing listening */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean> | boolean, ms = 25_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { try { if (await fn()) return true; } catch { /* keep waiting */ } }
  return false;
}
const startWeb = (env: NodeJS.ProcessEnv) => { const p = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(WEB_PORT)], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(p); return p; };
const health = async () => (await fetch(`http://localhost:${WEB_PORT}/api/health`).then((r) => r.status).catch(() => 0));
const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, args, { env, encoding: "utf8" });

async function main(): Promise<void> {
  if (!statSync(".next/server/app-paths-manifest.json", { throwIfNoEntry: false })) throw new Error("There is no production build. Run `npm run build` first.");
  const admin = new Pool({ connectionString: ownerUrl.toString(), max: 2 });
  try {
    // 1. A database built from zero.
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const migrate = run(["node_modules/prisma/build/index.js", "migrate", "deploy"], { ...prodEnv(), DATABASE_URL: dbUrl(ownerUrl) });
    check(migrate.status === 0, "migrations apply to an empty database", migrate.status === 0 ? "" : (migrate.stderr || migrate.stdout).split("\n").slice(-3).join(" | "));
    const db = new Pool({ connectionString: dbUrl(ownerUrl).replace(/\?schema=\w+$/, ""), max: 2 });
    const migrations = Number((await db.query(`SELECT count(*) n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n);
    const expected = readdirSync("prisma/migrations").filter((d) => statSync(join("prisma/migrations", d)).isDirectory()).length;
    check(migrations === expected, "every migration is applied", `${migrations} of ${expected}`);
    const roles = (await db.query(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('loopsignal_app', 'loopsignal_maint')`)).rows;
    const r = (n: string) => roles.find((x) => x.rolname === n);
    check(!!r("loopsignal_app") && !r("loopsignal_app").rolsuper && !r("loopsignal_app").rolbypassrls && r("loopsignal_app").rolcanlogin, "the app role is not a superuser, cannot bypass row-level security, and can log in");
    check(!!r("loopsignal_maint") && !r("loopsignal_maint").rolsuper && !r("loopsignal_maint").rolbypassrls && !r("loopsignal_maint").rolcanlogin, "the maintenance role cannot log in and cannot bypass row-level security");
    const unprotected = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organizationId')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`)).rows.map((x) => x.relname);
    check(unprotected.length === 0, "every tenant table has row-level security enabled and forced", unprotected.join(", "));
    const owns = (await db.query(`SELECT count(*) n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'loopsignal_app'`)).rows[0].n;
    check(Number(owns) === 0, "the app role owns no tables (an owner could switch row-level security off)");
    const maxConn = Number((await db.query(`SHOW max_connections`)).rows[0].max_connections);
    const poolNeed = 2 * 20; // one web process and one worker at the default DB_POOL_MAX
    check(poolNeed < maxConn - 10, "the default pool size leaves room under max_connections", `${poolNeed} needed of ${maxConn}; with N web and worker processes it is N x DB_POOL_MAX`);

    // 2. A misconfigured deployment refuses to start; a good one serves.
    killPort(WEB_PORT);
    for (const [name, extra, key] of [
      ["no AUTH_URL", { AUTH_URL: "" }, "AUTH_URL"], ["dev login enabled", { AUTH_DEV_LOGIN: "true" }, "AUTH_DEV_LOGIN"],
      ["the Google test endpoint override", { GOOGLE_TEST_BASE_URL: "http://127.0.0.1:4010" }, "GOOGLE_TEST_BASE_URL"], ["http AUTH_URL on a real host", { AUTH_URL: "http://app.example.com" }, "AUTH_URL"],
      ["Gmail enabled without its client", { GMAIL_ENABLED: "true" }, "GOOGLE_OAUTH_CLIENT_ID"],
    ] as const) {
      const p = startWeb(prodEnv(extra));
      let out = "";
      p.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
      const exited = await waitFor(() => p.exitCode !== null, 20_000);
      const leaks = [AUTH_SECRET, FIELD_KEY].filter((v) => out.includes(v)).length;
      check(exited && p.exitCode === 1 && out.includes(key) && leaks === 0, `refuses to start with ${name}`, exited ? `exit ${p.exitCode}, names ${key}${leaks ? ", LEAKS A SECRET" : ""}` : `it kept running: ${out.replace(/\s+/g, " ").slice(-200)}`);
      if (!exited) killPort(WEB_PORT);
    }
    const web = startWeb(prodEnv());
    let webOut = "";
    web.stdout?.on("data", (d: Buffer) => { webOut += d.toString(); });
    web.stderr?.on("data", (d: Buffer) => { webOut += d.toString(); });
    const served = await waitFor(async () => (await health()) === 200, 40_000);
    check(served, "starts and serves with a good production configuration", served ? "" : webOut.replace(/\s+/g, " ").slice(-300));

    // 3. The running production server.
    const login = await fetch(`http://localhost:${WEB_PORT}/login`);
    const h = login.headers;
    const csp = h.get("content-security-policy") ?? "";
    check(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp) && !/unsafe-(inline|eval)/.test(csp.split("; ").find((d) => d.startsWith("script-src")) ?? "") && csp.includes("frame-ancestors 'none'"), "a nonce-based content security policy is sent");
    check(h.get("x-frame-options") === "DENY" && h.get("x-content-type-options") === "nosniff" && (h.get("strict-transport-security") ?? "").includes("max-age=") && h.get("x-powered-by") === null, "security headers are sent, HSTS is on, and the framework banner is off");
    const post = await fetch(`http://localhost:${WEB_PORT}/api/gmail/push`, { method: "POST", body: "{}" });
    const cb = await fetch(`http://localhost:${WEB_PORT}/api/gmail/callback`, { redirect: "manual" });
    check(post.status === 404 && cb.status === 404, "the Gmail endpoints do not exist while Gmail is off");
    const anon = await fetch(`http://localhost:${WEB_PORT}/settings/retention`, { redirect: "manual" });
    check(anon.status >= 300 && anon.status < 400 && (anon.headers.get("location") ?? "").includes("/login"), "a signed-out visitor is sent to sign in");

    const cli = run(["--import", "tsx", "e2e/fixture-cli.ts", "new-org", "{}"], prodEnv());
    const fx = JSON.parse((cli.stdout.split("\n").find((l) => l.startsWith("@@JSON@@")) ?? "@@JSON@@{}").slice(8)) as { organizationId?: string; users?: Record<string, string>; emails?: Record<string, string> };
    check(!!fx.organizationId, "an organization can be created in the empty database");
    const cookie = async (role: string) => `authjs.session-token=${await encode({ token: { sub: fx.users![role], email: fx.emails![role], name: role }, secret: AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 })}`;
    const page = async (path: string, role: string) => { const res = await fetch(`http://localhost:${WEB_PORT}${path}`, { headers: { cookie: await cookie(role) }, redirect: "manual" }); return { status: res.status, text: await res.text() }; };
    const adminRetention = await page("/settings/retention", "admin");
    const memberRetention = await page("/settings/retention", "member");
    check(adminRetention.status === 200 && adminRetention.text.includes("Raw provider payloads") && memberRetention.status === 200 && memberRetention.text.includes("Only organization admins") && !memberRetention.text.includes("Raw provider payloads"), "an admin signs in and manages retention; a member is refused", "sessions minted from this run's own AUTH_SECRET");
    const adminSec = await page("/settings/security", "admin");
    const memberSec = await page("/settings/security", "member");
    check(adminSec.status === 200 && adminSec.text.includes("Members") && memberSec.status === 200 && memberSec.text.includes("Sign out everywhere") && !memberSec.text.includes("member-row"), "everyone can end their own sessions; only an admin sees the member list");
    await db.query(`UPDATE "User" SET "sessionsValidAfter" = now() + interval '1 minute' WHERE id = $1`, [fx.users!["member"]]);
    const revoked = await fetch(`http://localhost:${WEB_PORT}/approvals`, { headers: { cookie: await cookie("member") }, redirect: "manual" });
    check(revoked.status === 307 && (revoked.headers.get("location") ?? "").includes("/login"), "a session issued before sign-out-everywhere is refused", "checked on a production build");
    await db.query(`UPDATE "User" SET "sessionsValidAfter" = NULL WHERE id = $1`, [fx.users!["member"]]);
    const adminConn = await page("/settings/connections", "admin");
    check(adminConn.status === 200 && adminConn.text.includes("No connections are turned on"), "Connections says every integration is off by default");
    const pagesOk = (await Promise.all(["/approvals", "/items", "/dashboard", "/review", "/notifications"].map((p) => page(p, "admin")))).every((x) => x.status === 200);
    check(pagesOk, "the main pages render in production mode");
    check((await fetch(`http://localhost:${WEB_PORT}/approvals`, { headers: { cookie: "authjs.session-token=not-a-valid-token" }, redirect: "manual" })).status === 307, "a forged session is not accepted");
    web.kill();
    killPort(WEB_PORT);

    // 4. The worker boots in production mode with the right schedules.
    const worker = spawn(process.execPath, ["--import", "tsx", "src/workers/index.ts"], { env: prodEnv(), stdio: ["ignore", "pipe", "pipe"] });
    children.push(worker);
    let wlog = "";
    worker.stdout?.on("data", (d: Buffer) => { wlog += d.toString(); });
    check(await waitFor(() => wlog.includes('"worker.started"')), "the worker starts in production mode");
    check(/"gmail":false/.test(wlog) && /"chat":false/.test(wlog), "the worker starts no Gmail or Chat scan while they are off");
    await sleep(1500);
    const q = (n: string) => new Queue(n, { connection: redisConnection(process.env["REDIS_URL"]!), prefix });
    const schedulers = async (n: string) => { const queue = q(n); const s = await queue.getJobSchedulers(); await queue.close(); return s.length; };
    const [sla, retention, audit, gmail, chat] = await Promise.all(["sla-scan", "retention", "audit-verify", "gmail-scan", "chat-scan"].map(schedulers));
    check(sla === 1 && retention === 1 && audit === 1, "the SLA, retention and audit-verification schedules exist, once each");
    check(gmail === 0 && chat === 0, "no Gmail or Chat schedule exists while they are off");
    worker.kill();
    const badWorker = spawnSync(process.execPath, ["--import", "tsx", "src/workers/index.ts"], { env: { ...prodEnv(), FIELD_ENCRYPTION_KEY: "short" }, encoding: "utf8", timeout: 20_000 });
    check(badWorker.status !== 0 && (badWorker.stderr + badWorker.stdout).includes("FIELD_ENCRYPTION_KEY"), "the worker refuses to start with an invalid key");

    // 5. Operations against the new database.
    const retentionRun = run(["--import", "tsx", "scripts/run-retention.ts"], prodEnv());
    check(retentionRun.status === 0 && retentionRun.stdout.includes('"retention.manual"'), "a retention pass runs against the new database");
    const drill = run(["--import", "tsx", "scripts/backup-restore-drill.ts"], prodEnv());
    check(drill.status === 0 && drill.stdout.includes('"ok":true'), "the backup and restore drill passes on the new database", drill.status === 0 ? "" : drill.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("; "));

    // 6. The alerting events the checklist names exist, at the level it says.
    const source = readdirRecursive("src").map((f) => readFileSync(f, "utf8")).join("\n");
    const events: Array<[string, string]> = [["audit.chain_broken", "error"], ["audit.verify_failed", "error"], ["gmail.watch_renewal_failed", "error"], ["chat.app_credentials_rejected", "error"], ["retention.failed", "error"], ["worker.error", "error"], ["job.dead_lettered", "warn"]];
    const missing = events.filter(([name, level]) => !new RegExp(`log\\("${level}",\\s*"${name.replace(/\./g, "\\.")}"`).test(source)).map(([n]) => n);
    check(missing.length === 0, "every log event the checklist tells you to alert on is emitted, at the stated level", missing.join(", "));
    await db.end();
  } finally {
    for (const c of children) c.kill();
    killPort(WEB_PORT);
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    const hub = new Queue("x", { connection: redisConnection(process.env["REDIS_URL"]!), prefix });
    for (const n of ["ingest-source", "analyze-message", "sla-scan", "sla-risk", "correlation-follow-up", "retention", "audit-verify"]) await new Queue(n, { connection: redisConnection(process.env["REDIS_URL"]!), prefix }).obliterate({ force: true }).catch(() => undefined);
    await hub.close();
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  console.log(["", "Not checked here: they depend on YOUR environment. Do these from docs/runbooks/production-checklist.md:",
    "  - secrets come from a secret store, are unique per environment, and FIELD_ENCRYPTION_KEY is backed up separately from the database",
    "  - the public https URL and TLS termination; HSTS only means something behind https", "  - sign-in through your real identity provider",
    "  - error-level logs actually page someone (this repository only emits them)", "  - backups run on a schedule, are copied off-site, and a restore has been timed in your environment",
    "  - Postgres max_connections and the number of web and worker processes you will run", "  - Google Cloud project, verification of restricted scopes, and the LLM provider's data terms",
    "  - the user's authorization for real data, and legal/HR sign-off"].join("\n"));
  process.exit(failed.length ? 1 : 0);
}

function readdirRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? readdirRecursive(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : []; });
}

main().catch((e: Error) => { console.error(e.message); for (const c of children) c.kill(); killPort(WEB_PORT); process.exit(1); });
