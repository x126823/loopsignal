# Database Design

PostgreSQL via Prisma. All tenant-owned tables include `organizationId` (FK, indexed, first column of composite indexes) and are covered by RLS. IDs are UUIDv7 or cuid. Timestamps are `timestamptz`.

## Entities

### Tenancy and identity
- **Organization**: id, name, settings (json), createdAt
- **User** (global): id, email (unique), name
- **Membership**: organizationId, userId, role (`ORG_ADMIN|TEAM_LEAD|MEMBER|VIEWER|AUDITOR`); unique (org, user)
- **Team**: organizationId, name
- **TeamMember**: teamId, userId, role

### Sources
- **SourceConnection**: organizationId, provider (`GMAIL|GOOGLE_CHAT|SYNTHETIC`), ownerUserId, encryptedCredentialRef (unused: credentials live in `ConnectionCredential`), scopes, status (`ACTIVE|PAUSED|REVOKED|ERROR`)
- **ConnectionCredential** (Sprint 11): organizationId, connectionId (unique with org, cascade), tokens (`Bytes`, AES-256-GCM of the access and refresh token, AAD = `<org>:ConnectionCredential.tokens:<connection>`), accessTokenExpiresAt, watchExpiresAt. RLS with select, insert, update and delete policies. Only `src/modules/sources` queries it (enforced by a test).
- **SourceClaim** (Sprint 12): organizationId, provider, externalId (the space), teamId (same-tenant FK), code (`Bytes`, AES-GCM, AAD `<org>:SourceClaim.code`), status (`PENDING|VERIFIED|SUPERSEDED`), createdByUserId, createdAt, expiresAt, verifiedAt. One `PENDING` claim per (org, provider, externalId) (partial unique index). RLS: select, insert, update.
- **MonitoredSource**: connectionId, kind (`MAILBOX|LABEL|SPACE`), externalId, teamId, enabled
- **SourceCursor**: monitoredSourceId, cursor (historyId / sync token), updatedAt
- **WebhookSubscription**: connectionId, externalId, expiresAt, status

### Messages
- **RawEvent**: organizationId, provider, externalId, payload (encrypted json), payloadHash, receivedAt. Immutable. Unique (org, provider, externalId).
- **Message**: organizationId, monitoredSourceId, threadId, externalMessageId, senderParticipantId, sentAt, subject, bodyText (encrypted), bodyHash, direction. Unique (org, provider, externalMessageId).
- **Thread**: organizationId, provider, externalThreadId, canonicalKey. Unique (org, provider, externalThreadId).
- **Participant**: organizationId, address/handle, displayName, userId (nullable link to internal user)
- **Attachment**: messageId, name, mime, size (metadata only; no content in v1)

### Lifecycle
- **TrackedItem**: organizationId, teamId, ownerUserId (nullable), originMessageId, threadId, title, priority, state, slaPolicyId, `ackAt`, `firstSubstantiveResponseAt`, `resolvedAt`, `closedAt`, `reopenCount`, `version`, flags (`needsReview`)
- **ItemMessageLink**: itemId, messageId, role (`ORIGIN|ACK|RESPONSE|PROGRESS|RESOLUTION|OTHER`). Unique (item, message). `OTHER` is a message attached from another channel; it takes the transition's role when it first drives one. The only tenant table where the app role may DELETE (to detach a thread on a split), confined by RLS.
- **LifecycleEvent** (append-only): itemId, cycle, fromState, toState, actorType (`USER|SYSTEM|ANALYZER`), actorId, analysisRunId, evidence (json), reason, createdAt
- **ItemOwnership**: itemId, userId, assignedBy, assignedAt, endedAt
- **ApprovalRequest**: itemId, requestedTransition, requestedBy, status (`PENDING|APPROVED|REJECTED|EXPIRED`), decidedBy, decidedAt, reason

### Correlation and review
- **CorrelationCandidate**: organizationId, subjectType (`Message`), subjectId, targetItemId, score (0..1), rationale (json `{v, signals[], verdict?}`: counts and numbers only, no message text), status (`PENDING|CONFIRMED|REJECTED`), decidedBy and decidedAt (both set exactly when decided, CHECK), followUpAt (stamped once the follow-up jobs were queued). Unique (org, subjectType, subjectId, targetItemId). A split is recorded as `REJECTED`.
- **ReviewTask**: organizationId, type (`LOW_CONFIDENCE|CORRELATION|SCHEMA_FAILURE|OWNERSHIP`), refType, refId, status, assignedTo, resolution

### AI
- **AnalysisRun**: organizationId, analyzer, itemId (nullable), messageId (nullable), provider, model, promptVersion, inputHash, output (json, validated), confidence, evidence (json), recommendedAction, requiresHumanApproval, status (`OK|SCHEMA_FAILED|REJECTED_GUARD`), tokensIn, tokensOut, createdAt. Unique (organizationId, analyzer, inputHash, promptVersion) for caching. The key is scoped by organization so a cache hit can never cross tenants.

### SLA
- **SlaPolicy**: organizationId, name (unique per org), scope (teamId / monitoredSourceId / priority, each nullable), ackTargetSec, responseTargetSec, resolveTargetSec, closeTargetSec (CHECK: ack <= response <= resolve <= close), calendarId (nullable = continuous time), warnAtPct
- **BusinessCalendar**: organizationId, timezone (IANA), hours (json: weekday -> list of ["HH:MM","HH:MM"] ranges), holidays (json: "YYYY-MM-DD" list)
- **SlaTimer**: itemId, cycle (>= 1, new on reopen), type (`ACK|RESPONSE|RESOLVE|CLOSE`), startedAt, dueAt and warnAt (frozen at creation), state (`RUNNING|MET|WARNED|BREACHED|CANCELLED`), resolvedAt. Unique (itemId, cycle, type). A derived read model: rebuilt from events, never edited by hand.
- **SlaBreach**: timerId (unique: one breach per timer), breachedAt (the timer's due time), acknowledgedBy

### Other
- **Notification**, **NotificationPreference**: recipient, type (`sla_warning|sla_breach|approval_requested|review_correlation|review_ownership`), payload (validated, ids and enums only), channel (`IN_APP|EMAIL`), readAt, dedupeKey (unique with org, recipient and channel: one notification per event), deliveredAt (always NULL for EMAIL: CHECK, nothing is sent yet). Both tables are personal: when a request carries a user, RLS limits reads and updates to that user's own rows.
- **AuditLog** (append-only, hash-chained): organizationId, actorType, actorId, action, entityType, entityId, metadata (json), prevHash, hash, createdAt
- **MetricSnapshot**: organizationId, teamId, period, metrics (json). Unused: dashboards are computed live from events and timers.

## Key relationships

```
Organization 1─N Team 1─N TeamMember N─1 User
Organization 1─N SourceConnection 1─N MonitoredSource 1─N Message N─1 Thread
TrackedItem 1─N LifecycleEvent | SlaTimer | AnalysisRun | ApprovalRequest | ItemOwnership
TrackedItem N─N Message  (via ItemMessageLink)
TrackedItem N─1 SlaPolicy N─1 BusinessCalendar
CorrelationCandidate N─1 TrackedItem
```

## Constraints and integrity

- Dedup: unique (org, provider, externalMessageId) and (org, provider, externalThreadId). One open `TrackedItem` per `(organizationId, threadId)` (partial unique index where state ≠ CLOSED).
- `LifecycleEvent`, `AuditLog` and `RawEvent`: append-only. The app role has INSERT and SELECT only (no UPDATE, DELETE or TRUNCATE grant), RLS has no UPDATE or DELETE policy, and triggers reject UPDATE, DELETE and TRUNCATE for every role including the owner. (A superuser can still disable triggers or set `session_replication_role`: a deliberate break-glass, never an app path.)
- `AuditLog` hash chain: per organization. A BEFORE INSERT trigger takes a per-org advisory lock, assigns the next `seq`, sets `prevHash` to the previous row's `hash`, and computes `hash` = sha256 over seq, prevHash, org, actor, action, entity, metadata and timestamp. Caller-supplied values are overwritten. `audit_verify_chain(org)` returns NULL when intact, else the first bad `seq`; it requires `app.org_id` to equal `org` so RLS cannot hide rows and report a false pass. Limit: deleting the newest rows is undetectable without anchoring the head hash outside the database.
- One open `TrackedItem` per thread is a partial unique index. Optional references (for example `MonitoredSource.teamId`, `Message.rawEventId`) are composite FKs on `(organizationId, id)` declared in migration SQL, because Prisma cannot express a composite FK with a nullable half; every FK between tenant tables is therefore same-tenant.
- Encrypted columns (`Message.bodyText`, `RawEvent.payload`) are `Bytes`: `version | iv | tag | ciphertext`, AES-256-GCM with the row's context as AAD (`src/lib/crypto`).
- Metric timestamps on `TrackedItem` are written only by the lifecycle module, in the same transaction as the event that causes them.
- Reopen: new cycle number on events; prior timestamps preserved in events; item-level timestamps reflect the current cycle.
- Cross-tenant reads are limited to narrow `SECURITY DEFINER` functions that return ids only: `sla_scan_org_ids()`, `gmail_scan_org_ids()` (organizations with an active Gmail connection) `gmail_mailbox_sources(address)` (enabled mailbox sources watching an address, for the Pub/Sub endpoint, which never knows the organization), `chat_scan_org_ids()` (organizations with an enabled Chat space) and `chat_space_bound_elsewhere(space, org)` (a boolean: is this space bound by another organization? It also takes a per-space advisory lock until the caller's transaction ends, so two organizations cannot bind the same space at once). Everything done afterwards runs under that organization's own context.
- Encryption: message bodies, raw payloads, and credentials encrypted at the application layer (envelope encryption).
- RLS: policy `"organizationId" = app_org_id()` (reads `app.org_id`, NULL when unset) on all tenant tables, `FORCE`d; `Membership` also readable by `userId = app_user_id()`; `User` and `Organization` have their own policies (see migration `tenancy_core`). App role is non-superuser, non-owner, no `BYPASSRLS`, with per-table grants.

## Indexing (initial)

- `TrackedItem (organizationId, state, ownerUserId)`, `(organizationId, teamId, state)`
- `SlaTimer (state, dueAt)` for breach scans
- `Message (organizationId, threadId, sentAt)`
- `LifecycleEvent (itemId, createdAt)`
- `AnalysisRun (organizationId, itemId)`, plus the cache unique key

## Retention

Per organization (`Organization.settings.retention`, administrators only): raw payload window (default 30 days, minimum 7) and message body window (default 180, minimum 90; a raw payload may not outlive the body it copies). Enforced daily; never touches content of an item that is still open; lifecycle events and the audit log hold ids and metadata, not message text, and are kept. Details and the exact rules: `docs/runbooks/retention.md`.

- `Message.contentPurgedAt`: set when the body was replaced by a tombstone (retention or erasure). The row, its ids and its metadata stay.
- `RawEvent` rows are deleted by retention, through `retention_purge_raw_events` and `retention_purge_raw_events_for_messages`; `Message.rawEventId` is cleared first. `retention_rekey_raw_event` replaces only the encrypted payload (key rotation). These three functions are owned by the `NOLOGIN` role `loopsignal_maint`, which is the only role the `RawEvent` guard trigger lets delete or re-encrypt; the guard rejects every other change, and TRUNCATE.
- `retention_expired_message_ids(org, cutoff, max)` is the rule for which messages are due (invoker rights, so row-level security scopes it).
- `maintenance_org_ids()` lists every organization for the daily jobs (ids only).
- `User.sessionsValidAfter`: sessions issued before this moment are void ("sign out everywhere"). A person updates their own row (policy `user_update`); `revoke_member_sessions(org, target, at)` lets an organization administrator do it for a member (it checks the tenant context, that the caller is an administrator of that organization, and that the target is a member, and changes only that column).
- `chat_space_claimed_earlier(space, org, claim_created, at)`: is there another organization's earlier, still-open claim on this space? A boolean only; it lets the first organization to ask keep its place.
