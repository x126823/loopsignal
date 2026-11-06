// List or retry dead-lettered jobs. They hold ids and an error class only (never content), so the output is safe to paste into a ticket.
//   npm run ops:dead-letters                              list every dead letter
//   npm run ops:dead-letters -- --queue ingest-source     only one queue
//   npm run ops:dead-letters -- --retry <queue> <deadId>  put one back on its queue
import { closeQueueHub, listDeadLetters, queueHub, retryDeadLetter, JOB_SCHEMAS, type QueueName } from "../src/lib/queue";

async function main(): Promise<void> {
  const hub = queueHub();
  const args = process.argv.slice(2);
  const known = (q: string | undefined): q is QueueName => q !== undefined && Object.hasOwn(JOB_SCHEMAS, q);
  if (args[0] === "--retry") {
    const [, queue, deadId] = args;
    if (!known(queue) || !deadId) throw new Error(`Usage: --retry <queue: ${Object.keys(JOB_SCHEMAS).join("|")}> <deadId>`);
    console.log(JSON.stringify({ queue, deadId, outcome: await retryDeadLetter(hub, queue, deadId) }));
  } else {
    const queue = args[0] === "--queue" ? args[1] : undefined;
    if (queue !== undefined && !known(queue)) throw new Error(`Unknown queue ${queue}`);
    const rows = await listDeadLetters(hub, queue as QueueName | undefined);
    for (const r of rows) console.log(JSON.stringify({ queue: r.queue, deadId: r.deadId, jobId: r.jobId, error: r.errorName, code: r.errorCode, attempts: r.attemptsMade, failedAt: r.failedAt, data: r.data }));
    console.log(JSON.stringify({ event: "dead-letters", count: rows.length }));
  }
  await closeQueueHub();
}
main().catch((e: Error) => { console.error(e.message); process.exit(1); });
