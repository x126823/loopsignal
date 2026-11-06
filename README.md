
# LoopSignal

AI-powered Communication Accountability and Lifecycle Intelligence Platform.

LoopSignal monitors authorized communication sources (initially Gmail and Google Chat), identifies messages that require action, and tracks each one through:

`Received → Acknowledged → Responded → In progress → Resolution proposed → Resolution confirmed → Closed` (and `Reopened`).

AI recommends; authorized humans approve important lifecycle decisions. The backend lifecycle engine, not an AI model, controls every state transition.

## Status

Sprint 0 (foundations) complete. Sprint 1 (tenancy and auth) complete. Sprint 2 (core schema and audit) complete. Sprint 3 (lifecycle engine) in review: transition table, propose/apply API, approvals, ownership, reopen cycles, derived metrics, rule 1 guard. The seed drives scenarios through the engine. Sprint 4 (ingestion) in review: adapter interface, synthetic adapter, idempotent RawEvent to Message pipeline, BullMQ queues with retries and dead-letter. Sprint 5 (AI foundation) complete. Sprint 6 (analyzers 1-4) complete. Sprint 7 (human decisions) in review: progress and resolution analyzers, and the web UI for approving or rejecting a resolution, formal closure, the item page and the review queue. Nothing auto-closes. Sprint 8 (SLA engine) in review: policies and business calendars, four timers per cycle derived from lifecycle events, a repeating breach scan, a `Clock` for deterministic tests, and an advisory SLA Risk Analyzer. Sprint 9 (cross-channel correlation) in review: a deterministic scorer and an advisory analyzer find messages that look like items we already track in another channel; a person attaches, keeps separate, or later detaches them, and nothing is ever linked automatically. Sprint 10 (dashboard, reporting, notifications) in review: a dashboard with the four metrics shown separately, deadline attainment and what needs attention, an item timeline, and an in-app notification inbox with preferences (email is recorded, not sent). Sprint 11 (Gmail adapter) in review: an admin-only OAuth consent flow with the read-only scope, encrypted tokens, history-based sync with gap recovery, Pub/Sub push with signed-token verification and watch renewal, all behind a feature flag that is off by default and verified only against a fake Google (no real mailbox has been connected). Sprint 12 (Google Chat) in review: a feasibility decision (`docs/GOOGLE_CHAT.md`) and a polling adapter that reads spaces a Chat app was added to, as the app, with each space bound to one organization by a posted proof code; feature-flagged, off by default, and verified only against a fake Google. Sprint 13 (hardening) in review: a security review (`docs/SECURITY_REVIEW.md`) with fixes (a nonce-based CSP and security headers, a production sign-in bug, database pool exhaustion found by a load test), configurable per-organization retention enforced by a daily job, erasure of a person's data, field-key rotation, a daily audit-chain check, a backup-and-restore drill, and runbooks (`docs/runbooks/`). See `docs/IMPLEMENTATION_PLAN.md`.

## Documentation

| Doc | Purpose |
|---|---|
| `CLAUDE.md` | Rules and conventions for AI-assisted development |
| `docs/ARCHITECTURE.md` | Modules, data flow, lifecycle, AI design |
| `docs/DATABASE_DESIGN.md` | Entities, relationships, constraints |
| `docs/IMPLEMENTATION_PLAN.md` | Sprint-by-sprint plan |
| `docs/SECURITY.md` | Threat model, privacy, integration risks |
| `docs/GOOGLE_CHAT.md` | Google Chat feasibility decision and its limits |
| `docs/SECURITY_REVIEW.md` | Sprint 13 review against the threat model: evidence, findings, known gaps |
| `docs/runbooks/` | Operating it: incidents, key rotation, backup and restore, retention and erasure, integrations, queues, load test, production checklist |

## Stack

Next.js · React · TypeScript · Tailwind · shadcn/ui · PostgreSQL · Prisma · Redis · BullMQ · Auth.js · Claude API · Vitest · Playwright · Docker Compose

## Prerequisites (from Sprint 0)

- Node.js 22 LTS
- Docker Desktop

## Development data

Synthetic data only. No real communications are connected during development.

## Quick start

```
cp .env.example .env
docker compose up -d
nvm use            # Node 22 (.nvmrc)
npm install
docker compose up -d   # first run also creates the loopsignal_app DB role
npm run db:migrate
npm run db:seed        # idempotent; synthetic users, 2 orgs, 14 scenarios, SLA timers from the real engine at a fixed clock. Users: alice|bob|carol|dave|erin|frank|gina@synthetic.loopsignal.test
npm run dev        # http://localhost:3000 (sign in with a seeded user, for example carol@synthetic.loopsignal.test). The seeded items are from October 2026: use the dashboard period "Last 90 days" or longer to include them
npm run worker     # BullMQ worker: ingest, analysis, SLA scan (every 60 s), correlation follow-up
npm run ingest:synthetic   # queue a sync of the seeded synthetic mailbox (worker must be running)
```

LLM: `LLM_PROVIDER` defaults to `fake`, which never contacts a model. To try the Claude provider, set `LLM_PROVIDER=claude` and provide credentials the SDK understands (`ANTHROPIC_API_KEY` or `ant auth login`); they are never stored or validated by this repo. Use synthetic data only. With the default `fake` provider the whole pipeline runs locally with no credentials (a keyword-rule heuristic stands in for the model): `npm run worker` in one terminal, then `npm run ingest:synthetic`. `npm run golden` scores the analyzers on the golden sets. An opt-in live smoke test: `LIVE_LLM=1 npx vitest run tests/live`; real-model golden baselines: `LIVE_LLM=1 npm run golden -- --provider claude` (costs money).

Checks: `npm run lint && npm run typecheck && npm test && npm run test:e2e`.

Operations (see `docs/runbooks/`): `npm run rehearse:production` (after `npm run build`: run the production checklist for real on a throwaway database), `npm run drill:restore` (prove a backup restores), `npm run load:test` (synthetic load; ingestion, analysis and page latency), `npm run scan:secrets`, `npm run ops:retention`, `npm run ops:erase-person`, `npm run ops:rotate-key`, `npm run ops:dead-letters`. Production needs `AUTH_URL` (https) set; the process refuses to start without it. Also: `npm run ops:export-person` (subject access), `npm run ops:audit-anchors` (anchor emit and verify), `npm run ops:test-alert` (prove the alert webhook works), `npm run scan:secrets -- --history` (scan git history). The browser tests start their own dev server and a fake Google on port 4010 with Gmail switched on, so stop any `npm run dev` you have running first (a server that is already up would not have the Gmail settings).

**Gmail (Sprint 11, off by default).** `GMAIL_ENABLED=false` leaves the integration inert. To try it, use a Google Cloud *test* project and a *test* mailbox, never real company mail: create an OAuth client (web application) whose redirect URI is `<APP_BASE_URL>/api/gmail/callback`, put its id and secret in `.env` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_ENABLED=true`; see `.env.example`), keep `npm run worker` running, sign in as an organization admin and use **Connections**. The only scope requested is `gmail.readonly`. The integration works by polling every 3 minutes; Pub/Sub push (`GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`) is optional and only makes it faster. Nothing in the automated tests uses a real Google endpoint.

**Google Chat (Sprint 12, off by default).** `GOOGLE_CHAT_ENABLED=false` leaves it inert. It works differently from Gmail: there is one product-wide Chat app (a service account whose key file goes in `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`), each customer's Workspace admin approves `chat.app.messages.readonly` once, and people add the app to the spaces to monitor. Then, as an organization admin, use **Connections**: request a code for a space, post it in that space, press Verify. Link your teammates under "People in Chat" so their replies count as the team answering. Read `docs/GOOGLE_CHAT.md` first for what Chat can and cannot do (public messages only, polling every 3 minutes, no DMs). Use a test domain and synthetic spaces only.

Set `FIELD_ENCRYPTION_KEY` (see `.env.example`; `openssl rand -base64 32`) before seeding, since message bodies are stored encrypted. The seed drives its scenarios through the lifecycle engine. It is idempotent, but if you change the schema or scenarios, reset with `docker compose down -v && docker compose up -d && npm run db:deploy && npm run db:seed`.

Dev login: set `AUTH_DEV_LOGIN=true` and sign in as any seeded synthetic email (no password; refused in production). If your Postgres volume predates Sprint 1, run `docker compose down -v` once so the runtime role is created.

# loopsignal
LoopSignal is an AI-powered communication accountability platform that monitors authorized email and chat channels, tracks messages from receipt to closure, and flags missed acknowledgments, delayed responses, and overdue actions. With SLA tracking and human-verified accountability, it helps teams improve responsiveness, ownership, and efficiency.

