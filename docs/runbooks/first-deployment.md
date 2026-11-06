# First deployment: a worksheet

The production checklist says what must be true. This is the **order to do it in** the first time, with the commands, what to decide, and how to prove each step. It assumes nothing about where you host: wherever a step says "your platform", use its equivalent. Nothing here touches real data: that needs the user's explicit authorization and legal/HR sign-off first (CLAUDE.md rule 7), and the integrations stay off until then.

Keep the answers to step 0 somewhere your team can find them.

*Running on one Mac with your own mail instead? Use [Running on your Mac with real data](local-mac.md): it automates steps 1 to 3 for a single machine.*

## 0. Decide, and write down

| Decision | Your answer |
|---|---|
| Environment name (staging first, then production) | |
| Where the web server and the worker run (one process each to start) | |
| Postgres (managed is easiest) and Redis | |
| The public https URL (`AUTH_URL`) | |
| Where secrets live (a secret manager, not files on disk) | |
| Who gets paged, through what tool (the receiver for [alerts](alerting.md)) | |
| Where audit anchors are kept: storage the database host cannot rewrite (an append-only or write-once store) | |
| Who is on call for the first weeks | |
| Legal/HR sign-off for monitoring communications, in writing | |

**Do staging first**, with synthetic data, and run everything below there before production.

## 1. Secrets

```
npm run ops:generate-secrets -- --out /somewhere/outside/the/repo/first.env
```
Writes `AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`, `AUDIT_ANCHOR_KEY` and `ALERT_WEBHOOK_SECRET` to a **new file only you can read**, and prints only their names (never values, so nothing lands in a log or a chat). Then:
1. Move each value into your secret manager. Delete the file.
2. **Back up `FIELD_ENCRYPTION_KEY` separately from the database**, to a second place that survives losing the first. Without it, every stored message, token and claim code is unreadable, and a database backup alone is useless. Losing it is unrecoverable.
3. Keep `AUDIT_ANCHOR_KEY` **apart from the database** (whoever holds both can forge anchors).
4. Configure the receiver with the same `ALERT_WEBHOOK_SECRET` (it verifies each alert's signature).

The application **refuses to start in production** with the published development key, a development session secret, or the development database passwords, so a copied `.env.example` fails loudly instead of running insecurely.

## 2. The database

Create it and its roles **before running migrations**. The migrations grant privileges to `loopsignal_app` and assume it exists; only the development Docker setup creates it for you, with a published password.
1. As a database administrator, create an empty database. Create the runtime role with **its own strong password**:
   `CREATE ROLE loopsignal_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;` (the same statement as `docker/postgres/init/01-app-role.sql`, with a real password).
2. The **owner** role that runs migrations must be able to create roles (the Sprint 13 migration creates the login-less `loopsignal_maint`) and must bypass row-level security (the scan and maintenance functions run with the owner's rights and return nothing otherwise). Use a role you control; it is **not** used by the running application.
3. `DATABASE_URL` is the owner (used only to migrate and by operator tools); `APP_DATABASE_URL` is `loopsignal_app` (what the running application uses). Never the same role.
4. Run migrations: `npm run db:deploy`.
5. **Prove it:** `npm run build && npm run rehearse:production` does all of this on a throwaway database and shows what "right" looks like (roles, row-level security on every tenant table, the app role owning nothing). Then check the real one: connect as `loopsignal_app` and confirm it is not a superuser and cannot bypass row-level security.

Sizing: `DB_POOL_MAX` (default 20) times the number of web and worker processes must stay under the server's `max_connections`, with room for migrations and backups.

## 3. Configuration

Set, in your platform's secret/config store: `NODE_ENV=production`, `AUTH_URL` (https), `DATABASE_URL`, `APP_DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`, `AUTH_DEV_LOGIN=false`, and sign-in with your identity provider (`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, invite-only: a person can sign in only if they already have a user row). Leave `GMAIL_ENABLED` and `GOOGLE_CHAT_ENABLED` **false**. Add the alerting and anchor settings from steps 4 and 5.

**Prove it:** start the web server and the worker. A wrong setting makes them exit at once, naming the setting (never its value). Both stay up with a correct one.

## 4. Alerting

1. Set `ALERT_WEBHOOK_URL` (https) and `ALERT_WEBHOOK_SECRET`; restart web and worker.
2. `npm run ops:test-alert`. It must say `"result":"sent"` **and a person must actually receive it** through your paging path. If the page reaches nobody, alerting does not work, whatever the command says.
3. Decide who is paged for `critical` (audit integrity) versus `error` and `warning`. See [Alerting](alerting.md) for what each alert means.

## 5. Audit anchors

1. Set `AUDIT_ANCHOR_KEY`, and `AUDIT_ANCHOR_FILE` pointing at storage the database host cannot rewrite (or ship the daily `audit.anchor` log line to a write-once store).
2. After the first daily check the Retention page says "Signed audit anchors are on".
3. Practise once: `npm run ops:audit-anchors -- emit > anchors.jsonl`, then `npm run ops:audit-anchors -- verify --file anchors.jsonl` (exit 0). See [Audit log integrity](audit-chain.md).

## 6. Backups, and a restore you have actually done

1. Schedule `pg_dump -Fc` (or your platform's snapshots), copy off-site, and decide how long to keep backups (keep them no longer than your content retention windows, or say so in your privacy notice).
2. **Restore one into a scratch database and run `npm run drill:restore` against it.** Time it: that is your real recovery time. See [Backup and restore](backup-restore.md).

## 7. The first sign-in and the first look around

1. Create the first organization and its administrator (the seed is synthetic and development-only; create real rows with your own script or SQL, as an owner, once).
2. Sign in through your identity provider. As that administrator confirm: Connections and Retention open, the Security page lists members, and a non-administrator is refused.
3. Check the response headers on your real URL: `curl -sI https://<host>/login` shows a nonce-based `Content-Security-Policy`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, no `X-Powered-By`.
4. Confirm the daily jobs ran (the Retention page shows the last audit check) and the worker log shows `worker.started` with the schedules.

## 8. Before any real data

Stop and re-read the [production checklist](production-checklist.md), then get, in writing: the user's authorization for real data, legal/HR sign-off, and a decision on who may connect which mailboxes and spaces. Then do the supervised test-domain pass for Gmail and Chat (`docs/GOOGLE_CHAT.md`, [Gmail and Chat](integrations.md)) with a test mailbox and a test space first.
