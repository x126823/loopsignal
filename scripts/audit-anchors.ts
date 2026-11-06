// Audit anchors by hand (docs/runbooks/audit-chain.md). Needs AUDIT_ANCHOR_KEY, which must NOT be stored with the database.
//   npm run ops:audit-anchors -- emit                       print a signed anchor for every organization (JSON lines); save them OUTSIDE the database
//   npm run ops:audit-anchors -- verify --file <anchors>    check every saved anchor against the live audit logs; exit 1 on any mismatch
// An anchor holds an organization id, a sequence number and a hash, never content.
import { existsSync } from "node:fs";
import { currentAnchors, readAnchorFile, verifyAnchors } from "../src/modules/retention";

async function main(): Promise<void> {
  const key = process.env["AUDIT_ANCHOR_KEY"];
  if (!key || key.length < 32) throw new Error("Set AUDIT_ANCHOR_KEY (32 or more characters)");
  const [command] = process.argv.slice(2);
  if (command === "emit") {
    const anchors = await currentAnchors(key);
    for (const a of anchors) console.log(JSON.stringify(a));
    console.error(JSON.stringify({ event: "anchors.emitted", organizations: anchors.length }));
  } else if (command === "verify") {
    const i = process.argv.indexOf("--file");
    const file = i >= 0 ? process.argv[i + 1] : undefined;
    if (!file || !existsSync(file)) throw new Error("Usage: verify --file <existing anchor file>");
    const { anchors, malformed } = readAnchorFile(file);
    const result = await verifyAnchors(key, anchors);
    for (const f of result.failures) console.error(`MISMATCH  organization ${f.organizationId}  sequence ${f.seq}  ${f.check}`);
    console.log(JSON.stringify({ event: "anchors.verified", checked: result.checked, invalid: result.invalid, malformedLines: malformed, mismatches: result.failures.length }));
    if (result.failures.length > 0) process.exit(1);
  } else {
    throw new Error("Usage: emit | verify --file <anchor file>");
  }
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e.message); process.exit(1); });
