# Key rotation

What each secret protects, how to rotate it, and how to know it worked. Rotate on a schedule, and immediately after a suspected leak.

| Secret | Protects | Rotation impact |
|---|---|---|
| `FIELD_ENCRYPTION_KEY` | Message bodies, raw payloads, Gmail tokens, Chat claim codes | Offline re-encryption; downtime while it runs |
| `AUTH_SECRET` | Session cookies, the OAuth `state` | Everyone is signed out; in-flight Gmail consent flows fail and can be restarted |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The Gmail OAuth client | Rotate in Google Cloud, then update; existing connections keep working |
| `AUDIT_ANCHOR_KEY` | The signature on audit anchors | Anchors signed with the old key stop verifying (counted `invalid`, never a false alarm): keep the old key until you have taken fresh anchors, and verify old anchor files with the old key |
| `ALERT_WEBHOOK_SECRET` | The signature on alerts | Change it on the receiver and the sender together; alerts in between fail verification on the receiver |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | The Chat app's identity | Add a new key in Google Cloud, deploy it, disable the old one |

## FIELD_ENCRYPTION_KEY (the one that needs care)

Ciphertext is AES-256-GCM with a context binding, so it cannot be "re-labelled": every blob must be decrypted and re-encrypted. `npm run ops:rotate-key` does it for every organization, for message bodies, raw payloads (through the one maintenance function allowed to touch them), tokens and claim codes. It is **idempotent and resumable**, changes only ciphertext, never prints keys or content, and **leaves untouched, and fails loudly on, anything that opens with neither key**.

**Before:** take a backup and run the drill ([Backup and restore](backup-restore.md)). Generate the new key: `openssl rand -base64 32`. Store it in the secret store **before** you start; losing it after re-encryption loses the data.

1. **Stop the application and the workers.** Nothing may write under the old key while the script runs. (Ingestion and analysis jobs queue up and are processed afterwards.)
2. Run it with both keys (never in shell history; use your secret tooling):
   `ROTATE_FROM_KEY=<old> ROTATE_TO_KEY=<new> npm run ops:rotate-key`
3. Read the last line: `{"event":"rotate.done", ... "failed":0}`. **If `failed` is not 0, stop.** Those values are intact under neither key; do not switch keys. Find out why (a wrong "old" key, or data from a restore made under a different key).
4. Set `FIELD_ENCRYPTION_KEY` to the new key and start the application and workers.
5. **Verify:** run the script again with the same two keys; it must report everything as `alreadyCurrent` and `rewritten: 0`. Open an item with a conversation and a Connections page; run `npm run drill:restore` (it decrypts a sample with the current key).
6. Keep the old key in the secret store, disabled, for the length of your backup retention: older backups are only readable with it.

**Undo:** if step 4 or 5 fails, put the old key back and re-run the script in the other direction (`FROM` new, `TO` old). It is symmetric.

Measured: tested for bodies, raw payloads, tokens and claim codes, for resume after interruption, for blobs neither key opens, and for isolation between organizations (`tests/integration/key-rotation.test.ts`). It has not been timed against a large dataset; rewrite speed is bounded by one database round trip per row in batches of 200.

## AUTH_SECRET

1. Generate a new value (`openssl rand -base64 32`), update the secret store, restart the web process.
2. Everyone must sign in again. Gmail consent flows started before the change fail with "could not be verified" and can be restarted. (To end sessions for ONE person or a few, use **Security → Sign out everywhere** instead: a member can do it for themselves, an administrator for any member of their organization, and nobody else is signed out.)

## Google OAuth client secret (Gmail)

1. In Google Cloud, add a new secret to the OAuth client; set `GOOGLE_OAUTH_CLIENT_SECRET`; restart web and worker.
2. Delete the old secret in Google Cloud. Existing connections use refresh tokens and are unaffected; new consents use the new secret.

## Chat app service account

1. In Google Cloud create a new key for the same service account; set `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` to the whole file as one line; restart web and worker.
2. Confirm a space still syncs (Connections, **Sync now**, then the last sync time moves).
3. Delete the old key in Google Cloud. If the old key leaked, delete it first and accept a short pause in Chat sync: while the app's credentials are refused, spaces are skipped quietly (log: `chat.app_credentials_rejected`), nothing is lost, and sync resumes by itself.

## After a suspected leak

Contain first ([Incident response](incident-response.md)), then rotate the leaked secret, then check `git log -S` and your logs for how it escaped. `npm run scan:secrets` catches secrets in committed files going forward.
