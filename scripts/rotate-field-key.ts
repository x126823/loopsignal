// Re-encrypt everything stored under FIELD_ENCRYPTION_KEY with a new key. Run it with the application and workers STOPPED (see
// docs/runbooks/key-rotation.md): nothing may write under the old key while it runs.
//
//   ROTATE_FROM_KEY=<old base64> ROTATE_TO_KEY=<new base64> npm run ops:rotate-key [-- --dry-run]
//
// It is idempotent and resumable (blobs already under the new key are skipped), changes only ciphertext, never logs a key or any content,
// and exits non-zero if any value could not be opened with either key (those are left untouched). Finish by switching FIELD_ENCRYPTION_KEY
// to the new key, then re-run it once to confirm that everything reports "already current".
import { parseFieldKey } from "../src/lib/crypto/fields";
import { listAllOrganizationIds } from "../src/lib/db";
import { rekeyMessageContent } from "../src/modules/ingestion";
import { rekeyClaims, rekeyCredentials } from "../src/modules/sources";

async function main(): Promise<void> {
  const fromRaw = process.env["ROTATE_FROM_KEY"];
  const toRaw = process.env["ROTATE_TO_KEY"];
  if (!fromRaw || !toRaw) throw new Error("Set ROTATE_FROM_KEY and ROTATE_TO_KEY (base64 of 32 bytes each)");
  const from = parseFieldKey(fromRaw);
  const to = parseFieldKey(toRaw);
  if (from.equals(to)) throw new Error("The old and new keys are the same");
  const dryRun = process.argv.includes("--dry-run");
  const totals = { rewritten: 0, alreadyCurrent: 0, failed: 0 };
  const add = (c: { rewritten: number; alreadyCurrent: number; failed: number }) => { totals.rewritten += c.rewritten; totals.alreadyCurrent += c.alreadyCurrent; totals.failed += c.failed; };

  for (const organizationId of await listAllOrganizationIds()) {
    if (dryRun) continue;
    const m = await rekeyMessageContent(organizationId, from, to);
    add(m.bodies); add(m.rawEvents);
    add(await rekeyCredentials(organizationId, from, to));
    add(await rekeyClaims(organizationId, from, to));
    console.log(JSON.stringify({ event: "rotate.organization", organizationId, bodies: m.bodies, rawEvents: m.rawEvents }));
  }
  console.log(JSON.stringify({ event: "rotate.done", dryRun, ...totals }));
  if (totals.failed > 0) {
    console.error("Some values opened with neither key and were left untouched. Do NOT switch the key until this is understood.");
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e: Error) => {
  console.error(e.message); // key-parse errors never include key material
  process.exit(1);
});
