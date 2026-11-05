import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import { getEnv } from "../env";
import { log } from "../log";
import { redisConnection } from "./connection";
import { JOB_SCHEMAS, type DeadLetterRecord, type QueueName } from "./jobs";

/** Retries with exponential backoff; failed jobs that exhaust them (or are unrecoverable) go to a dead-letter queue. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export const deadLetterName = (queue: QueueName) => `${queue}-dead` as const;

export interface QueueConfig {
  redisUrl: string;
  prefix: string;
  /** Overrides for tests (fast backoff). */
  jobOptions?: JobsOptions;
}

export function configFromEnv(): QueueConfig {
  const env = getEnv();
  return { redisUrl: env.REDIS_URL, prefix: env.QUEUE_PREFIX };
}

/** Owns the Queue instances for one Redis namespace. */
export class QueueHub {
  private queues = new Map<string, Queue>();
  constructor(readonly config: QueueConfig = configFromEnv()) {}

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redisConnection(this.config.redisUrl), prefix: this.config.prefix });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Validate the payload (ids only) and enqueue idempotently by `jobId`. */
  async enqueue(name: QueueName, data: unknown, jobId: string): Promise<{ jobId: string }> {
    const parsed = JOB_SCHEMAS[name].parse(data);
    await this.queue(name).add(name, parsed, { ...DEFAULT_JOB_OPTIONS, ...this.config.jobOptions, jobId });
    return { jobId };
  }

  worker<T>(name: QueueName, processor: Processor<T>, opts: Partial<WorkerOptions> = {}): Worker<T> {
    const worker = new Worker<T>(name, processor, {
      connection: redisConnection(this.config.redisUrl),
      prefix: this.config.prefix,
      concurrency: 2,
      ...opts,
    });
    this.attachDeadLetter(name, worker);
    worker.on("error", (err) => log("error", "worker.error", { queue: name, errorName: err.name }));
    return worker;
  }

  /** Move jobs that will never run again (attempts exhausted, or unrecoverable) to `<queue>-dead`. */
  private attachDeadLetter(name: QueueName, worker: Worker): void {
    worker.on("failed", (job: Job | undefined, err: Error) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!exhausted && !(err instanceof UnrecoverableError)) return; // will be retried
      const code = (err as { code?: unknown }).code;
      const record: DeadLetterRecord = {
        queue: name,
        jobId: job.id ?? null,
        data: job.data as Record<string, unknown>,
        errorName: err.name,
        errorCode: typeof code === "string" ? code : null,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      };
      void this.queue(deadLetterName(name))
        .add("dead", record, { jobId: `dead-${job.id ?? "unknown"}`, removeOnComplete: false, removeOnFail: false })
        .then(() => log("warn", "job.dead_lettered", { queue: name, jobId: job.id ?? null, errorName: err.name, attemptsMade: job.attemptsMade }))
        .catch((e: Error) => log("error", "job.dead_letter_failed", { queue: name, errorName: e.name }));
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

let shared: QueueHub | undefined;
/** Process-wide hub configured from the environment. */
export function queueHub(): QueueHub {
  shared ??= new QueueHub();
  return shared;
}
export async function closeQueueHub(): Promise<void> {
  await shared?.close();
  shared = undefined;
}

export { UnrecoverableError };
