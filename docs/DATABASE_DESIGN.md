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
- **SourceConnection**: organizationId, provider (`GMAIL|GOOGLE_CHAT|SYNTHETIC`), ownerUserId, encryptedCredentialRef, scopes, status
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
- **ItemMessageLink**: itemId, messageId, role (`ORIGIN|ACK|RESPONSE|PROGRESS|RESOLUTION|OTHER`). Unique (item, message).
- **LifecycleEvent** (append-only): itemId, cycle, fromState, toState, actorType (`USER|SYSTEM|ANALYZER`), actorId, analysisRunId, evidence (json), reason, createdAt
- **ItemOwnership**: itemId, userId, assignedBy, assignedAt, endedAt
- **ApprovalRequest**: itemId, requestedTransition, requestedBy, status (`PENDING|APPROVED|REJECTED|EXPIRED`), decidedBy, decidedAt, reason

### Correlation and review
- **CorrelationCandidate**: organizationId, subjectType, subjectId, targetItemId, score, rationale (json), status (`PENDING|CONFIRMED|REJECTED`), decidedBy
- **ReviewTask**: organizationId, type (`LOW_CONFIDENCE|CORRELATION|SCHEMA_FAILURE|OWNERSHIP`), refType, refId, status, assignedTo, resolution

### AI
- **AnalysisRun**: organizationId, analyzer, itemId (nullable), messageId (nullable), provider, model, promptVersion, inputHash, output (json, validated), confidence, evidence (json), recommendedAction, requiresHumanApproval, status (`OK|SCHEMA_FAILED|REJECTED_GUARD`), tokensIn, tokensOut, createdAt. Unique (organizationId, analyzer, inputHash, promptVersion) for caching. The key is scoped by organization so a cache hit can never cross tenants.

### SLA
- **SlaPolicy**: organizationId, name (unique per org), scope (teamId / monitoredSourceId / priority, each nullable), ackTargetSec, responseTargetSec, resolveTargetSec, closeTargetSec (CHECK: ack <= response <= resolve <= close), calendarId (nullable = continuous time), warnAtPct
- **BusinessCalendar**: organizationId, timezone (IANA), hours (json: weekday -> list of ["HH:MM","HH:MM"] ranges), holidays (json: "YYYY-MM-DD" list)
- **SlaTimer**: itemId, cycle (>= 1, new on reopen), type (`ACK|RESPONSE|RESOLVE|CLOSE`), startedAt, dueAt and warnAt (frozen at creation), state (`RUNNING|MET|WARNED|BREACHED|CANCELLED`), resolvedAt. Unique (itemId, cycle, type). A derived read model: rebuilt from events, never edited by hand.
- **SlaBreach**: timerId (unique: one breach per timer), breachedAt (the timer's due time), acknowledgedBy

### Other
- **Notification**, **NotificationPreference**: recipient, type, payload (no message content beyond ids), channel, readAt
- **AuditLog** (append-only, hash-chained): organizationId, actorType, actorId, action, entityType, entityId, metadata (json), prevHash, hash, createdAt
- **MetricSnapshot**: organizationId, teamId, period, metrics (json)

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
- Encryption: message bodies, raw payloads, and credentials encrypted at the application layer (envelope encryption).
- RLS: policy `"organizationId" = app_org_id()` (reads `app.org_id`, NULL when unset) on all tenant tables, `FORCE`d; `Membership` also readable by `userId = app_user_id()`; `User` and `Organization` have their own policies (see migration `tenancy_core`). App role is non-superuser, non-owner, no `BYPASSRLS`, with per-table grants.

## Indexing (initial)

- `TrackedItem (organizationId, state, ownerUserId)`, `(organizationId, teamId, state)`
- `SlaTimer (state, dueAt)` for breach scans
- `Message (organizationId, threadId, sentAt)`
- `LifecycleEvent (itemId, createdAt)`
- `AnalysisRun (organizationId, itemId)`, plus the cache unique key

## Retention

Configurable per org: raw payload and message body retention windows; lifecycle events and audit log retained longer, containing ids and metadata but not message content.
