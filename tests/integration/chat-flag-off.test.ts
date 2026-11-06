import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { QUEUES, type QueueHub } from "@/lib/queue";
import { handleIngestSourceJob } from "@/modules/ingestion";
import { UnsupportedProviderError } from "@/modules/integrations";
import { chatAdapterFor, chatEnabled, startSpaceClaim, verifySpaceClaim } from "@/modules/sources";
import { handleChatScan } from "@/workers/chat-scan";
import { createEngineFixture } from "../helpers/engine-fixture";
import { FakeGoogle } from "../helpers/fake-google";
import { purgeOrgs, testKey } from "../helpers/fixtures";
import { createTestHub, destroyTestHub, waitingJobs } from "../helpers/queue";

// This file deliberately does NOT enable Google Chat: it is a feature flag that is off unless an operator turns it on. Even with a
// service account configured, nothing may reach Google while the flag is off.
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const fake = new FakeGoogle();
let f: Awaited<ReturnType<typeof createEngineFixture>>;
let hub: QueueHub;

beforeAll(async () => {
  await fake.start();
  Object.assign(process.env, { GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: fake.serviceAccountJson(), GOOGLE_TEST_BASE_URL: fake.baseUrl });
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

describe("with GOOGLE_CHAT_ENABLED off (the default)", () => {
  it("reports the integration as disabled", () => {
    expect(process.env["GOOGLE_CHAT_ENABLED"] ?? "false").toBe("false");
    expect(chatEnabled()).toBe(false);
  });

  it("refuses to request or verify a space, even for an admin", async () => {
    await expect(startSpaceClaim(f.principals.admin, { space: "spaces/AAAA1", teamId: f.teamId })).rejects.toMatchObject({ name: "ChatDisabledError" });
    await expect(verifySpaceClaim(f.principals.admin, randomUUID())).rejects.toMatchObject({ name: "ChatDisabledError" });
  });

  it("builds no Chat adapter, so a stray space cannot reach Google", async () => {
    expect(() => chatAdapterFor({ organizationId: f.organizationId, connectionId: randomUUID() })).toThrow(UnsupportedProviderError);
    const connection = await owner.sourceConnection.create({ data: { organizationId: f.organizationId, provider: "GOOGLE_CHAT", ownerUserId: f.users.admin, scopes: [] } });
    const source = await owner.monitoredSource.create({ data: { organizationId: f.organizationId, connectionId: connection.id, kind: "SPACE", externalId: "spaces/STRAY1", teamId: f.teamId } });
    await expect(handleIngestSourceJob({ organizationId: f.organizationId, monitoredSourceId: source.id }, { hub, fieldKey: testKey })).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(fake.requests).toHaveLength(0); // nothing was sent anywhere, not even a token request
  });

  it("the scan does nothing: no sync is queued for an enabled space", async () => {
    expect(await handleChatScan({ hub })).toEqual({ organizations: 0, syncsQueued: 0, failures: 0 });
    expect(await waitingJobs(hub, QUEUES.ingestSource)).toHaveLength(0);
  });
});
