import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("ops:export-person", () => {
  it("writes the person's data to a new file only its owner can read, refuses to overwrite, and prints counts but no content", async () => {
    const g = await createEngineFixture(owner);
    const thread = await owner.thread.create({ data: { organizationId: g.organizationId, provider: "SYNTHETIC", externalThreadId: `t-${randomUUID()}` } });
    const person = await owner.participant.create({ data: { organizationId: g.organizationId, address: "users/export-script", displayName: "Export Script Person" } });
    await owner.message.create({ data: { organizationId: g.organizationId, monitoredSourceId: g.sourceId, threadId: thread.id, provider: "SYNTHETIC", externalMessageId: `m-${randomUUID()}`, senderParticipantId: person.id, sentAt: new Date(), subject: "Hello", bodyText: encryptField("A very private sentence for the export test.", testKey, `${g.organizationId}:Message.bodyText`), bodyHash: "h", direction: "INBOUND" } });
    const dir = mkdtempSync(join(tmpdir(), "loopsignal-export-"));
    const file = join(dir, "person.json");
    try {
      const args = ["--org", g.organizationId, "--participant", person.id, "--as", g.users.admin, "--out", file];
      expect(run("scripts/export-person.ts", [...args.slice(0, 6)]).code).toBe(1); // no --out
      expect(run("scripts/export-person.ts", ["--org", g.organizationId, "--participant", person.id, "--as", g.users.member, "--out", file]).err).toContain("administrator");
      const r = run("scripts/export-person.ts", args);
      expect(r.code).toBe(0);
      expect(r.out).toContain('"event":"export.done"');
      expect(r.out).not.toMatch(/private sentence|Export Script Person|export-script/);
      expect(statSync(file).mode & 0o777).toBe(0o600); // owner only
      const data = JSON.parse(readFileSync(file, "utf8")) as { messages: Array<{ body: string }>; participant: { displayName: string } };
      expect(data.messages.map((m) => m.body)).toEqual(["A very private sentence for the export test."]);
      expect(data.participant.displayName).toBe("Export Script Person");
      writeFileSync(file, "precious");
      expect(run("scripts/export-person.ts", args).code).toBe(1); // never overwrites
      expect(readFileSync(file, "utf8")).toBe("precious");
      expect(run("scripts/export-person.ts", ["--org", g.organizationId, "--participant", randomUUID(), "--as", g.users.admin, "--out", join(dir, "none.json")]).err).toContain("No such participant");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await purgeOrgs(owner, [g.organizationId]);
      await owner.user.deleteMany({ where: { id: { in: Object.values(g.users) } } });
    }
  }, 120_000);
});
