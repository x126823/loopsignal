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
2. **Analyze:** Intent Classifier decides actionable or not. If actionable, the Ownership Resolver runs. The Correlation step checks for an existing `TrackedItem` (same thread, a thread a person attached, or a cross-channel candidate that a person must decide; section 5d).
3. **Apply:** the worker calls `lifecycle.propose(...)` with the recommendation. The engine validates and either applies the transition, queues an `ApprovalRequest`, or creates a `ReviewTask`.
4. **Follow-up messages** on a tracked thread run Ack Detector, Substantive Response Analyzer, Progress Analyzer, Resolution Analyzer as appropriate.
5. **Timers:** SLA engine derives `SlaTimer` rows from lifecycle events; a repeating scan flags warnings and breaches (section 8); the SLA Risk Analyzer produces advisory risk hints.

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

## 4c. Human decisions (the web UI, Sprint 7)

Pages: sign-in (`/login`), Approvals (what is waiting for a person), Items, an item page (decisions, conversation, history, the four metrics, AI recommendations, ownership) and the Review queue. Built with hand-rolled shadcn-style primitives on Tailwind and `class-variance-authority`; no component-library dependency.

**Security model.** Server functions can be POSTed to directly, and layouts do not re-render on navigation, so protection is not left to a layout or the proxy. Every page and every server action calls `requireContext()` (`src/app/_lib/session.ts`), which resolves the user and their role **from the database** on each request, never from the token. The active organization is a cookie that is validated against the user's real memberships every time. Every server action then (1) validates its form with Zod and treats hidden fields (ids, expected version) as untrusted, (2) calls the lifecycle engine, which independently re-checks legality and permission with the same `can()` as everywhere else, and (3) reports the result through a fixed vocabulary of notice keys, so a URL can never make the page display arbitrary text. The buttons shown come from `availableTransitions`, built from the engine's own transition table and `can()`, so the UI cannot offer what the engine would refuse; an edited form gains nothing (tested in a real browser by changing a form's target state to CONFIRM as a member whom the organization requires to be a lead).

**What people can see.** An item and its conversation are visible only to those who pass `item:view` for the item's team (administrators and auditors see all). An item you may not see is a plain 404 with no hint it exists. Message text is decrypted server-side only after that check, is rendered as escaped text, and is never logged. Approvers see the AI's verbatim evidence quotes next to the conversation they come from.

**Decisions.** Confirming and closing are separate, explicit steps, each behind a short form with an optional note, and the four metrics (acknowledged, first substantive response, resolution confirmed, closed) are shown as separate facts. Forms carry the item's version: a form left open while the item moves on is refused rather than overwriting newer work. Assigning an owner closes the item's open `OWNERSHIP` review task in the same transaction. Closing a review task is audited.

**Two things learned the hard way.** (1) Next.js can load the data layer as more than one module copy (separately bundled routes), so the tenant context lives on `globalThis` like the cached client it serves; a module-local store made sign-in fail intermittently. (2) Prisma's generated client is emitted as CommonJS (`moduleFormat = "cjs"`) so it loads under Playwright's runner.

## 4d. Dashboards and notifications (Sprint 10)

**Dashboards** (`src/modules/reporting`, route `/dashboard`). Computed **live** from lifecycle events and SLA timers, scoped to the items the viewer may see (`item:view`: team members see their teams, administrators and auditors see everything), optionally for one team they may see. A team filter the viewer may not use shows an empty dashboard, indistinguishable from an empty team. Nothing is stored (`MetricSnapshot` stays unused until scale needs snapshots), so there is no second source of truth to drift, and the module writes nothing. `aggregate.ts` is pure and exhaustively unit-tested; definitions:
- An item is in the window when its **current cycle** began inside it (receipt, or the reopening that started the cycle).
- The **four metrics stay separate** (rules 4 and 5): acknowledgment, first substantive response, resolution (a person's confirmation, never a proposal) and closure (never a confirmation). Each is a duration from the cycle's start to its own event, shown as achieved count, still-waiting count, median and p90 (nearest rank). An acknowledgment never fills in a response, and a response never fills in an acknowledgment.
- Deadline attainment is met / (met + missed) over each item's current-cycle timers; running, due-soon and cancelled timers are counted apart. Open items with a missed or due-soon deadline are listed worst first.

**Item timeline.** The item page merges messages (including attached conversations), every lifecycle event with who made it, and missed deadlines into one ordered timeline. It carries no message text (that stays in the conversation card).

**Notifications** (`src/modules/notifications`, route `/notifications`). Raised by workers, never by the lifecycle engine, so the engine stays free of side effects: SLA warning and breach (to the owner, else the team's leads, else anyone who may act), a suggestion waiting for a decision (to people who may act on the item's team), and review work (a cross-channel candidate, an item needing an owner). Each producer is **best-effort and replay-safe**: a failure is logged with ids and swallowed (it must never fail the analysis or scan whose work already succeeded), and every event has a stable `dedupeKey` under a unique index, so a replayed job never notifies anyone twice.
- A payload is validated and carries **ids and enums only**; the sentence a person reads is built when they open the inbox, from the item title, and only for items they may still view.
- Channels and preferences: in-app is on and email is off until a person opts in. **Email is recorded, never sent** in this release (the database refuses to mark an email delivered); delivery arrives with real integrations.
- Inboxes are personal **at the database level**: when a request carries a user, row-level security shows and changes only that user's own notifications and preferences; system contexts (workers) carry no user and keep organization-wide access.

**Known limits.** No chart library: bars and tables only. The dashboard reads at most the 2000 most recently created items per request, then windows them. Notifications are not pushed (the inbox is read on page load; the unread badge refreshes on navigation). There is no digest, snooze or per-team preference. Owner assignment does not notify (not chosen this sprint).

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
| progress_analyzer | Does our reply report work underway? | `isProgress` |
| resolution_analyzer | Is the matter claimed fixed, confirmed or rejected? | `signal`: `resolved_by_us`, `confirmed_by_customer`, `rejected_by_customer`, `none` |

No free text is ever stored from a model: the item title is the message's own subject, and results are enums, booleans and ids. Ownership candidates are sent as a name and a mention handle only (never an email address) inside the untrusted block.

**The worker** (`src/workers/analyze-message.ts`) is the only place recommendations meet the lifecycle engine:
- *Inbound message, no item:* classify intent. If actionable, resolve an owner from the source's team and `createItem` (low confidence is flagged by the engine). A source with no team goes to an `OWNERSHIP` review task.
- *Inbound message, thread already CLOSED:* if actionable, **suggest** a reopen. The engine queues an approval and the item stays CLOSED (rule 2).
- *Our reply on an open item:* run both the substantive and acknowledgment analyzers and apply the rules in `analysis-plan.ts`.
- *Ownership is assigned only at creation, and only if* the recommendation is `ASSIGN_OWNER`, the id is a real team member, confidence cleared the threshold, the evidence is the message itself, and the quoted phrase contains that person's handle or first name. Anything else queues an `OWNERSHIP` review task for a human. After creation only humans change the owner.

**Decision rules that hold whatever the model says** (pure functions, tested exhaustively): a message from the outside (INBOUND) can never be our acknowledgment or response; an acknowledgment's or response's evidence must cite the message itself; a reply is RESPONDED only if substantive **and not** an acknowledgment, ACKNOWLEDGED only if an acknowledgment **and not** substantive; if both analyzers say yes they contradict each other and nothing moves, a human looks (a premature RESPONDED would flatter the response-time metric); a recommendation whose action does not match its own result is ignored. Timestamps are when messages were *sent*, not processed.

**Progress and resolution (Sprint 7).** Our reply on an item moves through stages, each re-reading the item, so one message can legitimately advance several steps: (1) acknowledgment versus substantive response, then (2) a claimed fix, which makes the item `RESOLUTION_PROPOSED` (a proposal, not a resolution), or else a status update, which makes it `IN_PROGRESS` (only from `RESPONDED`, so the acknowledgment and response metrics are never skipped). A customer message while a resolution is proposed is classified too: a rejection sends the item back to `IN_PROGRESS`, and a confirmation is **only ever a suggestion**: the engine queues an approval and the item stays `RESOLUTION_PROPOSED` until a person decides (rule 2). The rules in `analysis-plan.ts` accept each signal only from the right side (only our message can claim a fix; only the customer's INBOUND message can confirm or reject), only in the right state, with the action matching the signal, and with the evidence being the message itself.

**Job ordering.** Jobs for one thread run concurrently and in any order. A reply processed before its item existed would otherwise be lost, so once an item is created the worker evaluates the thread's later replies in order. Every step is idempotent (cached analyses, idempotent engine calls), so replays and duplicates change nothing.

**Failures and limits.** A retryable provider error is retried by the queue with backoff; a permanent one is dead-lettered immediately. When the organization's daily budget is spent the job is delayed to 00:05 UTC without using a retry attempt (cached analyses are still served). Throughput is capped per worker process by `ANALYZE_RATE_PER_MINUTE`.

**Golden sets** (`src/modules/intelligence/golden`): labeled synthetic cases per analyzer, run through the same `prepare`/`execute` guards as production with no database. `npm run golden` prints accuracy, precision, recall and a recommended confidence threshold (the lowest at which accepted answers reach 95% precision). The committed baseline `baselines/fake-heuristic-heuristic-1.json` is for the rule-based heuristic and is flagged `notForProduction`: the heuristic was written alongside these small sets (29, 15, 17 and 17 cases), so its scores overstate it and say nothing about a real model. Real baselines and thresholds need `LIVE_LLM=1 npm run golden -- --provider claude --write`, which costs money and should use a larger, independently written set. Until then the placeholder threshold stays at 0.8.

### 5d. Cross-channel correlation (implemented in Sprint 9)

`src/modules/correlation`. The problem: the same matter arrives through two channels (an email, then a Chat message about the same outage) and would become two items. **A false merge hides work, which is worse than a false split, so the system only ever asks; a person always decides** (rule 9). There is no auto-link at any score.

**Finding.** When an inbound message has no item on its thread, the analyze worker asks `findBestMatch`: a deterministic scorer (`score.ts`, pure) compares it with every open item in the organization whose first message is in a different source and within 24 hours. Four weighted signals: time (0.2), sender (0.2), shared reference numbers such as `#48213` or `INV-0042` (0.25), wording overlap (0.35). Time and sender alone can never reach the threshold: without a shared reference or real wording overlap the score is capped below it. Only the single best match at or above `SHOW_THRESHOLD` (0.45) becomes a candidate; anything lower simply starts its own item. The stored rationale holds counts and numbers only, never message text or the reference numbers themselves.

**Advisory verdict.** For a match, the Correlation Analyzer (analyzer 8, advisory, golden-set tested including embedded-instruction traps) says yes, no or unsure with verbatim evidence. It can only *suppress*: a confident "no" keeps the message out of the queue (it starts its own item, the cheap mistake). Yes, unsure, or an unusable answer all go to a person, and a failed advisory run records itself without queueing its own review task.

**Waiting.** The candidate gets one `CORRELATION` review task, and the message gets no item until a person decides. A second message in the same waiting thread joins the open question (no second model call, no second task). The job is idempotent: `(subject, target)` is unique, so a replay asks once.

**Deciding (people only).** `confirmCandidate`, `rejectCandidate`, `splitCandidate` need the review role plus `item:act` on the target item's team, and the candidate is shown only to people who may view both that item and the team the message arrived for. Exactly one of several simultaneous deciders wins. Each decision is audited in the same transaction.
- *Confirm* attaches every message of the other thread to the item as `ItemMessageLink` rows with role `OTHER`. No second item is created, and **no state or metric changes** (a link is not a transition). From then on our replies in that thread act on the item (`findLinkedItem`), and the customer's chatter is skipped like any other inbound message on an open item. Refused if the item is closed.
- *Reject* records that they are separate; the message goes on to start its own item, and that pair is never asked about again.
- *Split* undoes a confirmation (and counts as a rejection). It is refused once messages from the thread drove the item's lifecycle: such a link's role is upgraded from `OTHER` when it first cites a transition, and history is never rewritten.

**Follow-up.** A decision queues a durable `correlation-follow-up` job (ids only): a rejection or split re-analyzes the message so it starts its own item; a confirmation analyzes our earlier replies in the attached thread against the item. The candidate is stamped (`followUpAt`) only after every job was queued. If the queue is unreachable the decision still stands, the person is told, and the review page offers a safe retry. The generic review "resolve" and "dismiss" refuse a correlation task (`DECISION_REQUIRED`): closing the task without deciding would leave the message waiting forever.

**Known limits.** Only the single best candidate is offered. Two items that already exist separately and turn out to be duplicates are *not* merged (that would change lifecycle semantics: timers, metrics, state); this sprint covers messages that would otherwise start a new item. The candidate pool is the 300 most recently created open items, then filtered by message time. The scorer's wording signal is lexical, so a paraphrase with no shared reference can score low and simply start its own item. Thresholds are constants, not per-organization settings.

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

## 8. SLA engine (implemented in Sprint 8)

`src/modules/sla`. The SLA engine is a **derived read model**: it never writes `TrackedItem` (rule 1) and the lifecycle module never calls it. Timers are a pure function of three things: the item's `LifecycleEvent`s, the due dates frozen when each timer was created, and `Clock.now()`.

**Timers.** Four per reopen cycle, one per metric (rule 4): ACK, RESPONSE, RESOLVE, CLOSE. All start at the cycle's start (receipt, or the reopen) and are measured from there. A reopen starts a new cycle with new timers; earlier cycles are kept. States: `RUNNING`, `WARNED` (at `warnAtPct` of the target, default 80), `BREACHED`, `MET`, `CANCELLED`.
- ACK is satisfied by the earlier of the acknowledgment and the first substantive response (a substantive reply also acknowledges), but the metrics themselves stay separate (rule 5): the item still records its own `ackAt` only when an acknowledgment event exists.
- Completing a timer after its due time is `BREACHED`, not `MET`. When a cycle ends (closed or reopened), an overdue incomplete timer is `BREACHED` and a not-yet-due one is `CANCELLED`.
- Due and warning times are fixed at creation from the policy then in force. Editing a policy never re-times work in flight.
- Nothing is edited by hand: re-running `reconcileItem` any number of times, from any number of workers, in any order, yields the same rows. A late scan equals a timely scan.

**Policies and calendars.** `SlaPolicy` targets must be nested (ack <= response <= resolve <= close), enforced by the schema and a DB CHECK. A policy may be scoped to a team, a monitored source and/or a priority; the most specific wins (weights: source 4, team 2, priority 1; ties break by name then id). The policy is chosen once, when the item is created, and stored on the item. `BusinessCalendar` holds an IANA timezone, per-weekday open ranges (split shifts and `24:00` allowed) and holidays. Business-time arithmetic uses `Intl` only (no new dependency) and handles DST changes, half-hour zones and holidays. DST convention: a skipped local time reads as the same wall time after the change; an ambiguous one reads as its first occurrence. With no calendar, time is continuous.

**Scan.** A BullMQ job scheduler (`sla-scan`, every 60 s, registered idempotently on worker start) calls `scanAll`. It reconciles every open item plus items whose timers are still unsettled (so a just-closed item is finalized), under each organization's own tenant context; one failing item never stops the rest. Each breached timer gets exactly one `SlaBreach` (unique on `timerId`) and one `sla.timer_breached` audit entry, written in the same transaction as the state change. Each timer that newly enters its warning window queues one advisory `sla-risk` job, de-duplicated by timer id.

**Cross-tenant discovery.** The scan must find which organizations have policies without a tenant context. That is the one deliberate cross-tenant read: `listOrganizationsWithSlaPolicies()` calls the `SECURITY DEFINER` function `sla_scan_org_ids()`, which returns organization ids only, has a fixed `search_path`, is revoked from `PUBLIC` and granted to the app role only. Everything after discovery is tenant-scoped. **Deployment note:** the role that runs migrations must be allowed to bypass RLS (a table owner or superuser, as in the Docker Compose setup), because the function runs with its owner's rights.

**SLA Risk Analyzer (advisory).** Analyzer 7, `sla_risk_analyzer`. It reads the thread plus system-measured *facts* (`timerType`, `percentElapsed` in business time) and answers LOW, MEDIUM or HIGH. Facts travel in their own `<facts_NONCE>` block outside the untrusted message block, and are validated (plain keys; numbers, booleans or short tokens only) so nothing free-form can enter through them; they are part of the input hash. The analyzer is `advisory`: its recommended action is always `NONE`, it changes no timer, breach or state, and a failed run is recorded without queueing a review task. The item page shows its latest estimate only while a timer is due soon.

**Known limits.** No pause while waiting on the customer; policies and calendars are created through the module API (organization administrators, audited) but there is no UI yet; a risk job lost between settling a timer and queueing is not re-sent (the estimate is a hint).

## 9. Observability

Structured logs (no content), request and job IDs, metrics on queue depth, analyzer latency and cost, review-queue size. Content never goes to logs or error trackers.

## 10. Deployment (initial)

Docker Compose: `app`, `worker`, `postgres`, `redis`. Single-org PoC; configuration via validated env vars.
