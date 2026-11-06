import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { purgeOrgs } from "../helpers/fixtures";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const orgs: string[] = [];
const users: string[] = [];
const email = () => `first-admin-${randomUUID().slice(0, 8)}@example.test`;
afterAll(async () => {
  await purgeOrgs(owner, orgs);
  await owner.user.deleteMany({ where: { id: { in: users } } });
  await owner.$disconnect();
});

const run = async (args: string[]) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/create-first-admin.ts", ...args], { encoding: "utf8" });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    return { code: (e as { code: number }).code, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
  }
};
const created = (out: string) => JSON.parse(out.split("\n").find((l) => l.includes("first-admin.created"))!) as { organizationId: string; userId: string; teamId: string };

describe("npm run real:first-admin", () => {
  it("creates the person, an organization where they are the administrator, and a team, so they can sign in", async () => {
    const e = email();
    const r = await run(["--email", e.toUpperCase(), "--name", "First Admin", "--org", "My Mail", "--team", "Personal"]); // case does not matter
    expect(r.code).toBe(0);
    const ids = created(r.out);
    orgs.push(ids.organizationId);
    users.push(ids.userId);
    expect(await owner.user.findUnique({ where: { email: e } })).toMatchObject({ id: ids.userId, email: e, name: "First Admin" }); // lower-cased, so the invite-only sign-in (which looks up by lower-cased email) will find them
    expect(await owner.membership.findFirstOrThrow({ where: { organizationId: ids.organizationId, userId: ids.userId } })).toMatchObject({ role: "ORG_ADMIN" });
    expect(await owner.team.findUniqueOrThrow({ where: { organizationId_id: { organizationId: ids.organizationId, id: ids.teamId } } })).toMatchObject({ name: "Personal" });
    expect(await owner.organization.findUniqueOrThrow({ where: { id: ids.organizationId } })).toMatchObject({ name: "My Mail" });
    const actions = (await owner.auditLog.findMany({ where: { organizationId: ids.organizationId }, orderBy: { seq: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["organization.created", "membership.granted", "team.created"])); // audited like anything else
  }, 90_000);

  it("names the team 'Inbox' by default", async () => {
    const e = email();
    const ids = created((await run(["--email", e, "--name", "Default Team", "--org", "Default Org"])).out);
    orgs.push(ids.organizationId);
    users.push(ids.userId);
    expect((await owner.team.findFirstOrThrow({ where: { organizationId: ids.organizationId } })).name).toBe("Inbox");
  }, 90_000);

  it("refuses to run twice for the same person, and changes nothing the second time", async () => {
    const e = email();
    const first = created((await run(["--email", e, "--name", "Twice", "--org", "Once"])).out);
    orgs.push(first.organizationId);
    users.push(first.userId);
    const again = await run(["--email", e, "--name", "Twice", "--org", "Another"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already set up");
    expect(await owner.organization.count({ where: { name: "Another" } })).toBe(0);
    expect(await owner.membership.count({ where: { userId: first.userId } })).toBe(1);
  }, 120_000);

  it("rejects missing or malformed input before creating anything", async () => {
    const before = await owner.user.count();
    for (const args of [[], ["--email", "x@example.test", "--name", "Only name"], ["--email", "not-an-email", "--name", "N", "--org", "O"], ["--email", `a b@example.test`, "--name", "N", "--org", "O"], ["--email", email(), "--name", "x".repeat(201), "--org", "O"]]) {
      const r = await run(args);
      expect(r.code, JSON.stringify(args)).toBe(1);
    }
    expect(await owner.user.count()).toBe(before);
  }, 180_000);
});
