import { describe, expect, it, afterAll } from "vitest";
import { createPrismaClient } from "@/lib/db";
import { runDrill, type Sabotage } from "../../scripts/drill/backup-restore";

// The drill dumps the real (test) database and restores it into a scratch database, so it needs the Postgres client tools or the compose
// container, like the runbook does. These tests prove two things: a good restore passes, and each check fails when the thing it guards is damaged.
const owner = createPrismaClient(process.env["DATABASE_URL"]!);
afterAll(async () => {
  const left = await owner.$queryRaw<Array<{ datname: string }>>`SELECT datname FROM pg_database WHERE datname LIKE 'drill\\_%'`;
  expect(left, "the scratch database is always removed").toEqual([]);
  await owner.$disconnect();
});

const failed = (r: Awaited<ReturnType<typeof runDrill>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("backup and restore drill", () => {
  it("passes on a faithful restore: same rows, intact audit chains, policies, grants, guards, tenant confinement and decryptable content", async () => {
    const report = await runDrill();
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      "backup completes", "restore completes without errors", "every table has the same number of rows", "every organization's audit chain verifies",
      "row-level security, forcing and every policy came back", "the app and maintenance roles kept exactly their privileges", "the append-only guards still reject changes, even from the owner",
      "the maintenance functions kept their owner", "the app role sees its own tenant's rows and nothing else", "stored content decrypts with the current key",
    ]));
    expect(report.dumpBytes).toBeGreaterThan(10_000);
  }, 120_000);

  const cases: Array<[Sabotage, string]> = [
    ["rls", "row-level security, forcing and every policy came back"],
    ["audit", "every organization's audit chain verifies"],
    ["guard", "the append-only guards still reject changes, even from the owner"],
    ["rows", "every table has the same number of rows"],
    ["grants", "the app and maintenance roles kept exactly their privileges"],
  ];
  it.each(cases)("catches a damaged restore: %s", async (kind, expected) => {
    const report = await runDrill({ sabotage: kind });
    expect(report.ok).toBe(false);
    expect(failed(report)).toContain(expected);
  }, 120_000);
});
