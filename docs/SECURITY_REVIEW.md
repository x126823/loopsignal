# Security review (Sprint 13)

A review of the implementation against `docs/SECURITY.md`: for each threat, where the control lives and what proves it, then what the review **found** (and fixed) and what it **left open**. Scope: the code and tests in this repository, on synthetic data, with Google simulated by a fake. It is not a penetration test, and nothing in it speaks for a real deployment or real Google behaviour.

## 1. Threat by threat

| Threat (SECURITY.md) | Control | Evidence |
|---|---|---|
| Prompt injection | Content is delimited and labelled untrusted; analyzers have no tools; Zod-validated output; evidence must be a verbatim substring; engine ignores AI claims of authority; confirm/close need a human | `tests/integration/prompt-injection.test.ts`, `no-auto-close.test.ts`, `intelligence-pipeline.test.ts`, red-team fixtures in CI |
| Fabricated evidence | Substring check against the cited message | pipeline tests |
| Tenant data leakage | Scoped data layer **and** Postgres RLS (forced) on every tenant table; non-owner, non-bypass app role | `schema-audit.test.ts` catalog (every table with `organizationId`); per-table isolation tests; the credentials and claim tables are also tested at the database layer with no application scoping (`gmail-connection`, `chat-connection`) |
| Privilege escalation | Server-side RBAC functions; engine re-checks; role changes audited. **Every server action in the signed-in app authenticates its caller** | `rbac.test.ts`, `identity-tenancy.test.ts`, `tests/lint-actions.test.ts` (fails if an action does not call `requireContext()`); **session lifetime and revocation (new)**: `sessions.test.ts`, `e2e/sessions.spec.ts` |
| OAuth token theft | Tokens AES-256-GCM with context-bound AAD in one table only one module may query; never logged, audited or queued; disconnect revokes at Google and deletes our copy; rotation path exists | `gmail-connection.test.ts` (encryption, AAD, secrets-in-nothing), `tests/lint-credentials.test.ts`, `key-rotation.test.ts` (new) |
| Webhook spoofing/replay | Pub/Sub push accepted only with Google's RS256 token (audience, service account, expiry, signature, key id); duplicate notifications collapse by history position; unknown mailbox is a no-op | `gmail-adapter.test.ts` (token cases), `gmail-connection.test.ts` (push) |
| Audit tampering | No UPDATE/DELETE grants, triggers reject every role, hash chain per organization, **daily verification job (new)** recording its result in the chain, and **signed anchors (new, opt-in)** that catch deleted newest rows | `schema-audit.test.ts`, `retention.test.ts` (tamper and detect), `audit-anchors.test.ts`, runbook `audit-chain.md` |
| SQL injection / XSS | Prisma parameterization; raw SQL only through tagged templates (no `$queryRawUnsafe` in `src`); no `dangerouslySetInnerHTML`; **nonce-based CSP and security headers (new)** | `src/lib/security-headers.test.ts`, `e2e/security.spec.ts` (hostile title does not run; no CSP violation anywhere in the app) |
| SSRF / unsafe links | Message links are never fetched. The only outbound requests go to fixed Google endpoints (the test override is loopback-only and refused in production) | `gmail-adapter.test.ts`, `env.test.ts` |
| Secrets exposure | Env validated (a bad value never echoes); `.env` ignored; **secret scan in CI (new)**; Chat key and Google secrets read in one place each | `src/lib/secret-scan.test.ts` (and the repo passes), `lint-credentials.test.ts` |
| Cost abuse (LLM) | Per-organization daily token budget, input-hash cache, rate limits | the load test hit the budget and was deferred as designed |
| Cross-tenant scan | A few narrow `SECURITY DEFINER` functions returning ids (or one boolean) only; everything after runs under the organization's own context | `sla-worker`, `gmail-connection`, `chat-connection`, `retention` tests |
| Notification leakage | Ids-only payloads, text built at read time, personal inboxes enforced by RLS | `notifications.test.ts` |
| Dashboard over-disclosure | Aggregates only over items the viewer may see | `reporting.test.ts` |
| Job replay / duplicates | Idempotent handlers, unique keys, deterministic job ids | ingestion, queue and worker tests |
| Dependency / supply chain | Lockfile; **`npm audit` in CI (new)**; no dependency was added in Sprints 11-13 | `npm audit --omit=dev`: 0 vulnerabilities on 2026-11-06 |

## 2. Findings fixed in this sprint

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | **Production sign-in could not work.** `trustHost: false` was set explicitly, which overrides Auth.js's detection, so every production request failed with `UntrustedHost` even with `AUTH_URL` set. Found while load-testing a production build. | High (outage) | Production no longer sets it; `AUTH_URL` is required in production and must be https (localhost excepted) |
| F2 | No Content-Security-Policy or security headers (SECURITY.md promised a CSP) | Medium | Nonce-based CSP per request (strict in production; dev relaxes eval/hot reload/style nonce only), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, HSTS in production, no `X-Powered-By` |
| F3 | The audit hash chain was never verified by anything (only a function existed) | Medium | Daily job for every organization; result recorded in the chain; error log and Retention page on failure |
| F4 | No dependency or secret scanning in CI | Medium | `npm audit` and `npm run scan:secrets` in CI |
| F5 | Retention was a document, not a mechanism: content was kept forever | High (privacy) | Per-organization windows, a daily pass, an erasure function, all tested (see `docs/runbooks/retention.md`) |
| F6 | No way to rotate `FIELD_ENCRYPTION_KEY` | High (key compromise) | `npm run ops:rotate-key`, idempotent and resumable, tested for every encrypted column |
| F7 | **Database connection pool exhaustion**: 94% request failures at 20 concurrent users (default pool of 10, 2 s wait) | High (availability) | `DB_POOL_MAX` (20) and `DB_TX_MAX_WAIT_MS` (10 s) |
| F8 | The review queue page rendered every open task (3 s at 1,200) | Medium (availability) | Bounded to 100 with an honest total, visibility decided before the cut so counts never reveal other teams' work |
| F9 | A backup had never been restored, and nothing checked that a restore keeps RLS, grants, guards and the audit chain | High | `npm run drill:restore` and its tests, run in CI |
| F10 | No tooling for dead letters during an incident | Low | `npm run ops:dead-letters` (list, retry), tested |
| F11 | **The web server did not refuse to start on a bad production configuration.** Settings were validated on first use, so a deploy with a missing `AUTH_URL` or dev login on started, then answered every request with a 500. (The production checklist claimed otherwise.) Found by the production rehearsal. | Medium | A start-up hook validates the environment and exits, naming the setting (never the value); the worker already did. Guarded by `tests/lint-boot.test.ts` and checked for real by the rehearsal |
| F12 | The restore drill's append-only check proved nothing on an empty table (a statement that changes no rows is not "rejected") | Low | It now inserts its own row into the restored copy to test raw events, tests the other tables only where rows exist, and checks the guard triggers are present and enabled directly |
| F13 | (follow-up) `connection.needs_attention`, audit anchors, sessions, export and alerting did not exist: see section 3 | Medium | Built and tested; see the runbooks |

## 3. Known gaps

Status after the follow-up round (Sprint 13 follow-up, "close the known gaps"). **Closed** means the mechanism is built and tested here; where a gap also needs something only an operator can supply (a receiver, a store), that is stated.

| # | Gap | Status |
|---|---|---|
| O1 | Deleting the **newest** audit rows is undetectable from inside the database | **Closed, with an operator step.** Signed audit anchors (HMAC) are taken daily and checked against every earlier anchor; deleted newest rows, removed rows and rewritten rows are all caught. It is only as good as the place the anchors are kept: you provide the key (apart from the database) and the write-once store. Off until `AUDIT_ANCHOR_KEY` is set. Without a key the Retention page says so |
| O2 | No alerting integration | **Closed, with an operator step.** Ids-only, signed, de-duplicated JSON webhook for the events that need a person, never blocking, with `ops:test-alert`. You provide the receiver that actually pages someone. Off until `ALERT_WEBHOOK_URL` is set |
| O3 | Any **member** of an unbound Chat space (an external guest, say) can post a code and bind it to their organization | **Narrowed, not closed.** The first organization to ask keeps its place while its request is open, so requesting a code *before* adding the Chat app reserves a space. A guest who asks first, or who asks when nobody has, still wins. Closing it needs the space owner's approval, which needs a real Workspace domain to build and test against |
| O4 | Stateless sessions with no revocation and the library's default lifetime | **Closed.** A sign-in lasts `SESSION_HOURS` (default 12) from sign-in; a person can end all their sessions, an administrator can end a member's; revoked sessions are refused on the next request, and signing in again straight afterwards works. Authorization was already resolved from the database on every request |
| O5 | No rate limiting or WAF in the application | **Open.** Belongs at the edge of the deployment; sign-in is delegated to Google |
| O6 | Export of a person's data is not built | **Closed.** `ops:export-person` writes a decrypted, audited export to a new owner-only file, never printed |
| O7 | `npm audit` and secret scanning were narrow | **Closed.** Secret scan covers git history as well as files (CI); CI prints the full production audit report alongside the high-severity gate |
| O8 | The layout read the whole pending-approvals list on every navigation to show a count | **Closed.** A count query with the same visibility rule; a test proves the two agree for every role |
| O9 | The dashboard reads at most 2,000 recent items per request | **Open.** Needs snapshots (`MetricSnapshot` is reserved) |
| O10 | Everything about Gmail and Chat is verified against a **fake** Google | **Open.** Needs a supervised test-domain pass with the user's authorization |
| O11 | Backups contain content older than retention until they expire | **Open.** An environment policy: align backup retention with the content windows |

## 4. How to repeat this review

```
npm run lint && npm run typecheck && npm test && npm run test:e2e
npm audit --omit=dev --audit-level=high
npm run scan:secrets
npm run drill:restore
npm run build && npm run rehearse:production   # the production checklist, executed (35 checks)
npm run load:test -- --assert            # needs a running dev server; see docs/runbooks/load-test.md
```
