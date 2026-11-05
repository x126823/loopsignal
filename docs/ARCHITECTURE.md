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
