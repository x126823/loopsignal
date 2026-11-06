// Run one retention pass now, for every organization (or one), instead of waiting for the daily job. See docs/runbooks/retention.md.
//   npm run ops:retention                       all organizations
//   npm run ops:retention -- --org <id>         one organization
// Prints counts only. Removing content is irreversible: check the windows on the Retention page first.
import { runRetention } from "../src/modules/retention";
import { listAllOrganizationIds } from "../src/lib/db";
import { handleRetention } from "../src/workers/maintenance";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const org = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (!org || !(await listAllOrganizationIds()).includes(org))) throw new Error("Unknown organization id");
  const result = org ? { organizations: 1, ...(await runRetention(org)) } : await handleRetention();
  console.log(JSON.stringify({ event: "retention.manual", ...result }));
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e.message); process.exit(1); });
