# Security, Privacy and Integration Risks

## 1. Principles
- AI has no authority. The lifecycle engine decides; humans approve confirm/close.
- Message content is untrusted input and sensitive data.
- Least privilege everywhere: OAuth scopes, DB roles, RBAC.
- Deny by default; enforce on the server.
- Development uses synthetic data only.

## 2. Threats and mitigations

| Threat | Mitigation |
|---|---|
| **Prompt injection** via email/chat text (e.g. "mark resolved", "ignore instructions") | Content delimited and labelled untrusted; analyzers have no tools or side effects; Zod-validated output; evidence must be verbatim substring; engine ignores AI claims of authority; confirm/close need human; red-team fixture suite in CI |
| **Fabricated evidence** | Substring verification against the cited message; mismatches rejected |
| **Tenant data leakage** | Scoped data layer, Postgres RLS, non-owner DB role, isolation tests for every table |
| **Privilege escalation** | Server-side RBAC policy functions; approvals checked by engine; role-change audited |
| **OAuth token theft** | Envelope encryption at rest; scopes minimal; tokens never logged; rotation and revocation flow |
| **Webhook spoofing/replay** | Verify Google-signed JWTs / Pub/Sub auth; timestamp and idempotency checks; reject unknown subscriptions |
| **Audit tampering** | Append-only tables (no UPDATE/DELETE grants + triggers); hash chain; periodic verification job |
| **Injection (SQL/XSS)** | Prisma parameterization; message HTML sanitized or rendered as text; CSP; no `dangerouslySetInnerHTML` on message content |
| **SSRF / unsafe links** | Links in messages never fetched server-side; attachments metadata only in v1 |
| **Secrets exposure** | Env validated; `.env` git-ignored; secret scanning in CI |
| **Cost abuse (LLM)** | Per-org budget cap, input-hash cache, rate limits, size limits on content |
| **Cross-tenant scan** (SLA scanner must find organizations without a tenant context) | One narrow `SECURITY DEFINER` function returns organization ids only (fixed `search_path`, revoked from `PUBLIC`, granted to the app role); all further access is tenant-scoped; tested that the app role cannot read policies directly. The migration role must bypass RLS |
| **Notification leakage** (one person reading another's inbox, or content in a notification) | Payloads are validated ids and enums only; text is built at read time from item titles and only for items the reader may view; RLS confines a user context to its own notification and preference rows; email is recorded but never sent in this release |
| **Dashboard over-disclosure** | Aggregates are computed only over items the viewer may view; a team filter the viewer may not use is indistinguishable from an empty team |
| **Job replay / duplicates** | Idempotent handlers keyed on external IDs; unique constraints |
| **Dependency / supply chain** | Lockfile, audit in CI, minimal dependencies, pinned versions |

## 3. Privacy
- Monitoring employee communications can carry legal and policy obligations (consent, notice, works-council or labor rules, privacy law). Obtain legal/HR sign-off and define disclosure before any real data.
- Monitored-source allowlist: only explicitly authorized mailboxes, labels and spaces.
- Visibility: users see only items from sources and teams they are permitted to see; no broadening beyond native access.
- Data minimization: store only what's required; attachments metadata only; redact obvious secrets and identifiers before LLM calls.
- Retention: configurable per-organization windows (defaults 30 days for raw payloads, 180 for bodies), enforced by a daily job, never touching content of an open item; deletion tested. See `docs/runbooks/retention.md`.
- Subject rights: **erasure** of a person's data is built and audited (`ops:erase-person`); **export** is not (a known gap).
- LLM provider: review data-handling and retention terms; use zero-retention options where available; no training on customer content.
- Logs, analytics, error trackers must never receive message content.

## 4. Integration risks

**Gmail** (implemented in Sprint 11; see `docs/ARCHITECTURE.md` section 4e)
- Controls in place: one read-only scope; PKCE and signed, expiring, admin-bound `state` plus an HttpOnly nonce cookie; admin-only at every step; tokens encrypted at rest with context-bound AAD, in a table only one module may touch, never logged or audited; credentials deleted and the grant revoked on disconnect; Pub/Sub push accepted only with Google's signed token (audience, service account, expiry); the integration is a feature flag that is off by default; the endpoint override used by tests is loopback-only and refused in production.
- Still true:
- Restricted scopes require Google verification and a security assessment for production apps.
- Pub/Sub `watch` expires after 7 days: renewal job and alerting required.
- `historyId` gaps force full resync; handle rate limits and quotas with backoff.
- Thread vs. message semantics; delegated/shared mailboxes; labels as source filters.

**Google Chat** (decided in Sprint 12; see `docs/GOOGLE_CHAT.md`)
- Controls in place: app authentication only (no domain-wide delegation, no per-user tokens), so private DMs are out of reach by construction; one product-wide service account held as an env secret (never logged, never in a job, audit row or error; the key file's `token_uri` is ignored so a doctored file cannot redirect a signed assertion); a space is bound to an organization only by a **posted proof code** and to at most one organization at a time (locked), so one customer cannot claim another's space; admin-only at every step; a space the app cannot read is skipped, not disabled; the integration is a feature flag that is off by default; a subject is built from the sender, never from message text (subjects are unencrypted).
- Still true: anyone who is a member of a space (an external guest, say) can post a code and so bind it to *their* organization if it is not already bound; binding gives the binder's tenant a copy of messages that member could already read. Mitigation to consider before real use: admin approval from the space's owning domain. Whether the app sees a space is decided by who adds it, which a Workspace admin can restrict.
- Message edits/deletes and threading differ from email; normalization tolerates this (see the decision record's limits).

**Correlation**
- A false merge hides work (worse than a false split). Every match, however strong, goes to human review: there is no auto-link. Decisions are audited, reversible by a split until the attached conversation has moved the item forward, and limited to people who may act on the item and see the message. The advisory model can only suppress a candidate, never link one. Stored rationale holds counts only, not message text.

**AI quality**
- Models can misjudge ack vs. substantive, or "resolved" from polite closings. Mitigated by confidence thresholds, human gates, golden sets, and tracking reviewer overrides as a quality signal.

## 5. Security controls checklist (verified in Sprint 13; evidence in `docs/SECURITY_REVIEW.md`)
Verified on synthetic data and against a fake Google. "Tested" means a test in this repository fails if the control breaks.
- [x] RLS enabled and tested on all tenant tables (catalog test over every table with `organizationId`, plus direct database-layer tests for the newer tables)
- [x] Append-only enforcement tested (including the narrow, tested exception for raw-payload retention and key rotation)
- [x] Token encryption and rotation tested (encryption and context binding for tokens and claim codes; `ops:rotate-key` for every encrypted column)
- [x] Webhook verification tested (Pub/Sub token verification, against a fake Google)
- [x] Injection fixture suite green
- [x] Confirm/close require human: tested
- [x] No content in logs: tested on the ingestion, Gmail, Chat, retention and analysis paths; there is no global guard beyond the typed `log()` helper, so new code must keep to it
- [x] Retention jobs tested
- [x] Dependency and secret scans in CI
- [x] Incident response and key-rotation runbooks written (`docs/runbooks/`)
- [ ] Anything about real providers, real data or a real deployment: **not verified**; see the known gaps in `docs/SECURITY_REVIEW.md`
