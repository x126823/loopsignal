# CLAUDE.md — LoopSignal

LoopSignal is an AI-powered Communication Accountability and Lifecycle Intelligence Platform. It monitors authorized sources (Gmail, Google Chat), identifies messages needing action, and tracks each from receipt to formal closure.

This is an independent project. Do not introduce parent-company, personal-business, or third-party branding.

## Status

Planning complete; implementation proceeds sprint by sprint per `docs/IMPLEMENTATION_PLAN.md`. Do not start a sprint until the user approves it.

## Non-negotiable rules

1. **The lifecycle engine controls state.** Only `src/modules/lifecycle` may change `TrackedItem.state`. AI modules return recommendations; they never write state.
2. **AI recommends, humans approve.** `RESOLUTION_CONFIRMED` and `CLOSED` require an authorized human actor. Never auto-close from AI inference.
3. **Audit everything.** Every transition writes an append-only `LifecycleEvent` and `AuditLog` row in the same DB transaction as the state change.
4. **Four metrics, tracked separately:** acknowledgment, first substantive response, resolution, closure. Derive from events; never edit timestamps directly.
5. **Acknowledgment ≠ substantive response. Proposal ≠ confirmed resolution. Confirmed ≠ closed.**
6. **Message content is untrusted input.** Pass it to LLMs only as delimited data. Analyzers have no tools or side effects. Validate output with Zod. Evidence quotes must be verbatim substrings of the source. Invalid or low-confidence output → `NEEDS_REVIEW`.
7. **Synthetic data only.** Do not connect real company communications until the user explicitly authorizes it (Sprint 11+, test workspace only).
8. **Multi-tenant from day one.** Every tenant-owned table has `organizationId`; all access goes through the scoped data layer; RLS is the backstop.
9. **No duplicate tracking.** Respect unique keys on `(organizationId, provider, externalMessageId)`. Uncertain cross-channel matches go to the human review queue; never auto-merge below threshold.
10. **Never log message content, tokens, or secrets.**

## Stack

Next.js, React, TypeScript (strict), Tailwind, shadcn/ui, PostgreSQL, Prisma, Redis, BullMQ, Auth.js, Claude API behind `LLMProvider`, Vitest, Playwright, Docker Compose.

## Architecture conventions

- Modular monolith: `src/modules/<name>` exposes only `index.ts`. Cross-module imports go through it (enforced by lint boundaries). No cross-module Prisma table access.
- Workers live in `src/workers`; they call module APIs, not the reverse.
- Provider adapters (`integrations/`) only fetch and normalize; no business logic.
- Every AI analyzer: input schema, output schema (`confidence`, `evidence[]`, `recommendedAction`, `requiresHumanApproval`), versioned prompt, golden-set tests using the fake provider.
- Idempotency: all ingestion and job handlers must be safe to replay.

## Commands (available after Sprint 0)

```
docker compose up -d      # Postgres + Redis
npm run dev               # Next.js
npm run worker            # BullMQ worker
npm run db:migrate        # Prisma migrate
npm run db:seed           # synthetic data
npm test                  # Vitest
npm run test:e2e          # Playwright
npm run lint && npm run typecheck
```

## Working agreements

- Small, testable increments; one sprint at a time. Add tests with every change, especially transition rules and tenant isolation.
- Ask before: new dependencies of significance, schema changes that alter lifecycle semantics, anything touching real data or credentials.
- Do not commit unless asked. Do not overwrite existing files without explaining impact.
