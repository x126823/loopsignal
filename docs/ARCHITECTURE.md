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
| RESOLUTION_PROPOSED | RESOLUTION_CONFIRMED | **human only** | required |
| RESOLUTION_CONFIRMED | CLOSED | **human only**, authorized role | required |
| CLOSED, RESOLUTION_CONFIRMED | REOPENED | human, or system suggestion | auto-reopen only suggests |
| REOPENED | ACKNOWLEDGED, RESPONDED, IN_PROGRESS | as above | as above |

Invariants:
- Transition table is data, unit-tested exhaustively, including all illegal pairs.
- State change + `LifecycleEvent` + `AuditLog` commit in one transaction.
- Optimistic concurrency via `version` on `TrackedItem`.
- Each event records actor (user, system, or analyzer), evidence, `AnalysisRun` id, and reason.
- Metrics derive from events: `ackAt`, `firstSubstantiveResponseAt`, `resolvedAt`, `closedAt`. A reopen starts a new cycle; prior cycles are retained.

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

## 6. Multi-tenancy

- `organizationId` on every tenant-owned row.
- Prisma client extension injects tenant scope from request/job context.
- Postgres RLS policies keyed on `SET LOCAL app.org_id` as defense in depth.
- Tests assert cross-tenant reads and writes fail.

## 7. Authorization

Roles: `ORG_ADMIN`, `TEAM_LEAD`, `MEMBER`, `VIEWER`, `AUDITOR`. Deny by default; policies are functions in `identity` and checked server-side on every action. Confirm and close require `MEMBER` on the owning team or higher, as configured per org.

## 8. SLA engine

`SlaPolicy` (per team/source/priority) defines targets for ack, first substantive response, resolution, and closure, with a `BusinessCalendar`. Timers are rows with `dueAt`; a repeatable job scans for warn/breach. Time is injected via a `Clock` interface for deterministic tests.

## 9. Observability

Structured logs (no content), request and job IDs, metrics on queue depth, analyzer latency and cost, review-queue size. Content never goes to logs or error trackers.

## 10. Deployment (initial)

Docker Compose: `app`, `worker`, `postgres`, `redis`. Single-org PoC; configuration via validated env vars.
