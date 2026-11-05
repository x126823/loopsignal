import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { encryptField } from "@/lib/crypto/fields";

export const testKey = randomBytes(32);

/**
 * Delete every row belonging to the given organizations, across all tenant tables.
 * Test cleanup only: uses session_replication_role=replica (owner/superuser) to bypass append-only
 * triggers and FK ordering, which production code paths can never do.
 */
export async function purgeOrgs(owner: PrismaClient, orgIds: string[]): Promise<void> {
  const tables = await owner.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'organizationId'`;
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    for (const { table_name } of tables) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "organizationId" = ANY($1::uuid[])`, orgIds);
    }
    await tx.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = ANY($1::uuid[])`, orgIds);
  });
}

/** Fixtures may write TrackedItem directly, but must open the lifecycle guard the way the engine does. */
export async function asLifecycleWriter<T>(owner: PrismaClient, fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.lifecycle_writer', 'on', true)`;
    return fn(tx);
  });
}

export const syntheticEmail = (id: string) => `u-${id}@synthetic.loopsignal.test`;

export interface OrgFixture {
  organizationId: string;
  userId: string;
  teamId: string;
  connectionId: string;
  sourceId: string;
  threadId: string;
  messageId: string;
  itemId: string;
}

/** A complete synthetic chain (org, user, team, source, thread, message, item) inserted as the owner. */
export async function createOrgFixture(owner: PrismaClient): Promise<OrgFixture> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name: `Fixture ${organizationId.slice(0, 8)}` } });
  await owner.user.create({ data: { id: userId, email: syntheticEmail(userId) } });
  await owner.membership.create({ data: { organizationId, userId, role: "ORG_ADMIN" } });
  const team = await owner.team.create({ data: { organizationId, name: "Support" } });
  const connection = await owner.sourceConnection.create({
    data: { organizationId, provider: "SYNTHETIC", ownerUserId: userId, scopes: [] },
  });
  const source = await owner.monitoredSource.create({
    data: { organizationId, connectionId: connection.id, kind: "MAILBOX", externalId: "support@synthetic.test", teamId: team.id },
  });
  const thread = await owner.thread.create({ data: { organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
  const message = await owner.message.create({
    data: {
      organizationId, monitoredSourceId: source.id, threadId: thread.id, provider: "SYNTHETIC",
      externalMessageId: `m-${randomUUID()}`, sentAt: new Date("2026-10-01T09:00:00Z"), subject: "Synthetic request",
      bodyText: encryptField("Please help with my synthetic problem.", testKey, `${organizationId}:Message.bodyText`),
      bodyHash: "hash", direction: "INBOUND",
    },
  });
  const item = await asLifecycleWriter(owner, (tx) => tx.trackedItem.create({
    data: { organizationId, teamId: team.id, originMessageId: message.id, threadId: thread.id, title: "Synthetic request" },
  }));
  return {
    organizationId, userId, teamId: team.id, connectionId: connection.id, sourceId: source.id,
    threadId: thread.id, messageId: message.id, itemId: item.id,
  };
}
