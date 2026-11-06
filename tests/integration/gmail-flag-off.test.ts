import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { QUEUES, UnrecoverableError, type QueueHub } from "@/lib/queue";
import { handleIngestSourceJob } from "@/modules/ingestion";
import { createKeySource, UnsupportedProviderError } from "@/modules/integrations";
import { beginGmailConnect, completeGmailConnect, gmailAdapterFor, gmailEnabled, handleGmailPush } from "@/modules/sources";
import { handleGmailScan } from "@/workers/gmail-scan";
import { createEngineFixture } from "../helpers/engine-fixture";
import { FakeGoogle } from "../helpers/fake-google";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createTestHub, destroyTestHub, waitingJobs } from "../helpers/queue";

// This file deliberately does NOT enable Gmail: the integration is a feature flag that is off unless an operator turns it on. The push
// settings ARE present, so the only thing standing between a request and a queued sync is the flag itself.
Object.assign(process.env, {
  GMAIL_PUBSUB_TOPIC: "projects/synthetic-project/topics/gmail-push",
  GMAIL_PUSH_AUDIENCE: "https://app.example.test/api/gmail/push",
  GMAIL_PUSH_SERVICE_ACCOUNT: "pubsub@synthetic-project.iam.gserviceaccount.com",
});
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const fake = new FakeGoogle();
let f: Awaited<ReturnType<typeof createEngineFixture>>;
let hub: QueueHub;

beforeAll(async () => {
  await fake.start();
  f = await createEngineFixture(owner);
  hub = createTestHub();
});
afterAll(async () => {
  await destroyTestHub(hub);
  await purgeOrgs(owner, [f.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
  await owner.$disconnect();
  await fake.stop();
});

describe("with GMAIL_ENABLED off (the default)", () => {
  it("reports the integration as disabled", () => {
    expect(process.env["GMAIL_ENABLED"] ?? "false").toBe("false");
    expect(gmailEnabled()).toBe(false);
  });

  it("refuses to start or finish a connection, even for an admin", async () => {
    await expect(beginGmailConnect(f.principals.admin, { teamId: f.teamId })).rejects.toMatchObject({ name: "GmailDisabledError" });
    await expect(completeGmailConnect(f.principals.admin, { code: "c", state: "s", providerError: null, cookieValue: "a.b" })).rejects.toMatchObject({ name: "GmailDisabledError" });
  });

  it("builds no Gmail adapter, so a stray GMAIL source cannot reach Google", async () => {
    expect(() => gmailAdapterFor({ organizationId: f.organizationId, connectionId: randomUUID() })).toThrow(UnsupportedProviderError);
    const connection = await owner.sourceConnection.create({ data: { organizationId: f.organizationId, provider: "GMAIL", ownerUserId: f.users.admin, scopes: [] } });
    const source = await owner.monitoredSource.create({ data: { organizationId: f.organizationId, connectionId: connection.id, kind: "MAILBOX", externalId: "stray@synthetic.test" } });
    await expect(handleIngestSourceJob({ organizationId: f.organizationId, monitoredSourceId: source.id }, { hub, fieldKey: testKey })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fake.requests).toHaveLength(0); // nothing was sent anywhere
  });

  it("the scan does nothing: no sync is queued for an active Gmail connection", async () => {
    const scanned = await handleGmailScan({ hub });
    expect(scanned).toEqual({ organizations: 0, syncsQueued: 0, watchesRenewed: 0, failures: 0 });
    expect(await waitingJobs(hub, QUEUES.ingestSource)).toHaveLength(0);
  });

  it("the push endpoint does not exist: 404 even for a well-formed request", async () => {
    const token = fake.pushToken();
    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: "stray@synthetic.test", historyId: 1 })).toString("base64") } };
    const keys = createKeySource(`${fake.baseUrl}/certs`);
    expect(await handleGmailPush({ authorization: `Bearer ${token}`, body }, { hub, keys })).toEqual({ status: 404 });
    expect(await waitingJobs(hub, QUEUES.ingestSource)).toHaveLength(0);
  });
});
