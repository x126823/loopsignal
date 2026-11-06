
# LoopSignal

AI-powered Communication Accountability and Lifecycle Intelligence Platform.

LoopSignal monitors authorized communication sources (initially Gmail and Google Chat), identifies messages that require action, and tracks each one through:

`Received → Acknowledged → Responded → In progress → Resolution proposed → Resolution confirmed → Closed` (and `Reopened`).

AI recommends; authorized humans approve important lifecycle decisions. The backend lifecycle engine, not an AI model, controls every state transition.

## Status

Sprint 0 (foundations) complete. Sprint 1 (tenancy and auth) complete. Sprint 2 (core schema and audit) complete. Sprint 3 (lifecycle engine) in review: transition table, propose/apply API, approvals, ownership, reopen cycles, derived metrics, rule 1 guard. The seed drives scenarios through the engine. Sprint 4 (ingestion) in review: adapter interface, synthetic adapter, idempotent RawEvent to Message pipeline, BullMQ queues with retries and dead-letter. Sprint 5 (AI foundation) complete. Sprint 6 (analyzers 1-4) complete. Sprint 7 (human decisions) in review: progress and resolution analyzers, and the web UI for approving or rejecting a resolution, formal closure, the item page and the review queue. Nothing auto-closes. Sprint 8 (SLA engine) in review: policies and business calendars, four timers per cycle derived from lifecycle events, a repeating breach scan, a `Clock` for deterministic tests, and an advisory SLA Risk Analyzer. Sprint 9 (cross-channel correlation) in review: a deterministic scorer and an advisory analyzer find messages that look like items we already track in another channel; a person attaches, keeps separate, or later detaches them, and nothing is ever linked automatically. Sprint 10 (dashboard, reporting, notifications) in review: a dashboard with the four metrics shown separately, deadline attainment and what needs attention, an item timeline, and an in-app notification inbox with preferences (email is recorded, not sent). See `docs/IMPLEMENTATION_PLAN.md`.

## Documentation

| Doc | Purpose |
|---|---|
| `CLAUDE.md` | Rules and conventions for AI-assisted development |
| `docs/ARCHITECTURE.md` | Modules, data flow, lifecycle, AI design |
| `docs/DATABASE_DESIGN.md` | Entities, relationships, constraints |
| `docs/IMPLEMENTATION_PLAN.md` | Sprint-by-sprint plan |
| `docs/SECURITY.md` | Threat model, privacy, integration risks |

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

Set `FIELD_ENCRYPTION_KEY` (see `.env.example`; `openssl rand -base64 32`) before seeding, since message bodies are stored encrypted. The seed drives its scenarios through the lifecycle engine. It is idempotent, but if you change the schema or scenarios, reset with `docker compose down -v && docker compose up -d && npm run db:deploy && npm run db:seed`.

Dev login: set `AUTH_DEV_LOGIN=true` and sign in as any seeded synthetic email (no password; refused in production). If your Postgres volume predates Sprint 1, run `docker compose down -v` once so the runtime role is created.

# loopsignal
LoopSignal is an AI-powered communication accountability platform that monitors authorized email and chat channels, tracks messages from receipt to closure, and flags missed acknowledgments, delayed responses, and overdue actions. With SLA tracking and human-verified accountability, it helps teams improve responsiveness, ownership, and efficiency.

