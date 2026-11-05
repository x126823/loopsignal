// Queue a sync of the seeded synthetic ingest mailbox. Usage: npm run ingest:synthetic -- [organizationId]
// Only the dedicated "synthetic-inbox" source is synced, so the seeded scenario sources stay untouched.
import { closeQueueHub, queueHub } from "../src/lib/queue";
import { enqueueOrganizationSync } from "../src/modules/ingestion";

const ACME = "00000000-0000-4000-8000-000000000001"; // seeded synthetic organization
const organizationId = process.argv[2] ?? ACME;

enqueueOrganizationSync(organizationId, queueHub(), `manual-${Date.now()}`, { externalIdPrefix: "synthetic-inbox" })
  .then((ids) => console.log(`Queued sync for ${ids.length} source(s). Run \`npm run worker\` to process them.`))
  .catch((e: Error) => { console.error(e.name); process.exitCode = 1; })
  .finally(() => closeQueueHub());
