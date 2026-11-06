# Queues and dead letters

Background work runs on BullMQ (Redis): ingestion, analysis, SLA scan and risk, correlation follow-up, the Gmail and Chat scans, retention and audit verification. A job carries **ids only**, so a queue dump or a dead letter exposes no content.

| Queue | Does | Schedule |
|---|---|---|
| `ingest-source` | Reads new messages from one mailbox, space or synthetic source | Queued by the scans, Pub/Sub push, and **Sync now** |
| `analyze-message` | Classifies one message and proposes (never decides) the next step | Queued per ingested message |
| `sla-scan` / `sla-risk` | Re-derives timers and detects breaches; advisory risk hints | Every 60 s |
| `correlation-follow-up` | After a person decides a cross-channel match | On decision |
| `gmail-scan` / `chat-scan` | Queue a sync of each active mailbox or space | Every 3 min, only while enabled |
| `retention` / `audit-verify` | Remove content that is due; verify audit chains | Daily |

Every queue has a `<name>-dead` queue. A job lands there after 5 attempts (exponential backoff) or when it can never succeed.

## Inspect and retry dead letters

```
npm run ops:dead-letters                               # list all: queue, deadId, error class, attempts, ids
npm run ops:dead-letters -- --queue ingest-source      # one queue
npm run ops:dead-letters -- --retry <queue> <deadId>   # put one back
```
The output has ids and the error **class** only (error texts are dropped on purpose because third parties echo content into them), so it is safe to paste into a ticket. Retrying re-validates the payload, queues it under a fresh id, and removes the dead letter only after the queue accepted it; a payload that no longer validates is refused and left in place.

Before retrying, understand why it died: `ProviderApiError` / `ProviderRateLimitError` are transient (retry once the provider recovers); `NormalizationError` means a malformed provider event (a review task already exists for it; retrying cannot help); `UnrecoverableError` for a provider with no adapter means a flag is off.

## Common situations

- **Analysis "deferred".** The organization's daily LLM token budget (default 2,000,000) is spent; jobs wait until the window rolls over and are not lost. Raise it per organization in `Organization.settings.llm.dailyTokenBudget` or globally with `LLM_DAILY_TOKEN_BUDGET`. The load test (3,000 messages, offline provider) used about 4.5 million tokens: size the budget to real volume.
- **Pages fail with "Unable to start a transaction in the given time".** The database connection pool is exhausted. A page makes several short transactions, so concurrent users queue for connections. Raise `DB_POOL_MAX` (default 20) and, if brief queueing is acceptable, `DB_TX_MAX_WAIT_MS` (default 10 s), keeping `(web + worker processes) x DB_POOL_MAX` under Postgres `max_connections`. Found by the load test in Sprint 13: at the old default (10) twenty concurrent users failed 94% of requests.
- **Two messages of one conversation analysed at the same moment** can collide on the item (`LifecycleConflictError`, optimistic concurrency). The job retries and succeeds; seeing a few is normal. The load test reports the count.
- **Backlog growing.** Check the worker is running and not rate limited (`ANALYZE_RATE_PER_MINUTE`, default 60 per worker); analysis is the slow step (see the capacity numbers in [Load test](load-test.md)). Add worker processes before raising the limit; jobs are idempotent and safe to run concurrently.
- **Redis lost.** Queue state is lost, not data. Ingestion resumes from each source's stored cursor, SLA and analysis re-derive; press **Sync now** on connections. Re-register schedules by restarting the worker.
