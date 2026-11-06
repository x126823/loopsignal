// Create the first organization, its administrator and a default team in a NEW database. LoopSignal sign-in is invite-only: a person can sign in
// only if a user row with their email already exists, so the first administrator has to be created once, by the operator, like this.
//   npm run real:first-admin -- --email you@gmail.com --name "Your Name" --org "My Mail" [--team Inbox]
// Use the email of the Google account you will sign in with. It refuses to run twice for the same person.
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../src/lib/db";
import { resolvePrincipal } from "../src/modules/identity";
import { createOrganization, createTeam } from "../src/modules/tenancy";

const get = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const email = get("email")?.trim().toLowerCase();
  const name = get("name")?.trim();
  const orgName = get("org")?.trim();
  const teamName = get("team")?.trim() || "Inbox";
  if (!email || !name || !orgName) throw new Error('Usage: --email <google account email> --name "<your name>" --org "<organization name>" [--team <team name>]');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new Error("--email is not a valid email address");
  if (name.length > 200 || orgName.length > 200 || teamName.length > 200) throw new Error("names must be 200 characters or fewer");

  const owner = createPrismaClient(process.env["DATABASE_URL"]!); // the owner, only to create the user row (the application role may not create other people)
  try {
    const existing = await owner.user.findUnique({ where: { email }, include: { memberships: true } });
    if (existing && existing.memberships.length > 0) throw new Error("That person is already set up in an organization. Nothing was changed.");
    const user = existing ?? (await owner.user.create({ data: { id: randomUUID(), email, name } }));
    const org = await createOrganization({ name: orgName, adminUserId: user.id }); // audited: the user becomes ORG_ADMIN in the same transaction
    const principal = await resolvePrincipal(user.id, org.id);
    if (!principal) throw new Error("The administrator could not be resolved after creation");
    const team = await createTeam(principal, { name: teamName });
    console.log(JSON.stringify({ event: "first-admin.created", organizationId: org.id, userId: user.id, teamId: team.id }));
    console.log(`Done. Sign in at your AUTH_URL with the Google account ${email}.`);
  } finally {
    await owner.$disconnect();
  }
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e.message); process.exit(1); });
