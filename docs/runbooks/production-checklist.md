# Production checklist

Nothing in this repository has been run against real data or a real deployment. This is the list of things that must be true before it is, taken from what Sprint 13 found. Tick each one for the environment you are standing up.

## Configuration (the process refuses to start without the first four)

- [ ] `NODE_ENV=production`.
- [ ] `AUTH_URL` is the public **https** URL (http is accepted only for localhost). It pins the host Auth.js trusts; without it nobody can sign in. *(Sprint 13 fixed a bug that made every production sign-in fail with `UntrustedHost`, even with this set.)*
- [ ] `AUTH_DEV_LOGIN` is `false` (production refuses `true`).
- [ ] `AUTH_SECRET` and `FIELD_ENCRYPTION_KEY` are long random values from a secret store, different per environment, and **backed up separately from the database** (a database backup without the field key is unreadable by design).
- [ ] `GMAIL_ENABLED` / `GOOGLE_CHAT_ENABLED` are `false` until the user has authorized real data, a Google Cloud project is verified for the restricted scopes, and the connection runbook has been read. `GOOGLE_TEST_BASE_URL` must not be set (production refuses it).
- [ ] `LLM_PROVIDER` is what you intend; `fake` never contacts a model. Review the provider's data-retention terms first (SECURITY.md).

## Database

- [ ] The migration role can create roles (the Sprint 13 migration creates `loopsignal_maint`) and bypasses row-level security. The scan and maintenance functions run with the owner's rights and return nothing if it cannot bypass RLS.
- [ ] `loopsignal_app` is provisioned out of band: non-superuser, non-owner, `NOBYPASSRLS`, with the per-table grants the migrations give it. The application connects only as this role.
- [ ] `loopsignal_maint` exists, `NOLOGIN`. Nothing may ever log in as it.
- [ ] `DB_POOL_MAX` (default 20) times the number of web and worker processes stays under Postgres `max_connections` with headroom for migrations and backups.
- [ ] Backups run and the restore drill passes ([Backup and restore](backup-restore.md)).

## Workers

- [ ] `npm run worker` is running (ingestion, analysis, SLA scan, correlation follow-up, retention, audit verification, and the Gmail/Chat scans when enabled). Exactly the schedules you expect exist: `MAINTENANCE_JOBS_ENABLED` is `true`.
- [ ] Alerting exists for log events at **error** level: `audit.chain_broken`, `audit.verify_failed`, `gmail.watch_renewal_failed`, `chat.app_credentials_rejected`, `retention.failed`, `worker.error`, `job.dead_lettered` (warn). The application logs them; nothing in this repository pages anyone.

## Verify after deploy

- [ ] `curl -sI https://<host>/login` shows `Content-Security-Policy` with a nonce, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and no `X-Powered-By`.
- [ ] Signing in works through the real identity provider, and an organization admin can open Connections and Retention while a member cannot.
- [ ] `npm run load:test -- --base-url <staging> --mint-session` is **not** for deployments you do not own: the minted cookie only works against a server that shares your `AUTH_SECRET`. Use it on a staging copy.
- [ ] The Retention page shows the audit log as verified within the last day.

## Known gaps to close before real use

See [Incident response](incident-response.md#known-gaps) and the "Known limits" in `docs/SECURITY.md` and `docs/GOOGLE_CHAT.md`.
