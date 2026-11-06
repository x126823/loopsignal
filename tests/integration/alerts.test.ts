import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real HTTP receiver stands in for the operator's webhook. The environment is read lazily, so it is set before anything runs.
const received: Array<{ body: Record<string, unknown>; raw: string; signature: string | undefined }> = [];
let respondWith = 200;
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c));
  req.on("end", () => {
    received.push({ raw, body: JSON.parse(raw || "{}") as Record<string, unknown>, signature: req.headers["x-loopsignal-signature"] as string | undefined });
    res.writeHead(respondWith).end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const SECRET = "integration-test-secret-0123456789";
Object.assign(process.env, { ALERT_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, ALERT_WEBHOOK_SECRET: SECRET, ALERT_DEDUPE_MINUTES: "60" });

const { createPrismaClient } = await import("@/lib/db");
const { flushAlerts, resetAlertState } = await import("@/lib/alerts");
const { QUEUES, UnrecoverableError } = await import("@/lib/queue");
const { setRetention, verifyAllAuditChains } = await import("@/modules/retention");
const { markConnectionAuthFailed } = await import("@/modules/sources");
const { createEngineFixture } = await import("../helpers/engine-fixture");
const { purgeOrgs } = await import("../helpers/fixtures");
const { createTestHub, destroyTestHub, waitFor } = await import("../helpers/queue");

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const fixtures: Array<Awaited<ReturnType<typeof createEngineFixture>>> = [];
const events = () => received.map((r) => r.body["event"]);

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
  await purgeOrgs(owner, fixtures.map((f) => f.organizationId));
  await owner.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => Object.values(f.users)) } } });
  await owner.$disconnect();
});
beforeEach(() => {
  received.length = 0;
  respondWith = 200;
  resetAlertState();
});

describe("alerts raised by the real code paths", () => {
  it("a broken audit chain pages with the organization and the first bad row, signed, and with nothing else", async () => {
    const f = await createEngineFixture(owner);
    fixtures.push(f);
    await setRetention(f.principals.admin, { rawEventDays: 14, messageDays: 120 });
    await setRetention(f.principals.admin, { rawEventDays: 20, messageDays: 150 });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE "AuditLog" SET action = 'retention.nothing_happened' WHERE "organizationId" = ${f.organizationId}::uuid AND action = 'retention.settings_changed'`;
    });
    await verifyAllAuditChains({ only: [f.organizationId] });
    await flushAlerts();
    const alert = received.find((r) => r.body["event"] === "audit.chain_broken")!;
    expect(alert.body).toMatchObject({ source: "loopsignal", severity: "critical", details: { organizationId: f.organizationId, firstBadSeq: expect.any(Number) } });
    expect(Object.keys(alert.body["details"] as object).sort()).toEqual(["firstBadSeq", "organizationId"]);
    expect(alert.signature).toBe(`sha256=${createHmac("sha256", SECRET).update(alert.raw).digest("hex")}`);
    // Verifying again while the problem persists does not page again within the window.
    const before = received.length;
    await verifyAllAuditChains({ only: [f.organizationId] });
    await flushAlerts();
    expect(received.length).toBe(before);
  });

  it("an intact chain raises nothing", async () => {
    const f = await createEngineFixture(owner);
    fixtures.push(f);
    await verifyAllAuditChains({ only: [f.organizationId] });
    await flushAlerts();
    expect(received).toEqual([]);
  });

  it("a connection that Google refuses pages once, when it first needs attention, and not again", async () => {
    const f = await createEngineFixture(owner);
    fixtures.push(f);
    const connection = await owner.sourceConnection.create({ data: { organizationId: f.organizationId, provider: "GMAIL", ownerUserId: f.users.admin, scopes: [] } });
    await markConnectionAuthFailed(f.organizationId, connection.id, "invalid_grant");
    await flushAlerts();
    resetAlertState(); // forget what was sent, so only the rule "alert on the transition" (not the repeat window) can keep the next call quiet
    await markConnectionAuthFailed(f.organizationId, connection.id, "invalid_grant"); // already in error: not a new event
    await flushAlerts();
    const alerts = received.filter((r) => r.body["event"] === "connection.needs_attention");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toMatchObject({ severity: "warning", details: { organizationId: f.organizationId, connectionId: connection.id, reason: "invalid_grant" } });
  });

  it("a job that used up its retries pages with the queue and the error class, never the job's data", async () => {
    const hub = createTestHub();
    try {
      const secretish = randomUUID();
      hub.worker(QUEUES.ingestSource, async () => { throw new UnrecoverableError(`provider echoed: Confidential ${secretish}`); }, { concurrency: 1 });
      await hub.enqueue(QUEUES.ingestSource, { organizationId: randomUUID(), monitoredSourceId: randomUUID() }, `alert-test-${randomUUID()}`);
      await waitFor(async () => events().includes("job.dead_lettered") && true, 15_000, "the dead-letter alert");
      const alert = received.find((r) => r.body["event"] === "job.dead_lettered")!;
      expect(alert.body["details"]).toEqual({ queue: "ingest-source", errorName: "UnrecoverableError" });
      expect(alert.raw).not.toMatch(/Confidential|echoed|monitoredSourceId/);
    } finally {
      await destroyTestHub(hub);
    }
  }, 30_000);
});

describe("a failing webhook", () => {
  it("never breaks the work that raised the alert, and is tried again on the next occurrence", async () => {
    const f = await createEngineFixture(owner);
    fixtures.push(f);
    respondWith = 500;
    await setRetention(f.principals.admin, { rawEventDays: 14, messageDays: 120 });
    await setRetention(f.principals.admin, { rawEventDays: 20, messageDays: 150 });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE "AuditLog" SET action = 'x.y' WHERE "organizationId" = ${f.organizationId}::uuid AND action = 'retention.settings_changed'`;
    });
    const out = await verifyAllAuditChains({ only: [f.organizationId] });
    await flushAlerts();
    expect(out).toMatchObject({ organizations: 1, broken: 1, failed: 0 }); // the check still completed and recorded its result
    const attempts = received.length;
    expect(attempts).toBeGreaterThanOrEqual(1);
    respondWith = 200;
    await verifyAllAuditChains({ only: [f.organizationId] });
    await flushAlerts();
    expect(received.length).toBeGreaterThan(attempts); // not remembered as sent, so it was retried
    expect(await owner.auditLog.count({ where: { organizationId: f.organizationId, action: "audit.chain_verified" } })).toBe(2);
  });
});

describe("ops:test-alert", () => {
  // Asynchronous on purpose: the receiver lives in THIS process, and blocking here would stop it answering the child.
  const run = async (env: Record<string, string>) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/test-alert.ts"], { encoding: "utf8", env: { ...process.env, ...env } });
      return { code: 0, out: stdout, err: "" };
    } catch (e) {
      return { code: (e as { code: number }).code, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
    }
  };

  it("reaches the webhook, signed, with no data, and says so", async () => {
    const before = received.length;
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain('"result":"sent"');
    const got = received.slice(before).find((x) => x.body["event"] === "alert.test")!;
    expect(got.body).toMatchObject({ source: "loopsignal", severity: "warning", details: {} });
    expect(got.signature).toBe(`sha256=${createHmac("sha256", SECRET).update(got.raw).digest("hex")}`);
  }, 60_000);

  it("fails loudly (exit 1) when nothing is configured, or the receiver is down", async () => {
    expect((await run({ ALERT_WEBHOOK_URL: "" })).err).toContain("not set");
    expect((await run({ ALERT_WEBHOOK_URL: "http://127.0.0.1:9/hook" })).code).toBe(1); // nothing is listening there
  }, 60_000);
});
