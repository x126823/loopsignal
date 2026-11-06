# Backup and restore

A backup nobody has restored is a hope. `npm run drill:restore` takes a real backup, restores it into a scratch database and **proves** the copy is the real thing. Run it in CI (it is), before and after risky changes, and on a schedule in each environment.

## What you need to restore

1. **The database dump** (`pg_dump -Fc`).
2. **`FIELD_ENCRYPTION_KEY`**, stored **separately** from the dump. Message bodies, raw payloads, tokens and claim codes are ciphertext; without the key they are unreadable (by design), and with a different key the drill's last check fails.
3. **The roles** `loopsignal_app` and `loopsignal_maint` (cluster-level objects; `pg_dump` of one database does not carry them). They must exist before restoring, with the privileges the migrations give them.
4. A restoring role that can restore **ownership** (a superuser in practice). Do **not** use `--no-owner`: the maintenance functions' owner is what lets retention and key rotation pass the append-only guard, and a restore that changed it would silently change who can delete raw payloads.

## The drill

```
npm run drill:restore
```
Uses `pg_dump`/`pg_restore` on the PATH, or the `postgres` service of `docker compose` if they are not installed. It always deletes the scratch database and the dump file (the dump holds data). Exit code 1 means a check failed.

Checks (each is a test, and each is proven to fail when the thing it guards is damaged; see `tests/integration/backup-restore.test.ts`):

| Check | Fails when |
|---|---|
| Backup completes and is not empty | `pg_dump` fails or produces nothing |
| Restore completes without errors | The dump cannot be loaded |
| Every table has the same number of rows | Rows were lost |
| Every organization's audit chain verifies | The audit log was altered or truncated |
| Row-level security, forcing and every policy came back | A table is no longer tenant-protected |
| The app and maintenance roles kept exactly their privileges | A grant was lost or widened |
| The append-only guards still reject changes, even from the owner | A guard trigger did not come back |
| The maintenance functions kept their owner | Ownership was not restored |
| The app role sees its own tenant's rows and nothing else | Isolation is broken in the restored copy |
| Stored content decrypts with the current key | The key and the data do not match |

Measured on the development stack (a seeded database, 210 KB dump): backup 1.0 s, restore 1.1 s, verification 0.2 s. These are not production figures; time the drill in your environment to learn your real recovery time, and size the backup schedule to the data you can afford to lose (your RPO).

## Restoring for real

1. **Stop the application and workers.** Decide whether you are restoring over the live database or into a new one (prefer a new one and switch `DATABASE_URL`).
2. Create the target database and ensure the two roles exist. Restore: `pg_restore -d <target> --exit-on-error <dump>` as a superuser.
3. Run the same verification against it: point `DATABASE_URL`/`APP_DATABASE_URL` at the restored database and run `npm run drill:restore`; it must pass on the restored copy too.
4. Set the correct `FIELD_ENCRYPTION_KEY` and start the application. Check the Retention page: the audit log verifies, and the last purge matches your expectation.
5. **Re-run retention knowingly.** A restore brings back content that retention had already removed. Until you decide otherwise it will be removed again at the next daily pass; if erasure requests were honoured since the backup, repeat them (`ops:erase-person`) before anyone can read the restored data.
6. Queue state (Redis) is not part of this backup: in-flight and delayed jobs are lost. Ingestion is idempotent and resumes from each source's stored cursor; trigger a **Sync now** on each connection, and the SLA and analysis jobs re-derive.

## Notes

- Backups contain message ciphertext and metadata, and the audit log. Treat them as sensitive; encrypt them at rest and restrict who can read them.
- Backups are subject to retention too: a backup older than your retention window still holds the content you removed. Keep backup retention at or below the content windows, or state the difference in your privacy notice.
