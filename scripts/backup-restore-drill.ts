// Run the backup and restore drill against the configured database. Exits 1 if any check fails. See docs/runbooks/backup-restore.md.
//   npm run drill:restore
import { runDrill } from "./drill/backup-restore";

runDrill().then((report) => {
  for (const c of report.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  console.log(JSON.stringify({ event: "drill.done", ok: report.ok, dumpBytes: report.dumpBytes, seconds: report.seconds }));
  process.exit(report.ok ? 0 : 1);
}).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
