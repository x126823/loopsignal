# Security review (Sprint 13)

A review of the implementation against `docs/SECURITY.md`: for each threat, where the control lives and what proves it, then what the review **found** (and fixed) and what it **left open**. Scope: the code and tests in this repository, on synthetic data, with Google simulated by a fake. It is not a penetration test, and nothing in it speaks for a real deployment or real Google behaviour.

## 1. Threat by threat

| Threat (SECURITY.md) | Control | Evidence |
|---|---|---|
| Prompt injection | Content is delimited and labelled untrusted; analyzers have no tools; Zod-validated output; evidence must be a verbatim substring; engine ignores AI claims of authority; confirm/close need a human | `tests/integration/prompt-injection.test.ts`, `no-auto-close.test.ts`, `intelligence-pipeline.test.ts`, red-team fixtures in CI |
| Fabricated evidence | Substring check against the cited message | pipeline tests |
| Tenant data leakage | Scoped data layer **and** Postgres RLS (forced) on every tenant table; non-owner, non-bypass app role | `schema-audit.test.ts` catalog (every table with `organizationId`); per-table isolation tests; the credentials and claim tables are also tested at the database layer with no application scoping (`gmail-connection`, `chat-connection`) |
| Privilege escalation | Server-side RBAC functions; engine re-checks; role changes audited. **Every server action in the signed-in app authenticates its caller** | `rbac.test.ts`, `identity-tenancy.test.ts`, `tests/lint-actions.test.ts` (new: fails if an action does not call `requireContext()`) |
| OAuth token theft | Tokens AES-256-GCM with context-bound AAD in one table only one module may query; never logged, audited or queued; disconnect revokes at Google and deletes our copy; rotation path exists | `gmail-connection.test.ts` (encryption, AAD, secrets-in-nothing), `tests/lint-credentials.test.ts`, `key-rotation.test.ts` (new) |
| Webhook spoofing/replay | Pub/Sub push accepted only with Google's RS256 token (audience, service account, expiry, signature, key id); duplicate notifications collapse by history position; unknown mailbox is a no-op | `gmail-adapter.test.ts` (token cases), `gmail-connection.test.ts` (push) |
| Audit tampering | No UPDATE/DELETE grants, triggers reject every role, hash chain per organization, **daily verification job (new)** recording its result in the chain | `schema-audit.test.ts`, `retention.test.ts` (tamper and detect), runbook `audit-chain.md` |
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

## 3. Known gaps (not fixed; each is stated, not hidden)

| # | Gap | Why it matters | Suggested next step |
|---|---|---|---|
| O1 | Deleting the **newest** audit rows is undetectable from inside the database | A superuser could remove the most recent entries | Anchor the chain head outside the database (a signed daily digest, a write-once store) |
| O2 | No alerting integration: errors are logged, nobody is paged | A broken audit chain or a rejected Chat key would sit unnoticed | Route error-level events to the on-call tool |
| O3 | Any **member** of an unbound Chat space (an external guest, say) can post a code and bind it to their organization | They gain a copy of messages they could already read | Require approval from the space's owning domain before real use |
| O4 | Sessions are stateless JWTs with the library default lifetime; there is no server-side revocation | A stolen session lasts until it expires, or until `AUTH_SECRET` is rotated (which signs everyone out) | Shorter lifetime, or a session table |
| O5 | No rate limiting or WAF in the application | Brute force and abuse protection is left to the platform (sign-in is delegated to Google, which limits it) | Edge rate limiting in the deployment |
| O6 | Export of a person's data is not built (erasure is) | Subject-access requests are manual | Build an export alongside erasure |
| O7 | `npm audit` covers production dependencies at high severity; `scan:secrets` covers committed files, not history | Lower-severity advisories and old leaks are not reported | Periodic full audit and a history scan |
| O8 | The pending-approvals list is read in full by the page layout on every navigation to show a count | Cheap today (few pending), grows with pending approvals | A count query |
| O9 | The dashboard reads at most 2,000 recent items per request | Wrong for very large organizations | Snapshots (`MetricSnapshot` is reserved) |
| O10 | Everything about Gmail and Chat is verified against a **fake** Google | Real quotas, status codes, verification requirements and latency are unknown | A supervised test-domain pass, with the user's authorization |
| O11 | Backups contain content older than retention until they expire | An erased person remains in older backups | Align backup retention with the content windows |

## 4. How to repeat this review

```
npm run lint && npm run typecheck && npm test && npm run test:e2e
npm audit --omit=dev --audit-level=high
npm run scan:secrets
npm run drill:restore
npm run load:test -- --assert            # needs a running dev server; see docs/runbooks/load-test.md
```
