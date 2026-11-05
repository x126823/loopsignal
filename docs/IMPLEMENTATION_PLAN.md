# Implementation Plan

Roughly one-week sprints. Each ends with passing tests and a demonstrable outcome. Sprints 0–10 use synthetic data only. Do not begin a sprint without user approval.

## Prerequisites
Node.js 22 LTS, Docker Desktop, `git init`.

## Sprints

### Sprint 0 — Foundations
Scaffold Next.js + TypeScript strict + Tailwind + shadcn/ui; Docker Compose (Postgres, Redis); Prisma init; ESLint with module-boundary rules; Vitest, Playwright skeletons; env validation (Zod); CI workflow.
**Exit:** `docker compose up`, `npm run dev`, `npm test`, `npm run lint` all pass in CI.

### Sprint 1 — Tenancy and auth
Organization, User, Membership, Team; Auth.js (Google OIDC, dev credentials provider for synthetic users); RBAC policy functions; Prisma tenant-scope extension; RLS policies.
**Exit:** cross-tenant access tests fail closed; role matrix tests pass.

### Sprint 2 — Core schema and audit
Remaining Prisma models; migrations; append-only triggers; hash-chained AuditLog; synthetic seed generator (multiple teams, threads, ack/response/resolution scenarios).
**Exit:** migrations apply on clean DB; UPDATE/DELETE on append-only tables rejected; seed runs.

### Sprint 3 — Lifecycle engine
Transition table, `propose/apply` API, approvals, ownership, reopen cycles, optimistic concurrency, event and metric derivation.
**Exit:** exhaustive legal/illegal transition tests; confirm/close impossible without human actor; metrics derived correctly.

### Sprint 4 — Ingestion (synthetic)
Provider adapter interface; synthetic adapter; RawEvent → Message normalization; dedupe; BullMQ queues, retries, dead-letter; idempotent replays.
**Exit:** replaying the same events twice creates no duplicates.

### Sprint 5 — AI foundation
`LLMProvider`, Claude provider, Fake provider; Zod schemas; guard pipeline (delimiting, redaction, evidence-substring check, retry, caching, budget); AnalysisRun persistence; prompt-injection fixture suite.
**Exit:** injection fixtures cannot alter outputs or transitions; invalid output → review task.

### Sprint 6 — Analyzers 1–4
Intent Classifier, Ownership Resolver, Acknowledgment Detector, Substantive Response Analyzer; worker wiring to `lifecycle.propose`; golden sets.
**Exit:** golden-set baselines recorded; ack vs. substantive distinction tested.

### Sprint 7 — Analyzers 5–6 and human decisions
Progress and Resolution analyzers; UI for approve/reject resolution and formal closure; review queue UI.
**Exit:** e2e: proposal → human confirm → human close; test proving nothing auto-closes.

### Sprint 8 — SLA engine
Policies, calendars, timers, breach scanner, `Clock` injection; SLA Risk Analyzer (advisory).
**Exit:** fake-clock tests for business hours, warn, breach, reopen.

### Sprint 9 — Cross-channel correlation
Correlation analyzer, candidate scoring, thresholds, review UI, merge/split with audit.
**Exit:** uncertain matches always reach the review queue; no auto-merge below threshold.

### Sprint 10 — Dashboard, reporting, notifications
Team and org dashboards (four metrics separately), item detail with full timeline, notification preferences and delivery.
**Exit:** Playwright flows pass end to end on synthetic data.

### Sprint 11 — Gmail adapter
OAuth consent flow, least-privilege scopes, encrypted tokens, history sync, Pub/Sub watch renewal, resync on gap. Test workspace and synthetic mail only; feature-flagged.
**Gate:** explicit user authorization before any real mailbox.

### Sprint 12 — Google Chat spike and adapter
Feasibility spike (app installation vs. domain-wide delegation, event subscriptions, message-read limits); decision recorded; adapter if feasible.

### Sprint 13 — Hardening
Security review against `docs/SECURITY.md`; load test; retention jobs; backup/restore drill; runbooks.

## Cross-cutting definition of done
Tests included; lint and typecheck clean; no content in logs; audit events for state changes; docs updated; tenant isolation verified for any new table.

## Open decisions
- Auth.js assumed (Google OIDC); revisit if enterprise SSO is required.
- RLS plus Prisma extension assumed.
- Google Workspace test domain with admin access needed by Sprint 12.
- Confidence thresholds set from golden sets in Sprint 6.
