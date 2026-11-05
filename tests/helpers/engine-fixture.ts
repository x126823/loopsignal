import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { encryptField } from "@/lib/crypto/fields";
import type { Principal } from "@/modules/identity";
import { syntheticEmail, testKey } from "./fixtures";

export const T0 = Date.UTC(2026, 9, 5, 9, 0); // 2026-10-05T09:00:00Z
export const at = (min: number) => new Date(T0 + min * 60_000);
/** A fixed clock well after every fixture timestamp. */
export const NOW = new Date(Date.UTC(2026, 10, 1));
export const engineOpts = { fieldKey: testKey, now: () => NOW };

export interface EngineFixture {
  organizationId: string;
  teamId: string;
  otherTeamId: string;
  sourceId: string;
  users: Record<"admin" | "lead" | "member" | "viewer" | "auditor" | "otherTeamMember", string>;
  principals: Record<"admin" | "lead" | "member" | "viewer" | "auditor" | "otherTeamMember", Principal>;
}

export async function createEngineFixture(owner: PrismaClient): Promise<EngineFixture> {
  const organizationId = randomUUID();
  const ids = {
    admin: randomUUID(), lead: randomUUID(), member: randomUUID(), viewer: randomUUID(), auditor: randomUUID(), otherTeamMember: randomUUID(),
  };
  await owner.organization.create({ data: { id: organizationId, name: `Engine ${organizationId.slice(0, 8)}` } });
  await owner.user.createMany({ data: Object.values(ids).map((id) => ({ id, email: syntheticEmail(id) })) });
  const orgRoles = { admin: "ORG_ADMIN", lead: "TEAM_LEAD", member: "MEMBER", viewer: "VIEWER", auditor: "AUDITOR", otherTeamMember: "MEMBER" } as const;
  await owner.membership.createMany({ data: (Object.keys(ids) as Array<keyof typeof ids>).map((k) => ({ organizationId, userId: ids[k], role: orgRoles[k] })) });
  const team = await owner.team.create({ data: { organizationId, name: "Support" } });
  const other = await owner.team.create({ data: { organizationId, name: "Billing" } });
  const connection = await owner.sourceConnection.create({ data: { organizationId, provider: "SYNTHETIC", ownerUserId: ids.admin, scopes: [] } });
  const source = await owner.monitoredSource.create({
    data: { organizationId, connectionId: connection.id, kind: "MAILBOX", externalId: "support@synthetic.test", teamId: team.id },
  });
  const teamRoles = { lead: "TEAM_LEAD", member: "MEMBER", viewer: "VIEWER", auditor: "AUDITOR" } as const;
  await owner.teamMember.createMany({
    data: [
      ...(Object.keys(teamRoles) as Array<keyof typeof teamRoles>).map((k) => ({ organizationId, teamId: team.id, userId: ids[k], role: teamRoles[k] })),
      { organizationId, teamId: other.id, userId: ids.otherTeamMember, role: "MEMBER" as const },
    ],
  });
  const principal = (k: keyof typeof ids): Principal => ({
    userId: ids[k], organizationId, orgRole: orgRoles[k],
    teamRoles: k === "otherTeamMember" ? { [other.id]: "MEMBER" } : k === "admin" ? {} : { [team.id]: teamRoles[k as keyof typeof teamRoles] },
  });
  const principals = Object.fromEntries((Object.keys(ids) as Array<keyof typeof ids>).map((k) => [k, principal(k)])) as EngineFixture["principals"];
  return { organizationId, teamId: team.id, otherTeamId: other.id, sourceId: source.id, users: ids, principals };
}

/** A new thread with one inbound message whose encrypted body is `text`. */
export async function createThreadWithMessage(owner: PrismaClient, f: EngineFixture, text = "Please fix the synthetic problem.", sentAtMin = 0) {
  const thread = await owner.thread.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
  const message = await createMessage(owner, f, thread.id, text, sentAtMin);
  return { threadId: thread.id, messageId: message.id };
}

export async function createMessage(owner: PrismaClient, f: EngineFixture, threadId: string, text: string, sentAtMin: number) {
  return owner.message.create({
    data: {
      organizationId: f.organizationId, monitoredSourceId: f.sourceId, threadId, provider: "SYNTHETIC", externalMessageId: `m-${randomUUID()}`,
      sentAt: at(sentAtMin), subject: "Synthetic", bodyText: encryptField(text, testKey, `${f.organizationId}:Message.bodyText`), bodyHash: "h", direction: "INBOUND",
    },
  });
}

export async function createAnalysisRun(owner: PrismaClient, f: EngineFixture, analyzer = "test_analyzer") {
  return owner.analysisRun.create({
    data: {
      organizationId: f.organizationId, analyzer, provider: "fake", model: "fake-1", promptVersion: "v1", inputHash: randomUUID(),
      output: {}, evidence: [], status: "OK",
    },
  });
}
