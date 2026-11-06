# Audit log integrity

`AuditLog` is append-only and hash-chained per organization: each row's hash covers the previous row's hash, so changing or deleting a row breaks every row after it. A daily job verifies every organization's chain and records the result **in the chain itself** (`audit.chain_verified`, with `intact` and, if broken, `firstBadSeq`). The Retention page shows the latest result.

## You were told the chain is broken

Log event `audit.chain_broken` (error level, with `organizationId` and `firstBadSeq`), and the page says "Audit log check FAILED".

It means rows were **altered or removed outside the application**: the application cannot do it, the database grants and triggers forbid it, even to the table owner. Realistic causes: someone with superuser access (break-glass), a bad restore or migration run with triggers disabled, or storage corruption. Treat it as a security incident until shown otherwise.

1. **Preserve.** `MAINTENANCE_JOBS_ENABLED=false` (so nothing else changes), keep the database as it is, take a dump (`pg_dump -Fc`) **without** running anything that writes. Do not try to repair the chain.
2. **Scope it.** `firstBadSeq` is the first row that no longer verifies; rows before it are intact. Everything from there is untrusted.
3. **Compare with a backup.** Restore the newest backup from before the problem into a scratch database (see [Backup and restore](backup-restore.md)) and compare the organization's `AuditLog` rows around `firstBadSeq`: the differing row(s) show what changed and, with the timestamps, roughly when.
4. **Find the cause:** database logs and role activity around that time; who had superuser; whether a restore or migration ran with `session_replication_role = replica` or triggers disabled.
5. **Escalate** per [Incident response](incident-response.md). Tell the affected organization's administrators what the integrity statement can and cannot support.
6. **Do not erase the evidence by "fixing" it.** After the investigation, the correct way forward is to record what happened (a new, correctly chained entry) and, if you restore a clean backup, to say so.

## Limits you should know

- Deleting the **newest** rows cannot be detected from inside the database: with nothing after them, the remaining chain still verifies. Anchoring the head hash somewhere the database owner cannot reach (a write-once store, a signed daily digest) closes this. It is not built.
- The check proves internal consistency, not that the recorded facts were true.
- A failure of the job itself (for example the database unreachable) logs `audit.verify_failed`; treat repeated failures as an outage of the check.
