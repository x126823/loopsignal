# Architecture

## 1. Style

Modular monolith: one Next.js application plus one BullMQ worker process built from the same codebase. Postgres is the system of record; Redis holds queues and short-lived locks.

```
Browser ── Next.js (UI, route handlers, server actions) ──┐
Webhooks (Pub/Sub, Chat) ─────────────────────────────────┤
                                                          ▼
                              Module public APIs (src/modules/*)
                                                          ▲
                          BullMQ worker (src/workers) ────┘
                                   │
                    PostgreSQL (Prisma + RLS)    Redis
```

## 2. Modules

| Module | Responsibility |
|---|---|
| identity | Authentication (Auth.js), RBAC policies, permission checks |
| tenancy | Organizations, teams, memberships |
| sources | Source connections, monitored sources, cursors, subscriptions |
| ingestion | Fetch/receive, store raw events, normalize, dedupe, enqueue analysis |
| lifecycle | State machine, transitions, approvals, ownership, reopen; **sole writer of item state** |
| intelligence | LLM provider abstraction; 8 analyzers; guards; AnalysisRun persistence |
| sla | Policies, business calendars, timers, breach scan |
| notifications | In-app/email notifications, preferences |
| reporting | Dashboards, metrics, snapshots |
| audit | Append-only audit log, hash chain |
| integrations | Gmail and Google Chat adapters (fetch + normalize only) |

Rules: modules import each other only via `index.ts`; lint boundaries enforce it; no cross-module table access.

## 3. Data flow

1. **Ingest:** adapter fetches or receives an event → store `RawEvent` (immutable, hashed) → normalize to `Message` → dedupe on `(org, provider, externalMessageId)` → enqueue `analyze-message`.
2. **Analyze:** Intent Classifier decides actionable or not. If actionable, the Ownership Resolver runs. Correlation Analyzer checks for an existing `TrackedItem` (same thread, or cross-channel candidate).
3. **Apply:** the worker calls `lifecycle.propose(...)` with the recommendation. The engine validates and either applies the transition, queues an `ApprovalRequest`, or creates a `ReviewTask`.
4. **Follow-up messages** on a tracked thread run Ack Detector, Substantive Response Analyzer, Progress Analyzer, Resolution Analyzer as appropriate.
5. **Timers:** SLA engine maintains `SlaTimer` rows; a repeatable job flags warnings and breaches; SLA Risk Analyzer produces advisory risk scores.

## 4. Lifecycle engine

States: `RECEIVED, ACKNOWLEDGED, RESPONDED, IN_PROGRESS, RESOLUTION_PROPOSED, RESOLUTION_CONFIRMED, CLOSED, REOPENED`. Side flags: `NOT_ACTIONABLE`, `NEEDS_REVIEW`.

| From | To | Actor | Approval |
|---|---|---|---|
| (new) | RECEIVED | system | none (low confidence → review) |
| RECEIVED | ACKNOWLEDGED | system (rule-verified AI rec) | none |
| RECEIVED, ACKNOWLEDGED | RESPONDED | system, confidence ≥ threshold | review if below |
| RECEIVED, ACKNOWLEDGED, RESPONDED | IN_PROGRESS | system | none |
| RESPONDED, IN_PROGRESS | RESOLUTION_PROPOSED | system or human | none (proposal only) |
| RESOLUTION_PROPOSED | IN_PROGRESS | system (customer pushback) or human (rejecting the approval) | none |
| RESOLUTION_PROPOSED | RESOLUTION_CONFIRMED | **human only** | required |
| RESOLUTION_CONFIRMED | CLOSED | **human only**, authorized role | required |
| CLOSED, RESOLUTION_CONFIRMED | REOPENED | human, or system suggestion | auto-reopen only suggests |
| REOPENED | ACKNOWLEDGED, RESPONDED, IN_PROGRESS | as above | as above |

Added in Sprint 3: `RESOLUTION_PROPOSED -> IN_PROGRESS`, so a rejected or contradicted proposal has a way forward.

Invariants:
- Transition table is data (`src/modules/lifecycle/transitions.ts`), unit-tested exhaustively over all 64 state pairs, and integration-tested for every pair against every actor type.
- State change + `LifecycleEvent` + `AuditLog` commit in one transaction.
- Optimistic concurrency via `version` on `TrackedItem`; each `LifecycleEvent` has a per-item `seq` (equal to the version after it) that is the canonical replay order, unique per item, so concurrent writers cannot both win.
- Each event records actor (user, system, or analyzer), evidence, `AnalysisRun` id, and reason.
- Metrics derive from events (`deriveMetrics`): `ackAt`, `firstSubstantiveResponseAt`, `resolvedAt` (confirmation, not proposal), `closedAt`. A reopen starts a new cycle: item-level metrics describe the current cycle, prior cycles stay in the event stream. `verifyItemMetrics` recomputes from events and reports drift.

### Engine API (`src/modules/lifecycle`)

Every function takes the caller's tenant transaction. Deterministic problems return a typed outcome and write nothing; only a lost race throws `LifecycleConflictError` (the transaction rolls back; the caller may retry). Authorization failures throw `ForbiddenError`.

| Function | Who | Behavior |
|---|---|---|
| `createItem` | system or analyzer | Creates the item at `RECEIVED` with its first event, origin link, owner and audit row. Returns `EXISTS` if the thread already has an open item (rule 9). A low-confidence analyzer creation is tracked but flagged `needsReview` with a review task. |
| `propose` | system or analyzer | Validates and either applies, queues an `ApprovalRequest`, or queues a `ReviewTask`. Confirm, close and reopen are only ever *suggested* (an approval is queued, never applied). Replay-safe: the same analyzer run applies once; an item already in the target state is a `NOOP`. |
| `apply` | authorized human | Performs a transition after an RBAC check on the item's team (`item:act`, `item:confirm`, `item:close`, with the org's `approvalMinRole`). Human-only transitions write an `APPROVED` request, resolving a pending one if present. |
| `decideApproval` | authorized human | Approve performs the transition as that human. Reject records it; rejecting a pending confirmation returns the item to `IN_PROGRESS`. |
| `assignOwner` | authorized human | Assigns or clears the owner (history in `ItemOwnership`); does not touch state or version. |

Outcomes: `APPLIED`, `APPROVAL_REQUIRED`, `NEEDS_REVIEW`, `NOOP`, `REJECTED` (with a reason such as `ILLEGAL_TRANSITION`, `INVALID_ACTOR`, `OUT_OF_ORDER`, `FUTURE_TIMESTAMP`, `STALE_VERSION`, `THREAD_HAS_OPEN_ITEM`).

Analyzer recommendations are untrusted (rule 6). The engine requires a real `AnalysisRun` of the same organization, a confidence in [0, 1] at or above the threshold (default 0.8, overridable at `Organization.settings.lifecycle.confidenceThreshold`), and at least one evidence quote that is a verbatim substring of the decrypted triggering message. Anything else becomes `NEEDS_REVIEW`: state does not move. `occurredAt` is the event time (a message's `sentAt`), must not precede the previous event or be in the future (5 minute skew), so metrics reflect when things happened, not when they were processed.

### Enforcing rule 1

Only `src/modules/lifecycle` writes `TrackedItem`. Two backstops: an ESLint rule bans `trackedItem` writes and the guard flag name everywhere else (tests are exempt; their fixtures open the guard explicitly), and a database trigger rejects inserts and changes to `state`, the four metric timestamps, `reopenCount` and `version` unless the transaction-local flag `app.lifecycle_writer` is on. The engine opens the flag only around its own writes and closes it again. This catches bugs and stray writes; it is not a security boundary, since code holding the app connection could set the flag in raw SQL.

## 4b. Ingestion and queues

```
BullMQ ingest-source ──► syncSource ──► adapter.fetch (no transaction)
                                         │
                       one transaction per page: ingestEvent × N
                         RawEvent (encrypted, hashed, immutable)
                         → normalize → Thread / Participant / Message (find-or-create)
                                         │
                       enqueue analyze-message per message (deterministic job id)
                                         │
                       advance MonitoredSource.cursor (compare-and-set)
```

- **Adapters** (`integrations`) fetch and normalize only. Provider payloads are untrusted: `normalize` validates with Zod and throws `NormalizationError` carrying a stable code, never content. Only the synthetic adapter exists; Gmail and Chat come in Sprints 11 and 12.
- **Idempotent at every step.** Raw events dedupe on `(org, provider, externalId)`, messages on `(org, provider, externalMessageId)`, threads and participants on their natural keys. Inserts use `ON CONFLICT DO NOTHING` then read back, so concurrent replays never abort a transaction or duplicate a row. A message re-sent under a new event id is stored as evidence but not duplicated; an event id re-sent with different content keeps the original (`PAYLOAD_CONFLICT`).
- **Poison events don't block the stream.** A malformed event is stored raw, opens one `SCHEMA_FAILURE` review task, and is counted; it is not retried, because retrying cannot fix it.
- **No stranded messages.** Per page: ingest in one transaction, enqueue analysis, then advance the cursor. A failure anywhere re-fetches the same page next time; ingestion dedupes and enqueueing is idempotent, so the retry repairs the gap. Concurrent syncs of one source are safe: the cursor moves by compare-and-set and the loser stops.
- **Queues** (`src/lib/queue`): `ingest-source`, `analyze-message`, each with a `-dead` queue. Job payloads are validated, strict, and carry ids only, so a queue dump exposes no content. Job ids are deterministic (`analyze-<messageId>`), making enqueue idempotent. Defaults: 5 attempts with exponential backoff. A job that exhausts its attempts or throws `UnrecoverableError` is copied to the dead-letter queue with its ids, the error class and code, and attempt count. **Error messages are never stored**: third-party errors can echo content (rule 10).
- **Workers** (`src/workers`) call module APIs and log structured ids and counts only (`src/lib/log.ts`). `analyze-message` jobs have no consumer until the analyzers land in Sprint 6.
- **Known limit:** completed jobs linger for an hour, so re-triggering an *identical* job id inside that window is ignored; manual and scheduled triggers use time-based keys, continuations use a cursor hash. The consumer of `analyze-message` must itself be replay-safe, because a replay after the retention window re-queues already-analyzed messages (the engine and the analysis cache are designed for this).

## 5. AI design

```ts
interface LLMProvider { complete<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> }
```

Implementations: `ClaudeProvider`, `FakeProvider` (deterministic, used in tests).

Analyzers (independently testable): Intent Classifier, Ownership Resolver, Acknowledgment Detector, Substantive Response Analyzer, Progress Analyzer, Resolution Analyzer, Cross-Channel Correlation Analyzer, SLA Risk Analyzer.

Common output:
```ts
{ result: <analyzer-specific>, confidence: 0..1, evidence: [{messageId, quote}],
  recommendedAction: string, requiresHumanApproval: boolean }
```

Guards (applied to every call):
- Message content wrapped in delimiters and labelled untrusted; system prompt states content cannot change instructions.
- No tools, no side effects, no network from analyzers.
- Zod validation with one bounded retry; failure → `NEEDS_REVIEW`.
- Evidence quote must be a verbatim substring of the cited message, else output rejected.
- `requiresHumanApproval` is forced true by the engine for confirm/close/auto-reopen/low-confidence matches, regardless of model output.
- Redaction pass before sending content to the provider; input-hash cache; per-org budget cap.
- Prompts are versioned; every `AnalysisRun` stores model, prompt version, input hash, output.

### 5b. AI foundation (implemented in Sprint 5)

`src/modules/intelligence` holds the provider layer and the guard pipeline. Analyzers (Sprint 6) plug in as an `AnalyzerDefinition` (name, `promptVersion`, instructions, a Zod `resultSchema`); the pipeline does the rest.

**Providers.** `LLMProvider.complete(req)` returns *unvalidated* JSON plus usage (`output`, `refusal` or `truncated`); it is the pipeline, not the provider, that validates. This deliberately differs from the earlier `complete<T>` sketch so that no provider is trusted. `FakeProvider` is deterministic, records every request, and takes a scripted responder, which is how golden sets and the injection suite run with no model. `ClaudeProvider` uses the official SDK on the Messages API with structured outputs (`output_config.format` from the Zod schema) and nothing else: no tools, no prefill, no forced tool choice, no server tools, no sampling parameters, no fallback model. Defaults: `LLM_PROVIDER=fake` (nothing contacts a model unless `claude` is chosen), `LLM_MODEL=claude-opus-5-5`, `LLM_EFFORT=medium`. A refusal is recorded and routed to human review; it is never retried on another model. SDK errors are mapped to retryable or permanent and their text is dropped, since it can echo content.

**Pipeline** (`runAnalyzer`), in order: load and decrypt messages, size limits (oversized input is rejected, never truncated), redaction, input hash, cache, budget, delimiting, provider call, Zod validation with one bounded retry, evidence guard, forced human approval, persist. No database transaction is open across the model call.

- *Redaction* removes private keys, JWTs, provider API keys, bearer tokens, credential assignments, Luhn-valid card numbers and SINs, and SSNs before content leaves; counts are kept, values never. It is a safety net, not a guarantee. Emails and ordinary identifiers are left in.
- *Delimiting*: messages sit inside `<untrusted_NONCE>` blocks whose tag names carry a per-input nonce (HMAC of the input hash under a server secret), so an author cannot close the block. Content is never placed in the system prompt, which is byte-identical regardless of what messages say.
- *Evidence*: every quote must be a verbatim substring of the **original** text of a message the analyzer was given, and any action that asserts something must cite at least one. A quote spanning a redaction is rejected.
- *Approval*: `requiresHumanApproval` is forced true for confirm, close and reopen suggestions and for confidence below the threshold, regardless of the model. The lifecycle engine independently refuses to apply those transitions.
- *Cache*: keyed on (organization, analyzer, input hash, prompt version); the hash includes provider, model and the redacted messages, so changing any of them misses. Never shared across organizations.
- *Budget*: a per-organization daily token cap (`LLM_DAILY_TOKEN_BUDGET`, or `Organization.settings.llm.dailyTokenBudget`), summed from `AnalysisRun`. Cached results are still served when it is spent.
- *Persistence*: every attempt writes an `AnalysisRun`. Failures store only a reason (never the raw model output, which can echo content) under a unique throwaway input hash so they never block a later success, and queue a `SCHEMA_FAILURE` review task.

**What the guards guarantee, and what they do not.** With a model that obeys every hostile instruction, injected text cannot: break out of the delimiters or alter the instructions; make an output with fabricated, foreign or missing evidence count; add fields or actions to the output; skip human approval for a human decision; or cause the engine to confirm, close or reopen anything. They do **not** stop a fooled model from recommending a *routine* step (acknowledged, responded, in progress, proposed) with a real quote from the attacker's own message; the engine will apply that if it is legal and the confidence clears the threshold, attributed to the analyzer run and audited. Analyzers (Sprint 6) must reduce this further, for example by considering only outbound messages as acknowledgments. Known limits: the budget is a soft cap (concurrent calls can overshoot by their own size); concurrent identical analyses may each call the provider before one result wins (the stored result is single); per-organization rate limiting belongs at the queue level (Sprint 6); and the provider's data-retention terms have not been reviewed, which is why only synthetic data is used (rule 7).

### 5c. Analyzers 1-4 and the analyze-message worker (implemented in Sprint 6)

Four analyzers are defined in `src/modules/intelligence/analyzers.ts` (each a name, a `promptVersion`, instructions and a strict Zod result schema) and run through the guard pipeline. Bump `promptVersion` on any prompt or schema change.

| Analyzer | Decides | Result |
|---|---|---|
| intent_classifier | Is the last message something we must act on? (inbound only) | `actionable`, `kind`, `priority` |
| ownership_resolver | Does the message explicitly name exactly one team member? | `ownerUserId` (a candidate id or null) |
| acknowledgment_detector | Is our reply only an acknowledgment? | `isAcknowledgment` |
| substantive_response | Does our reply engage with the content? | `isSubstantive` |

No free text is ever stored from a model: the item title is the message's own subject, and results are enums, booleans and ids. Ownership candidates are sent as a name and a mention handle only (never an email address) inside the untrusted block.

**The worker** (`src/workers/analyze-message.ts`) is the only place recommendations meet the lifecycle engine:
- *Inbound message, no item:* classify intent. If actionable, resolve an owner from the source's team and `createItem` (low confidence is flagged by the engine). A source with no team goes to an `OWNERSHIP` review task.
- *Inbound message, thread already CLOSED:* if actionable, **suggest** a reopen. The engine queues an approval and the item stays CLOSED (rule 2).
- *Our reply on an open item:* run both the substantive and acknowledgment analyzers and apply the rules in `analysis-plan.ts`.
- *Ownership is assigned only at creation, and only if* the recommendation is `ASSIGN_OWNER`, the id is a real team member, confidence cleared the threshold, the evidence is the message itself, and the quoted phrase contains that person's handle or first name. Anything else queues an `OWNERSHIP` review task for a human. After creation only humans change the owner.

**Decision rules that hold whatever the model says** (pure functions, tested exhaustively): a message from the outside (INBOUND) can never be our acknowledgment or response; an acknowledgment's or response's evidence must cite the message itself; a reply is RESPONDED only if substantive **and not** an acknowledgment, ACKNOWLEDGED only if an acknowledgment **and not** substantive; if both analyzers say yes they contradict each other and nothing moves, a human looks (a premature RESPONDED would flatter the response-time metric); a recommendation whose action does not match its own result is ignored. Timestamps are when messages were *sent*, not processed.

**Job ordering.** Jobs for one thread run concurrently and in any order. A reply processed before its item existed would otherwise be lost, so once an item is created the worker evaluates the thread's later replies in order. Every step is idempotent (cached analyses, idempotent engine calls), so replays and duplicates change nothing.

**Failures and limits.** A retryable provider error is retried by the queue with backoff; a permanent one is dead-lettered immediately. When the organization's daily budget is spent the job is delayed to 00:05 UTC without using a retry attempt (cached analyses are still served). Throughput is capped per worker process by `ANALYZE_RATE_PER_MINUTE`.

**Golden sets** (`src/modules/intelligence/golden`): labeled synthetic cases per analyzer, run through the same `prepare`/`execute` guards as production with no database. `npm run golden` prints accuracy, precision, recall and a recommended confidence threshold (the lowest at which accepted answers reach 95% precision). The committed baseline `baselines/fake-heuristic-heuristic-1.json` is for the rule-based heuristic and is flagged `notForProduction`: the heuristic was written alongside these small sets (29, 15, 17 and 17 cases), so its scores overstate it and say nothing about a real model. Real baselines and thresholds need `LIVE_LLM=1 npm run golden -- --provider claude --write`, which costs money and should use a larger, independently written set. Until then the placeholder threshold stays at 0.8.

## 6. Multi-tenancy

- `organizationId` on every tenant-owned row.
- All database access goes through `withTenant(ctx, fn)` in `src/lib/db`: one transaction per call that sets transaction-local settings (`set_config(..., true)`) and activates the Prisma tenant-scope extension. Raw SQL is available only on that transaction client, so RLS always applies.
- The extension injects `organizationId` into reads and writes, rejects writes naming another org, and throws when there is no tenant context or the model needs an org the context lacks.
- Postgres RLS is the backstop, keyed on three settings: `app.org_id` (tenant scope), `app.user_id` (own-row access, membership lookup, org switcher) and `app.login_email` (sign-in lookup only). Unset settings evaluate to NULL, so access fails closed.
- Two connections: the owner (`DATABASE_URL`) runs migrations and test cleanup; the app connects as `loopsignal_app` (`APP_DATABASE_URL`), which is not a superuser, not the table owner, and lacks `BYPASSRLS`. Tables use `FORCE ROW LEVEL SECURITY`.
- `User` is global but has its own policies: visible to itself, to the email being signed in, and to members of the active org. Child rows carry composite foreign keys (for example `TeamMember` to `Team` on `(organizationId, id)`) so a row cannot point across tenants.
- Tests (`tests/integration`) assert cross-tenant reads and writes fail, once against RLS alone and once through the extension.

### Audit

`recordAudit(tx, entry)` (module `audit`) appends to `AuditLog` inside the caller's transaction, so the audit row commits or rolls back with the change it records. Metadata keys that look like content or secrets (`body`, `subject`, `token`, `password`, and similar) are rejected (rule 10). The database assigns `seq` and the hash chain; `verifyAuditChain` checks it. Tenancy mutations (`addMembership`, `changeMembershipRole`, `createTeam`, `addTeamMember`) are authorized with `assertCan` and audited this way, and the last `ORG_ADMIN` cannot be demoted.

## 7. Authorization

Roles: `ORG_ADMIN`, `TEAM_LEAD`, `MEMBER`, `VIEWER`, `AUDITOR`. Deny by default; policies are functions in `identity` and checked server-side on every action. Confirm and close require `MEMBER` on the owning team or higher, as configured per org (`approvalMinRole`). Org-level `VIEWER` and `AUDITOR` are capped at read-only regardless of team role. Principals are built from `Membership` and `TeamMember` rows (`resolvePrincipal`), never from the JWT.

Authentication is Auth.js with JWT sessions carrying only the user id. Sign-in is invite-only: Google succeeds only for a verified email that already has a `User` row. A dev credentials provider accepts only `@synthetic.loopsignal.test` users and is refused in production.

## 8. SLA engine

`SlaPolicy` (per team/source/priority) defines targets for ack, first substantive response, resolution, and closure, with a `BusinessCalendar`. Timers are rows with `dueAt`; a repeatable job scans for warn/breach. Time is injected via a `Clock` interface for deterministic tests.

## 9. Observability

Structured logs (no content), request and job IDs, metrics on queue depth, analyzer latency and cost, review-queue size. Content never goes to logs or error trackers.

## 10. Deployment (initial)

Docker Compose: `app`, `worker`, `postgres`, `redis`. Single-org PoC; configuration via validated env vars.
