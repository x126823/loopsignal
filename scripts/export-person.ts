// Export everything held about one person (subject access) to a FILE. The file contains message text, so it is created readable by its owner
// only, refuses to overwrite anything, and the command prints counts and the path, never content. Run as an organization administrator so the
// audit log attributes it. See docs/runbooks/retention.md.
//   npm run ops:export-person -- --org <organizationId> --participant <participantId> --as <adminUserId> --out <new file path>
import { closeSync, openSync, writeSync } from "node:fs";
import { resolvePrincipal } from "../src/modules/identity";
import { exportPerson } from "../src/modules/retention";

const get = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const [org, participantId, adminId, out] = [get("org"), get("participant"), get("as"), get("out")];
  if (!org || !participantId || !adminId || !out) throw new Error("Usage: --org <id> --participant <id> --as <adminUserId> --out <new file path>");
  const principal = await resolvePrincipal(adminId, org);
  if (!principal || principal.orgRole !== "ORG_ADMIN") throw new Error("--as must be an administrator of that organization");
  const data = await exportPerson(principal, { participantId });
  if (!data) throw new Error("No such participant in that organization");
  // 'wx': fail if the path exists. Mode 0600: only the current user can read it.
  const fd = openSync(out, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(data, null, 2)); } finally { closeSync(fd); }
  console.log(JSON.stringify({ event: "export.done", participantId, messages: data.messages.length, itemsStarted: data.itemsStarted.length, truncated: data.truncated, file: out }));
  console.log("The file holds message text. Hand it over through a channel you trust, then delete it.");
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e.message); process.exit(1); });
