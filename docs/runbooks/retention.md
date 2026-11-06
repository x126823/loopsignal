# Retention and erasure

How long stored content is kept, how it is removed, and how to honour a request to erase a person.

## What is kept, and for how long

| Data | Kept | Removed by |
|---|---|---|
| Raw provider payloads (`RawEvent`) | 30 days after receipt (default) | Daily retention pass: the row is deleted |
| Message bodies, and the quotes copied from them into analysis runs | 180 days after the item **closed**, or after the message arrived if it belongs to no item (default) | Daily retention pass: the body becomes an encrypted tombstone, the hash is cleared, `contentPurgedAt` is set; quotes become `[removed by retention]` |
| Items, lifecycle events, approvals, SLA timers, notifications, audit log | Indefinitely | Not touched. They hold ids and metadata, not message text |

Rules the SQL enforces (`retention_expired_message_ids`, `retention_purge_raw_events`):
- Content of a message that belongs to an item that is **still open** is never removed, however old. A message belongs to an item through its thread, or because a conversation was attached to the item from another channel.
- A thread with several items is protected until **all** of them are closed.
- Removing something already removed changes nothing; a pass can be interrupted and repeated.

Administrators set the windows per organization on **Settings → Retention** (floors: raw payloads at least 7 days, bodies at least 90 days, and raw payloads never longer than bodies). Invalid stored values fall back to the defaults, never to "keep forever" or "delete now". Changes are audited with the before and after values.

## The daily pass

The worker runs retention and the audit-chain check once a day for every organization (`MAINTENANCE_JOBS_ENABLED=false` stops the schedules). The Retention page shows the last removal and the last audit check. A pass handles up to 500 rows per step and 40 steps per organization; a larger backlog is finished by the next pass (the audit entry says `complete: false`).

Run one now:
```
npm run ops:retention                  # every organization
npm run ops:retention -- --org <id>    # one
```
It prints counts only. **Removal is irreversible**; check the windows first.

## The raw-payload exception to "append-only"

`RawEvent` is append-only for every role, with one narrow exception that exists only so retention and key rotation can work: a dedicated `NOLOGIN` role, `loopsignal_maint`, owns three `SECURITY DEFINER` functions, and the guard trigger lets that role (and only while it runs inside those functions) delete a row or change the encrypted `payload` column. Each function refuses an organization other than the caller's tenant context. Direct statements from the app role, the table owner, or anyone else are rejected; `LifecycleEvent` and `AuditLog` have no exception at all. This is covered by tests (`tests/integration/retention.test.ts`) that attack it from the app role, from the owner, from a fake maintenance role, across tenants and without context.

## Erasing a person (subject rights)

A person may ask for what you hold about them to be removed. This removes **everything they wrote**, in every channel, whatever its age or the state of the item: message bodies (tombstoned), the raw payloads behind them (deleted), the quotes copied into analysis runs, the subject of their messages (`[erased]`), and their name and address (the participant becomes `erased:<id>`, unlinked).

```
npm run ops:erase-person -- --org <organizationId> --participant <participantId> --as <adminUserId>          # checks only
npm run ops:erase-person -- --org <organizationId> --participant <participantId> --as <adminUserId> --yes    # does it
```
It runs as an organization administrator, so the audit log records who did it (`participant.erased`, with counts, no content), and prints counts only. Find the participant id from the organization's data (for Chat, the People in Chat list).

What it does **not** remove, by design (say so to the requester):
- What **other people** wrote about them, and replies that quote them.
- **Item titles**, which are shown to the people working the item and may contain a name. Edit those through the product if needed.
- The message rows, ids, times and directions, the items and the audit log: that is the lifecycle record, and it holds no text.
- **Backups** taken before the erasure (see [Backup and restore](backup-restore.md)), until they expire.

**Export** of a person's data is not built. If a request arrives: query `Message`/`Participant` for the participant id (metadata) and decrypt their bodies with the field key under supervision, and record the request in your own log. Building a proper export is listed as follow-up work.
