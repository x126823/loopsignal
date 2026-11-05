# LoopSignal

AI-powered Communication Accountability and Lifecycle Intelligence Platform.

LoopSignal monitors authorized communication sources (initially Gmail and Google Chat), identifies messages that require action, and tracks each one through:

`Received → Acknowledged → Responded → In progress → Resolution proposed → Resolution confirmed → Closed` (and `Reopened`).

AI recommends; authorized humans approve important lifecycle decisions. The backend lifecycle engine, not an AI model, controls every state transition.

## Status

Sprint 0 (foundations) complete: scaffold, Docker Compose, lint module boundaries, test skeletons, CI. No domain code yet. See `docs/IMPLEMENTATION_PLAN.md`.

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
npm run db:generate
npm run dev        # http://localhost:3000
npm run worker     # BullMQ worker (no queues yet)
```

Checks: `npm run lint && npm run typecheck && npm test && npm run test:e2e`.

`db:migrate` and `db:seed` become useful once the schema lands in Sprint 1–2.
