import { z } from "zod";

/**
 * Job payloads carry ids only, never message content, so a queue dump or a dead-letter inspection exposes
 * nothing sensitive (rule 10). Handlers re-read what they need from the database inside a tenant transaction.
 */
const uuid = z.string().uuid();

export const QUEUES = {
  ingestSource: "ingest-source",
  analyzeMessage: "analyze-message",
  slaScan: "sla-scan",
  slaRisk: "sla-risk",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ingestSourceJob = z.object({ organizationId: uuid, monitoredSourceId: uuid }).strict();
export type IngestSourceJob = z.infer<typeof ingestSourceJob>;

export const analyzeMessageJob = z.object({ organizationId: uuid, messageId: uuid }).strict();
export type AnalyzeMessageJob = z.infer<typeof analyzeMessageJob>;

/** The scan carries no data: it discovers organizations itself. */
export const slaScanJob = z.object({}).strict();
export type SlaScanJob = z.infer<typeof slaScanJob>;

export const slaRiskJob = z.object({ organizationId: uuid, itemId: uuid, timerId: uuid }).strict();
export type SlaRiskJob = z.infer<typeof slaRiskJob>;

export const JOB_SCHEMAS = {
  [QUEUES.ingestSource]: ingestSourceJob,
  [QUEUES.analyzeMessage]: analyzeMessageJob,
  [QUEUES.slaScan]: slaScanJob,
  [QUEUES.slaRisk]: slaRiskJob,
} as const;

/** Deterministic job ids make enqueueing idempotent: BullMQ ignores an add whose id already exists. No ":" allowed. */
export const jobIds = {
  /** `key` distinguishes triggers: a cursor hash for continuations, a timestamp for manual or scheduled runs. */
  ingestSource: (j: IngestSourceJob, key: string) => `ingest-${j.monitoredSourceId}-${key}`,
  analyzeMessage: (j: AnalyzeMessageJob) => `analyze-${j.messageId}`,
  /** One risk assessment per timer that enters its warning window. */
  slaRisk: (j: SlaRiskJob) => `sla-risk-${j.timerId}`,
};

/** What lands in a dead-letter queue: ids and the error class only. Error messages can echo content, so they are dropped. */
export const deadLetterRecord = z.object({
  queue: z.string(),
  jobId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  errorName: z.string(),
  errorCode: z.string().nullable(),
  attemptsMade: z.number().int(),
  failedAt: z.string(),
});
export type DeadLetterRecord = z.infer<typeof deadLetterRecord>;
