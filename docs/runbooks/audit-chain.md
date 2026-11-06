# Audit log integrity

`AuditLog` is append-only and hash-chained per organization: each row's hash covers the previous row's hash, so changing or deleting a row breaks every row after it. A daily job verifies every organization's chain and records the result **in the chain itself** (`audit.chain_verified`, with `intact` and, if broken, `firstBadSeq`). The Retention page shows the latest result.

## Anchors: catching deleted newest rows

The hash chain proves rows were not changed or removed from the middle. **Deleting the newest rows** leaves a shorter chain that still verifies, so the chain alone cannot see it. An **anchor** closes that gap: a snapshot of an organization's audit head (its sequence number and hash), signed with an HMAC key, kept somewhere the database owner cannot rewrite. Later the live chain must still contain that exact row. If the newest rows are gone the head is behind the anchor; if anything before it was rewritten, the hash at that sequence differs. An anchor holds an organization id, a number and a hash, never content.

**Set it up** (it is off until you do; the Retention page says "Signed audit anchors are off" in the meantime):
1. `AUDIT_ANCHOR_KEY=<32+ random characters>`. **Keep this key apart from the database**: whoever holds both can forge anchors.
2. Either or both of:
   - **`AUDIT_ANCHOR_FILE=/path/anchors.jsonl`**: the daily job appends an anchor per organization and checks the chain against **every** earlier anchor in the file each day. Put the file on storage the database host cannot rewrite (append-only or write-once; a mounted object store). A mismatch raises the `audit.anchor_mismatch` alert and records `intact: false` in the chain; a damaged chain is never anchored.
   - **The log line** `audit.anchor` (info), emitted every day, which you ship to a store of your own (a write-once log bucket). Use the commands below to check later.
3. By hand, any time: `npm run ops:audit-anchors -- emit > today.jsonl` (an anchor per organization; save it somewhere safe) and `npm run ops:audit-anchors -- verify --file saved-anchors.jsonl` (exit 1 and the organization and sequence of every mismatch, with the kind: `HEAD_BEHIND` newest rows deleted, `MISSING` a row removed, `HASH_MISMATCH` rewritten).

An anchor whose signature does not verify (forged, edited, or signed with another key) is counted as `invalid` and proves nothing; it never causes a false alarm and never hides a real problem. A line that is not an anchor is logged (`audit.anchor_file_malformed`).

What anchors do **not** do: they only protect what was anchored before the damage (rows added after the last anchor and then deleted are invisible until the next one; the daily cadence bounds that to a day), and they are only as trustworthy as the place you keep them.

## You were told the chain is broken

Log event `audit.chain_broken` (error level, with `organizationId` and `firstBadSeq`), a `critical` alert if alerting is on, and the page says "Audit log check FAILED". A **`audit.anchor_mismatch`** means the same and is handled the same way, with this extra: a `HEAD_BEHIND` result means rows after the anchored point were deleted, and the anchor tells you the last sequence number that provably existed.

It means rows were **altered or removed outside the application**: the application cannot do it, the database grants and triggers forbid it, even to the table owner. Realistic causes: someone with superuser access (break-glass), a bad restore or migration run with triggers disabled, or storage corruption. Treat it as a security incident until shown otherwise.

1. **Preserve.** `MAINTENANCE_JOBS_ENABLED=false` (so nothing else changes), keep the database as it is, take a dump (`pg_dump -Fc`) **without** running anything that writes. Do not try to repair the chain.
2. **Scope it.** `firstBadSeq` is the first row that no longer verifies; rows before it are intact. Everything from there is untrusted.
3. **Compare with a backup.** Restore the newest backup from before the problem into a scratch database (see [Backup and restore](backup-restore.md)) and compare the organization's `AuditLog` rows around `firstBadSeq`: the differing row(s) show what changed and, with the timestamps, roughly when.
4. **Find the cause:** database logs and role activity around that time; who had superuser; whether a restore or migration ran with `session_replication_role = replica` or triggers disabled.
5. **Escalate** per [Incident response](incident-response.md). Tell the affected organization's administrators what the integrity statement can and cannot support.
6. **Do not erase the evidence by "fixing" it.** After the investigation, the correct way forward is to record what happened (a new, correctly chained entry) and, if you restore a clean backup, to say so.

## Limits you should know

- Without anchors, deleting the **newest** rows cannot be detected from inside the database. With anchors it can, up to the last anchor taken (see above).
- The check proves internal consistency, not that the recorded facts were true.
- A failure of the job itself (for example the database unreachable) logs `audit.verify_failed`; treat repeated failures as an outage of the check.
