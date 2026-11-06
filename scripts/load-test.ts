// Load test on SYNTHETIC data against the real stack (docs/runbooks/load-test.md). No dependency beyond what the project already uses.
//
//   npm run load:test -- [--messages 2000] [--analysis-concurrency 4] [--http-requests 300] [--http-concurrency 20] [--base-url http://localhost:3000]
//                        [--no-http] [--mint-session] [--keep] [--assert]
// --mint-session: sign in with a cookie minted from this machine's AUTH_SECRET, to test a production build (`next start`) that refuses dev login.
//
// Phase 1 ingests N messages through the real sync path and analyzes them with the offline heuristic provider (no model is contacted).
// Phase 2 signs in as that organization's admin (dev login: the target must be a development server) and requests the main pages with
// concurrency, reporting latency percentiles and errors. `--assert` turns the thresholds below into an exit code (CI-friendly, generous).
import { randomUUID } from "node:crypto";
import { encode } from "next-auth/jwt";
import { createPrismaClient, withTenant } from "../src/lib/db";
import { QueueHub, QUEUES } from "../src/lib/queue";
import { syncSource } from "../src/modules/ingestion";
import { HeuristicProvider } from "../src/modules/intelligence";
import { createSyntheticAdapter, type SyntheticPayload } from "../src/modules/integrations";
import { handleAnalyzeMessage } from "../src/workers/analyze-message";
import { createEngineFixture } from "../tests/helpers/engine-fixture";
import { purgeOrgs, syntheticEmail, testKey } from "../tests/helpers/fixtures";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const N = Number(arg("messages", "2000"));
const ANALYSIS_CONCURRENCY = Number(arg("analysis-concurrency", "4"));
const HTTP_REQUESTS = Number(arg("http-requests", "300"));
const HTTP_CONCURRENCY = Number(arg("http-concurrency", "20"));
const BASE_URL = arg("base-url", "http://localhost:3000");

/** Generous floors for a developer laptop; they exist to catch an order-of-magnitude regression, not to benchmark. */
const THRESHOLDS = { ingestPerSec: 50, analyzePerSec: 10, httpP95Ms: 3000, httpErrorRate: 0 };

const percentile = (sorted: number[], p: number) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

const REQUESTS = ["The label printer jams on every third sheet. Can you look into this?", "Two users cannot sign in since this morning, please help urgently.", "Our CSV export is missing a column, could you check?", "Bulk uploads over 5000 rows time out; this is blocking us.", "Could you send a copy of last month's invoice?"];
const REPLIES = ["Thanks, we have received this and will look into it.", "The cause was an expired certificate; I have rotated it, please retry.", "We are reproducing the problem and a fix is in progress."];

function inbox(mailbox: string, n: number): SyntheticPayload[] {
  const out: SyntheticPayload[] = [];
  const base = Date.UTC(2026, 9, 5, 9, 0);
  let minute = 0;
  for (let t = 0; out.length < n; t++) {
    const turns = 1 + (t % 3); // one to three messages per conversation
    for (let i = 0; i < turns && out.length < n; i++) {
      minute += 1;
      const customer = i === 0;
      out.push({
        v: 1, id: `${mailbox}/load-${t}/${i}`, threadId: `${mailbox}/load-${t}`, direction: customer ? "INBOUND" : "OUTBOUND",
        from: customer ? { address: `customer${t % 500}@customer.synthetic.test`, name: `Customer ${t % 500}` } : { address: "support@synthetic.loopsignal.test", name: "Support" },
        subject: `Request ${t}`, body: customer ? `${REQUESTS[t % REQUESTS.length]} (ref ${t})` : REPLIES[(t + i) % REPLIES.length]!, sentAt: new Date(base + minute * 60_000).toISOString(),
      });
    }
  }
  return out;
}

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/**
 * A session cookie minted from AUTH_SECRET, for a PRODUCTION build (which refuses dev login by design). It only works against a server
 * that shares this machine's AUTH_SECRET, i.e. your own local build; it is not a way into anything else. Plain-http cookie name.
 */
async function mintSession(userId: string, email: string): Promise<string> {
  const name = "authjs.session-token";
  const token = await encode({ token: { sub: userId, email, name: "Load Test" }, secret: process.env["AUTH_SECRET"]!, salt: name, maxAge: 3600 });
  return `${name}=${token}`;
}

/** Dev-login through Auth.js's credentials flow and return a Cookie header, or null when the server does not allow it. */
async function signIn(email: string): Promise<string | null> {
  const jar = new Map<string, string>();
  const take = (res: Response) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const [k, ...v] = kv!.split("="); jar.set(k!, v.join("=")); } };
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  take(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await fetch(`${BASE_URL}/api/auth/callback/dev`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
    body: new URLSearchParams({ csrfToken, email, json: "true" }),
  });
  take(res);
  return [...jar.keys()].some((k) => /session-token/.test(k)) ? header() : null;
}

async function main(): Promise<void> {
  const print = console.log;
  console.log = () => undefined; // the modules log one structured line per step; the report is what matters here
  const owner = createPrismaClient(process.env["DATABASE_URL"]!);
  const hub = new QueueHub({ redisUrl: process.env["REDIS_URL"]!, prefix: `load-${randomUUID().slice(0, 8)}` });
  const f = await createEngineFixture(owner);
  // The daily LLM token budget (2M by default) is a real guard: past it, analysis jobs are deferred until the window rolls over. Lift it for this
  // throwaway organization so the run measures throughput; the tokens used are reported so the budget can be sized.
  await owner.organization.update({ where: { id: f.organizationId }, data: { settings: { llm: { dailyTokenBudget: 1_000_000_000 } } } });
  const report: Record<string, unknown> = { messagesRequested: N };
  let failed = false;
  try {
    const mailbox = `load-${randomUUID().slice(0, 6)}`;
    const data = inbox(mailbox, N);
    const adapter = createSyntheticAdapter({ events: () => data });

    // Phase 1a: ingestion through the real sync path.
    let t = Date.now();
    let pages = 0;
    for (;;) {
      const out = await syncSource({ organizationId: f.organizationId, monitoredSourceId: f.sourceId }, { hub, fieldKey: testKey, pageSize: 100, maxPages: 1_000, adapterFor: () => adapter });
      pages += out.pages;
      if (!out.hasMore) break;
    }
    const ingestSec = (Date.now() - t) / 1000;
    const ids = (await withTenant({ organizationId: f.organizationId }, (tx) => tx.message.findMany({ where: { monitoredSourceId: f.sourceId }, orderBy: { sentAt: "asc" }, select: { id: true } }))).map((m) => m.id);
    report["ingest"] = { messages: ids.length, pages, seconds: round(ingestSec), perSecond: round(ids.length / ingestSec) };

    // Phase 1b: analysis (offline heuristic provider), concurrency as the worker would use.
    t = Date.now();
    const statuses = new Map<string, number>();
    const latencies: number[] = [];
    // A job that throws is retried with backoff, as BullMQ does for the real worker (5 attempts, exponential from 2 s; shortened here).
    // Two messages of one conversation analysed at the same moment can collide on the item (optimistic concurrency): that is expected, and
    // the retry rate is itself a result worth reading.
    const retries = new Map<string, number>();
    let abandoned = 0;
    // A message whose conversation's earlier message has not been analysed yet answers DEFERRED, and the worker re-queues it after a delay.
    // The harness does the same, in passes, until nothing is deferred (or six passes), and reports how many passes it took.
    let todo = ids;
    let passes = 0;
    while (todo.length > 0 && passes < 6) {
      passes++;
      const deferred: string[] = [];
      await pool(todo, ANALYSIS_CONCURRENCY, async (messageId) => {
        const s = Date.now();
        for (let attempt = 1; ; attempt++) {
          try {
            const out = await handleAnalyzeMessage({ organizationId: f.organizationId, messageId }, { provider: new HeuristicProvider(), pipeline: { fieldKey: testKey }, engine: { fieldKey: testKey }, now: () => new Date() });
            if (out.status === "DEFERRED") deferred.push(messageId);
            else statuses.set(out.status, (statuses.get(out.status) ?? 0) + 1);
            break;
          } catch (e) {
            const name = e instanceof Error ? `${e.name}${(e as { code?: string }).code ? ` ${(e as { code?: string }).code}` : ""}` : "unknown";
            retries.set(name, (retries.get(name) ?? 0) + 1);
            if (attempt >= 5) { abandoned++; break; }
            await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
          }
        }
        latencies.push(Date.now() - s);
      });
      todo = deferred;
    }
    const analyzeSec = (Date.now() - t) / 1000;
    latencies.sort((a, b) => a - b);
    const items = await owner.trackedItem.count({ where: { organizationId: f.organizationId } });
    const usage = await owner.analysisRun.aggregate({ where: { organizationId: f.organizationId }, _sum: { tokensIn: true, tokensOut: true }, _count: true });
    report["analyze"] = { concurrency: ANALYSIS_CONCURRENCY, seconds: round(analyzeSec), perSecond: round(ids.length / analyzeSec), p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), p99Ms: percentile(latencies, 99), items, outcomes: Object.fromEntries(statuses), retries: Object.fromEntries(retries), abandonedAfter5Attempts: abandoned, passes, stillDeferred: todo.length, analysisRuns: usage._count, tokens: (usage._sum.tokensIn ?? 0) + (usage._sum.tokensOut ?? 0) };

    // Phase 2: pages under concurrency.
    if (!flag("no-http")) {
      let cookie: string | null = null;
      try { cookie = flag("mint-session") ? await mintSession(f.users.admin, syntheticEmail(f.users.admin)) : await signIn(syntheticEmail(f.users.admin)); } catch { cookie = null; }
      if (!cookie) {
        report["http"] = { skipped: `could not sign in at ${BASE_URL} (start the dev server, or pass --no-http)` };
      } else {
        const paths = ["/dashboard", "/items", "/approvals", "/review", "/notifications", "/dashboard?days=365"];
        const hit = async (path: string) => { const s = Date.now(); const r = await fetch(`${BASE_URL}${path}`, { headers: { cookie: cookie! }, redirect: "manual" }); await r.arrayBuffer(); return { path, status: r.status, ms: Date.now() - s }; };
        for (const p of paths) await hit(p); // warm up: the dev server compiles each page on first use
        const jobs = Array.from({ length: HTTP_REQUESTS }, (_, i) => paths[i % paths.length]!);
        const results: Array<{ path: string; status: number; ms: number }> = [];
        t = Date.now();
        await pool(jobs, HTTP_CONCURRENCY, async (p) => { results.push(await hit(p)); });
        const sec = (Date.now() - t) / 1000;
        const ms = results.map((r) => r.ms).sort((a, b) => a - b);
        const errors = results.filter((r) => r.status !== 200).length;
        const perPath = Object.fromEntries(paths.map((p) => { const m = results.filter((r) => r.path === p).map((r) => r.ms).sort((a, b) => a - b); return [p, { p50Ms: percentile(m, 50), p95Ms: percentile(m, 95) }]; }));
        report["http"] = { requests: results.length, concurrency: HTTP_CONCURRENCY, seconds: round(sec), perSecond: round(results.length / sec), p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), p99Ms: percentile(ms, 99), maxMs: ms.at(-1), errors, errorRate: round(errors / results.length, 4), statuses: results.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}), perPath };
      }
    }

    print(JSON.stringify(report, null, 2));
    if (flag("assert")) {
      const ing = report["ingest"] as { perSecond: number };
      const ana = report["analyze"] as { perSecond: number; abandonedAfter5Attempts: number; stillDeferred: number };
      const http = report["http"] as { p95Ms?: number; errorRate?: number } | undefined;
      const problems: string[] = [];
      if (ing.perSecond < THRESHOLDS.ingestPerSec) problems.push(`ingestion ${ing.perSecond}/s is below ${THRESHOLDS.ingestPerSec}/s`);
      if (ana.stillDeferred > 0) problems.push(`${ana.stillDeferred} messages were still deferred after 6 passes`);
      if (ana.abandonedAfter5Attempts > 0) problems.push(`${ana.abandonedAfter5Attempts} messages were still failing after 5 attempts`);
      if (ana.perSecond < THRESHOLDS.analyzePerSec) problems.push(`analysis ${ana.perSecond}/s is below ${THRESHOLDS.analyzePerSec}/s`);
      if (http?.p95Ms !== undefined && http.p95Ms > THRESHOLDS.httpP95Ms) problems.push(`page p95 ${http.p95Ms}ms is above ${THRESHOLDS.httpP95Ms}ms`);
      if (http?.errorRate !== undefined && http.errorRate > THRESHOLDS.httpErrorRate) problems.push(`page error rate ${http.errorRate} is above ${THRESHOLDS.httpErrorRate}`);
      if (problems.length) { console.error(problems.join("\n")); failed = true; }
    }
  } finally {
    if (!flag("keep")) {
      for (const q of [QUEUES.ingestSource, QUEUES.analyzeMessage]) await hub.queue(q).obliterate({ force: true }).catch(() => undefined);
      await purgeOrgs(owner, [f.organizationId]);
      await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
    }
    await hub.close();
    await owner.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e: Error) => { console.error(e.stack); process.exit(1); });
