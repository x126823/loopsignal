import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { encryptField } from "@/lib/crypto/fields";
import { createEngineFixture, type EngineFixture } from "../helpers/engine-fixture";
import { purgeOrgs, testKey } from "../helpers/fixtures";

// The operator scripts, run exactly as the runbook says (a separate process, the real database).
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
let f: EngineFixture;
let participantId: string;
let messageId: string;

beforeAll(async () => {
  f = await createEngineFixture(owner);
  const thread = await owner.thread.create({ data: { organizationId: f.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
  participantId = (await owner.participant.create({ data: { organizationId: f.organizationId, address: "users/script-person", displayName: "Script Person" } })).id;
  messageId = (await owner.message.create({ data: { organizationId: f.organizationId, monitoredSourceId: f.sourceId, threadId: thread.id, provider: "SYNTHETIC", externalMessageId: `m-${randomUUID()}`, senderParticipantId: participantId, sentAt: new Date(Date.now() - 400 * 86_400_000), createdAt: new Date(Date.now() - 400 * 86_400_000), subject: "Old", bodyText: encryptField("An old message from the script test.", testKey, `${f.organizationId}:Message.bodyText`), bodyHash: "h", direction: "INBOUND" } })).id;
});
afterAll(async () => {
  await purgeOrgs(owner, [f.organizationId]);
  await owner.user.deleteMany({ where: { id: { in: Object.values(f.users) } } });
  await owner.$disconnect();
});

const run = (script: string, args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", script, ...args], { encoding: "utf8", stdio: "pipe" }), err: "" };
  } catch (e) {
    return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
  }
};
const purged = async () => (await owner.message.findUniqueOrThrow({ where: { id: messageId } })).contentPurgedAt !== null;

describe("ops:retention", () => {
  it("refuses an organization that does not exist, and prints counts only", () => {
    expect(run("scripts/run-retention.ts", ["--org", randomUUID()])).toMatchObject({ code: 1 });
    expect(run("scripts/run-retention.ts", ["--org"]).code).toBe(1);
  }, 60_000);

  it("runs one pass for one organization", async () => {
    expect(await purged()).toBe(false);
    const r = run("scripts/run-retention.ts", ["--org", f.organizationId]);
    expect(r.code).toBe(0);
    const line = JSON.parse(r.out.split("\n").filter((l) => l.includes('"retention.manual"')).at(-1)!);
    expect(line).toMatchObject({ event: "retention.manual", messages: 1, complete: true });
    expect(r.out).not.toContain("An old message");
    expect(await purged()).toBe(true);
  }, 60_000);
});

describe("ops:erase-person", () => {
  it("needs all its arguments, an administrator, and a participant of that organization", async () => {
    expect(run("scripts/erase-person.ts", []).code).toBe(1);
    const base = ["--org", f.organizationId, "--participant", participantId];
    expect(run("scripts/erase-person.ts", [...base, "--as", f.users.member]).err).toContain("administrator"); // a member may not
    expect(run("scripts/erase-person.ts", [...base, "--as", randomUUID()]).code).toBe(1);
    expect(run("scripts/erase-person.ts", ["--org", f.organizationId, "--participant", randomUUID(), "--as", f.users.admin]).err).toContain("No such participant");
  }, 60_000); // each run is a separate process

  it("does nothing without --yes, and with it erases the person and attributes the action to the administrator", async () => {
    const args = ["--org", f.organizationId, "--participant", participantId, "--as", f.users.admin];
    expect(run("scripts/erase-person.ts", args).out).toContain("erase.dry-run");
    expect((await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: participantId } } })).displayName).toBe("Script Person");
    const r = run("scripts/erase-person.ts", [...args, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"event":"erase.done"');
    expect(r.out).not.toMatch(/Script Person|script-person|old message/i);
    expect(await owner.participant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: participantId } } })).toMatchObject({ displayName: null, address: `erased:${participantId}` });
    expect(await owner.auditLog.findFirstOrThrow({ where: { organizationId: f.organizationId, action: "participant.erased" } })).toMatchObject({ actorId: f.users.admin, actorType: "USER" });
  }, 60_000);
});
