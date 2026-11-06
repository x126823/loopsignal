// Carry out an erasure request for one person (subject rights). See docs/runbooks/retention.md. It runs AS an organization administrator, so the
// action is attributed to them in the audit log, and it prints counts only.
//   npm run ops:erase-person -- --org <organizationId> --participant <participantId> --as <adminUserId> --yes
// Without --yes it only checks that the person and the administrator exist. Erasure removes message text, raw payloads, quotes and the name; it cannot be undone.
import { withTenant } from "../src/lib/db";
import { resolvePrincipal } from "../src/modules/identity";
import { erasePerson } from "../src/modules/retention";

const get = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const [org, participantId, adminId] = [get("org"), get("participant"), get("as")];
  if (!org || !participantId || !adminId) throw new Error("Usage: --org <id> --participant <id> --as <adminUserId> [--yes]");
  const principal = await resolvePrincipal(adminId, org);
  if (!principal || principal.orgRole !== "ORG_ADMIN") throw new Error("--as must be an administrator of that organization");
  const exists = await withTenant({ organizationId: org, userId: adminId }, (tx) => tx.participant.findFirst({ where: { id: participantId }, select: { id: true } }));
  if (!exists) throw new Error("No such participant in that organization");
  if (!process.argv.includes("--yes")) { console.log(JSON.stringify({ event: "erase.dry-run", participantId, ready: true })); return; }
  console.log(JSON.stringify({ event: "erase.done", participantId, ...(await erasePerson(principal, { participantId })) }));
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e.message); process.exit(1); });
