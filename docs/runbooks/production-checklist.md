# Production checklist

Nothing in this repository has been run against real data or a real deployment. This is the list of things that must be true before it is, taken from what Sprint 13 found. Tick each one for the environment you are standing up.

**Rehearse it first.** `npm run build && npm run rehearse:production` runs everything on this list that does not depend on your environment, for real: a database built from zero, the actual web and worker processes in production mode, refusal of every bad configuration, security headers, sign-in and role checks, schedules, a retention pass and the restore drill, each reported PASS or FAIL (35 checks; it runs in CI too). It cannot check the items marked *yours* below; it prints them at the end.

## Configuration (the web server and the worker both exit at start-up, naming the setting, if any of the first four are wrong)

- [ ] `NODE_ENV=production`.
- [ ] `AUTH_URL` is the public **https** URL (http is accepted only for localhost). It pins the host Auth.js trusts; without it nobody can sign in. *(Sprint 13 fixed a bug that made every production sign-in fail with `UntrustedHost`, even with this set.)*
- [ ] `AUTH_DEV_LOGIN` is `false` (production refuses `true`).
- [ ] `AUTH_SECRET` and `FIELD_ENCRYPTION_KEY` are long random values from a secret store (generate them with `npm run ops:generate-secrets`), different per environment, and `FIELD_ENCRYPTION_KEY` is **backed up separately from the database**. Production refuses the published development key, the development session secrets and the development database passwords at start-up (a database backup without the field key is unreadable by design).
- [ ] `GMAIL_ENABLED` / `GOOGLE_CHAT_ENABLED` are `false` until the user has authorized real data, a Google Cloud project is verified for the restricted scopes, and the connection runbook has been read. `GOOGLE_TEST_BASE_URL` must not be set (production refuses it).
- [ ] `LLM_PROVIDER` is what you intend; `fake` never contacts a model. Review the provider's data-retention terms first (SECURITY.md).

## Database

- [ ] The migration role can create roles (the Sprint 13 migration creates `loopsignal_maint`) and bypasses row-level security. The scan and maintenance functions run with the owner's rights and return nothing if it cannot bypass RLS.
- [ ] `loopsignal_app` is created **before the migrations run** (they grant to it and assume it exists; only the development Docker setup creates it for you, with a published password), with its own strong password, and provisioned out of band: non-superuser, non-owner, `NOBYPASSRLS`, with the per-table grants the migrations give it. The application connects only as this role.
- [ ] `loopsignal_maint` exists, `NOLOGIN`. Nothing may ever log in as it.
- [ ] `DB_POOL_MAX` (default 20) times the number of web and worker processes stays under Postgres `max_connections` with headroom for migrations and backups.
- [ ] Backups run and the restore drill passes ([Backup and restore](backup-restore.md)).

## Workers

- [ ] `npm run worker` is running (ingestion, analysis, SLA scan, correlation follow-up, retention, audit verification, and the Gmail/Chat scans when enabled). Exactly the schedules you expect exist: `MAINTENANCE_JOBS_ENABLED` is `true`.
- [ ] `ALERT_WEBHOOK_URL` is set to a receiver that actually pages someone, `ALERT_WEBHOOK_SECRET` is set and verified by the receiver, and `npm run ops:test-alert` reached a human ([Alerting](alerting.md)). Alerts cover the events that need a person; keep log-based alerting for the rest.
- [ ] Audit anchors are on (`AUDIT_ANCHOR_KEY` held apart from the database, `AUDIT_ANCHOR_FILE` on storage the database host cannot rewrite, or the `audit.anchor` log line shipped to a write-once store), so deleted newest audit rows are detectable ([Audit log integrity](audit-chain.md)).
- [ ] `SESSION_HOURS` (default 12) suits you: a sign-in lasts that long from the moment of sign-in, and people can end sessions early under Security.
- [ ] Log events at **error** level are also watched: `audit.chain_broken`, `audit.verify_failed`, `gmail.watch_renewal_failed`, `chat.app_credentials_rejected`, `retention.failed`, `worker.error`, `job.dead_lettered` (warn). The application logs them; nothing in this repository pages anyone.

## Verify after deploy

- [ ] `curl -sI https://<host>/login` shows `Content-Security-Policy` with a nonce, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and no `X-Powered-By`.
- [ ] Signing in works through the real identity provider, and an organization admin can open Connections and Retention while a member cannot.
- [ ] `npm run load:test -- --base-url <staging> --mint-session` is **not** for deployments you do not own: the minted cookie only works against a server that shares your `AUTH_SECRET`. Use it on a staging copy.
- [ ] The Retention page shows the audit log as verified within the last day.

## What the rehearsal verified, and what is yours to do

Verified by `rehearse:production`: migrations from zero; role attributes (app role not a superuser, cannot bypass row-level security, owns nothing; maintenance role cannot log in); every tenant table protected; the pool default leaving room under `max_connections`; refusal to start with no `AUTH_URL`, dev login on, the test endpoint override, an http `AUTH_URL` on a real host, or Gmail enabled without its client; the CSP and headers; integrations off by default (their endpoints answer 404); signed-out redirect; admin versus member on Retention; forged sessions refused; the worker's schedules (SLA, retention, audit verification; none for Gmail or Chat); the worker refusing an invalid key; a retention pass; the restore drill; and that every log event named under "Workers" above exists at the stated level.

**Yours, because they depend on your environment:** where secrets live and that `FIELD_ENCRYPTION_KEY` is backed up separately; the real https URL and TLS; sign-in through your real identity provider; that error-level logs actually page someone; backup schedule, off-site copies and a timed restore; your real `max_connections` and process counts; the Google Cloud project, scope verification and the LLM provider's data terms; and the user's authorization for real data plus legal/HR sign-off.

## Known gaps to close before real use

See [Incident response](incident-response.md#known-gaps) and the "Known limits" in `docs/SECURITY.md` and `docs/GOOGLE_CHAT.md`.
