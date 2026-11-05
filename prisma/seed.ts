// Synthetic seed data only. Idempotent: safe to run repeatedly. Never put real people here.
import { withTenant } from "../src/lib/db";
import type { Role } from "../generated/prisma/enums";

const DOMAIN = "synthetic.loopsignal.test";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ORGS = { acme: id(1), globex: id(2) } as const;
const TEAMS = { acmeSupport: id(101), acmeBilling: id(102), globexOps: id(103) } as const;

const USERS = [
  { id: id(11), name: "Alice Admin", handle: "alice" },
  { id: id(12), name: "Bob Lead", handle: "bob" },
  { id: id(13), name: "Carol Member", handle: "carol" },
  { id: id(14), name: "Dave Viewer", handle: "dave" },
  { id: id(15), name: "Erin Auditor", handle: "erin" },
  { id: id(16), name: "Frank Admin", handle: "frank" },
  { id: id(17), name: "Gina Multi", handle: "gina" }, // member of both orgs
] as const;
const uid = (handle: string) => USERS.find((u) => u.handle === handle)!.id;

const MEMBERSHIPS: Array<[keyof typeof ORGS, string, Role]> = [
  ["acme", "alice", "ORG_ADMIN"], ["acme", "bob", "TEAM_LEAD"], ["acme", "carol", "MEMBER"],
  ["acme", "dave", "VIEWER"], ["acme", "erin", "AUDITOR"], ["acme", "gina", "MEMBER"],
  ["globex", "frank", "ORG_ADMIN"], ["globex", "gina", "TEAM_LEAD"],
];
const TEAM_ROWS: Array<[keyof typeof ORGS, keyof typeof TEAMS, string]> = [
  ["acme", "acmeSupport", "Support"], ["acme", "acmeBilling", "Billing"], ["globex", "globexOps", "Operations"],
];
const TEAM_MEMBERS: Array<[keyof typeof ORGS, keyof typeof TEAMS, string, Role]> = [
  ["acme", "acmeSupport", "bob", "TEAM_LEAD"], ["acme", "acmeSupport", "carol", "MEMBER"],
  ["acme", "acmeSupport", "dave", "VIEWER"], ["acme", "acmeBilling", "gina", "MEMBER"],
  ["globex", "globexOps", "gina", "TEAM_LEAD"],
];

async function main(): Promise<void> {
  for (const u of USERS) {
    const email = `${u.handle}@${DOMAIN}`;
    await withTenant({ userId: u.id, loginEmail: email }, (tx) =>
      tx.user.upsert({ where: { email }, create: { id: u.id, email, name: u.name }, update: { name: u.name } }),
    );
  }
  for (const [key, organizationId] of Object.entries(ORGS)) {
    const name = key === "acme" ? "Acme Support Co" : "Globex Operations";
    await withTenant({ organizationId }, async (tx) => {
      await tx.organization.upsert({ where: { id: organizationId }, create: { id: organizationId, name }, update: { name } });
    });
  }
  for (const [org, handle, role] of MEMBERSHIPS) {
    const organizationId = ORGS[org];
    await withTenant({ organizationId }, (tx) =>
      tx.membership.upsert({
        where: { organizationId_userId: { organizationId, userId: uid(handle) } },
        create: { organizationId, userId: uid(handle), role },
        update: { role },
      }),
    );
  }
  for (const [org, team, name] of TEAM_ROWS) {
    const organizationId = ORGS[org];
    await withTenant({ organizationId }, (tx) =>
      tx.team.upsert({
        where: { id: TEAMS[team] },
        create: { id: TEAMS[team], organizationId, name },
        update: { name },
      }),
    );
  }
  for (const [org, team, handle, role] of TEAM_MEMBERS) {
    const organizationId = ORGS[org];
    await withTenant({ organizationId }, (tx) =>
      tx.teamMember.upsert({
        where: { teamId_userId: { teamId: TEAMS[team], userId: uid(handle) } },
        create: { organizationId, teamId: TEAMS[team], userId: uid(handle), role },
        update: { role },
      }),
    );
  }
  console.log(`Seeded ${USERS.length} synthetic users, ${Object.keys(ORGS).length} orgs (login as <handle>@${DOMAIN}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "seed failed");
  process.exit(1);
});
