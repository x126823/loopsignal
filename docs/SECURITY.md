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
- Retention: configurable windows for raw payloads and bodies; shorter than lifecycle/audit retention; deletion jobs tested.
- Subject rights: ability to export and delete a person's data where applicable.
- LLM provider: review data-handling and retention terms; use zero-retention options where available; no training on customer content.
- Logs, analytics, error trackers must never receive message content.

## 4. Integration risks

**Gmail**
- Restricted scopes require Google verification and a security assessment for production apps.
- Pub/Sub `watch` expires after 7 days: renewal job and alerting required.
- `historyId` gaps force full resync; handle rate limits and quotas with backoff.
- Thread vs. message semantics; delegated/shared mailboxes; labels as source filters.

**Google Chat**
- Reading other users' messages generally needs an app added to the space or domain-wide delegation with admin approval; capabilities differ for DMs vs. spaces.
- Event subscription support and scopes are limited and change over time. **Early spike required (Sprint 12)** before committing to features that depend on it.
- Message edits/deletes and threading differ from email; normalization must tolerate this.

**Correlation**
- A false merge hides work (worse than a false split). Every match, however strong, goes to human review: there is no auto-link. Decisions are audited, reversible by a split until the attached conversation has moved the item forward, and limited to people who may act on the item and see the message. The advisory model can only suppress a candidate, never link one. Stored rationale holds counts only, not message text.

**AI quality**
- Models can misjudge ack vs. substantive, or "resolved" from polite closings. Mitigated by confidence thresholds, human gates, golden sets, and tracking reviewer overrides as a quality signal.

## 5. Security controls checklist (verified in Sprint 13)
- [ ] RLS enabled and tested on all tenant tables
- [ ] Append-only enforcement tested
- [ ] Token encryption and rotation tested
- [ ] Webhook verification tested
- [ ] Injection fixture suite green
- [ ] Confirm/close require human: tested
- [ ] No content in logs: tested
- [ ] Retention jobs tested
- [ ] Dependency and secret scans in CI
- [ ] Incident response and key-rotation runbooks written
