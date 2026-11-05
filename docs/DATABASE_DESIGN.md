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
- **AnalysisRun**: organizationId, analyzer, itemId (nullable), messageId (nullable), provider, model, promptVersion, inputHash, output (json, validated), confidence, evidence (json), recommendedAction, requiresHumanApproval, status (`OK|SCHEMA_FAILED|REJECTED_GUARD`), tokensIn, tokensOut, createdAt. Unique (analyzer, inputHash, promptVersion) for caching.

### SLA
- **SlaPolicy**: organizationId, name, scope (team/source/priority), ackTargetSec, responseTargetSec, resolveTargetSec, closeTargetSec, calendarId, warnAtPct
- **BusinessCalendar**: organizationId, timezone, hours (json), holidays (json)
- **SlaTimer**: itemId, type (`ACK|RESPONSE|RESOLVE|CLOSE`), startedAt, dueAt, state (`RUNNING|MET|WARNED|BREACHED|CANCELLED`), resolvedAt
- **SlaBreach**: timerId, breachedAt, acknowledgedBy

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
- `LifecycleEvent` and `AuditLog`: INSERT-only grants for the app role; trigger rejects UPDATE/DELETE.
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
