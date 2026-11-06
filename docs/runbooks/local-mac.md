# Running LoopSignal on your Mac with real data

For one person using their **own** Gmail, with analysis done **offline** (no language model, nothing about your mail leaves your Mac except the calls to Google's mail API). It is a real instance, separate from the development setup: its own database and queue, bound to your own machine only, with passwords and keys generated for you. Everything below was exercised end to end on a throwaway copy (migrations, first administrator, the production web server, the worker, a backup, a restore, and a check that nothing is reachable from your network). It has **not** been run against a real Google account by me: you will be the first, so expect small differences in Google's screens.

**Be clear about what this is.** A laptop is a convenient place to try the real thing, not a production host: it sleeps, it has no monitoring or on-call, and backups are yours to make. That is acceptable for your own mail. Do not point it at anyone else's mail from here without their say-so, and do not expose it to the internet.

## 1. Prepare the Mac

1. **Turn on FileVault** (System Settings → Privacy & Security → FileVault). Your keys and your data sit on this disk; full-disk encryption is what protects them if the Mac is lost. Do not skip this.
2. Install **Docker Desktop** and start it. Node comes from `nvm` as in the README: `nvm use`, then `npm install`.
3. The development stack (if you run it) uses ports 5432, 6379 and `npm run dev` on 3000. The real one uses **5433 and 6380** for its database and queue and **3000** for the app, so **do not run `npm run dev` at the same time**.

## 2. Google (about 10 minutes, once)

Do this in the Google account you want to read. (Google renames screens often; the names below may differ slightly.)

1. Go to <https://console.cloud.google.com>, create a project, e.g. "LoopSignal local".
2. **APIs & Services → Library → Gmail API → Enable.**
3. **OAuth consent screen** (or "Google Auth Platform"): user type **External**; app name and your email as support contact. Leave the publishing status on **Testing**. Under **Audience → Test users**, add **your own Gmail address**. Under **Data access / Scopes**, add `…/auth/gmail.readonly` (the only Gmail permission LoopSignal asks for: it can read mail, not send, delete or change it) plus the basic sign-in scopes (`openid`, `email`, `profile`).
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized redirect URIs** add **both**:
   - `http://localhost:3000/api/auth/callback/google` (signing in to LoopSignal)
   - `http://localhost:3000/api/gmail/callback` (connecting the mailbox)
5. Keep the **client ID** and **client secret** open; you will paste them into a file in step 3, not into a terminal.

What to expect from Google because the app is in **Testing** (that is right for personal use; it is not a defect):
- A warning, **"Google hasn't verified this app"**. It is your own app: choose **Advanced → Go to LoopSignal (unsafe)**. Google only requires verification (a security assessment for this restricted scope) for apps others will use.
- In Testing mode **Google expires the refresh token after about 7 days** (this is my understanding of Google's current policy; check it). LoopSignal will then show your mailbox as **Needs attention**; press **Connect Gmail** again and it carries on from where it stopped, with nothing read twice. Plan on doing this weekly.

## 3. Create your configuration (your passwords and keys, never shown)

```
npm run local:init
```
This creates `~/.loopsignal/real.env` (a folder only you can open, a file only you can read) with fresh random database and queue passwords, a session secret, the encryption key, and signing keys. **It prints only the names, never the values.** Then open the file **in a text editor** (for example `open -e ~/.loopsignal/real.env`) and fill in the four Google lines from step 2:
```
AUTH_GOOGLE_ID=<client id>            GOOGLE_OAUTH_CLIENT_ID=<the same client id>
AUTH_GOOGLE_SECRET=<client secret>    GOOGLE_OAUTH_CLIENT_SECRET=<the same secret>
```
Do not paste these into a terminal, a chat, or an issue. **Now back up `FIELD_ENCRYPTION_KEY`** (the line in that file) into a password manager, **somewhere other than the Mac and other than any database backup**. Without it, everything LoopSignal stores becomes unreadable, and losing it cannot be undone.

## 4. Start it

```
npm run real:up                 # Postgres and Redis, local only
npm run real:migrate            # build the database
npm run build                   # build the app (once, and after updates)
npm run real:first-admin -- --email YOU@gmail.com --name "Your Name" --org "My Mail" --team Inbox
```
Sign-in is by invitation only: the first administrator must be created like this, with the **exact Google account email** you will sign in with. Then, in two terminals:
```
npm run real:start              # the web app on http://localhost:3000
npm run real:worker             # fetches and analyses mail, runs the timers and the daily jobs
```
Open <http://localhost:3000>, **Sign in with Google**, then **Connections → Connect Gmail** (choose the team, approve at Google). The first sync reads the last 7 days of your Inbox and Sent mail (never drafts, spam or trash), then keeps up every few minutes. Without the worker running, nothing syncs.

If the web server stops immediately, its message names the setting that is wrong (never the value): usually a Google value still empty.

## 5. What you will see, and what it does and does not do

- Mail that looks like a request becomes a tracked item. With **offline rules** the classification is rough: expect missed requests and some wrong guesses, and more items sent to the **Review queue**. That is the cost of keeping your mail off any model.
- **Nothing is closed or confirmed automatically.** A person approves resolutions and closure.
- Messages are stored **encrypted**. Subjects, senders and times are stored in the clear (they are how items are titled and listed).
- **Retention** (Settings → Retention): raw copies are removed after 30 days and message bodies 180 days after an item closes, by default. Decide whether that suits you; shorter is safer for a personal mailbox.
- You can see the audit trail of what happened, and **Security → Sign out everywhere** ends all sessions.

## 6. Keeping it healthy on a laptop

- **Sleep stops everything.** While the Mac sleeps nothing syncs. Gmail catches up when it wakes (and re-reads a bounded window if it was asleep long enough to lose its place), so mail is delayed, not lost. To keep it running, open a terminal and run `caffeinate -s` (stays awake while on power), or set the Mac not to sleep when the display is off.
- **It does not start by itself** after a restart: run `npm run real:up`, then `real:start` and `real:worker` again.
- **Do not run `npm run dev`** (it would take over port 3000 and uses the development settings).
- **Never expose it.** Keep it on `localhost`: no tunnel, no port forwarding, no "share my screen with the app open on a public link".

## 7. Backups (yours to make)

```
npm run real:backup -- --out /Volumes/<your encrypted drive>/loopsignal-$(date +%F).dump
npm run real:drill                # restore the newest data into a scratch database and verify it
```
- The backup is readable by you only, refuses to overwrite a file, and is **useless without `FIELD_ENCRYPTION_KEY`**. Keep the key backup separate from it.
- Use an **encrypted** drive. Time Machine also copies `~/.loopsignal` (your keys) and the Docker volume's data: make sure the Time Machine disk is encrypted.
- Run the drill now and then. A backup you have never restored is a hope.
- **Audit anchors** are saved to `~/.loopsignal/anchors.jsonl` on this same disk, which gives you little: for real protection move `AUDIT_ANCHOR_FILE` (in the env file) to a folder on a separate encrypted drive. See [Audit log integrity](audit-chain.md).

## 8. Stopping, and removing everything

- Stop (keep your data): `npm run real:down`, and stop the two terminals.
- **Disconnect Gmail first** if you are finished: Connections → **Disconnect** (it revokes LoopSignal's access at Google and deletes the stored tokens). You can also revoke it at <https://myaccount.google.com/permissions>.
- **Erase it all:**
  ```
  docker compose --env-file ~/.loopsignal/real.env -f docker-compose.real.yml down -v     # deletes the database and queue
  rm -rf ~/.loopsignal                                                                     # deletes the keys: nothing can be decrypted afterwards
  ```
  Backups you made are separate files: delete those too, and the key you stored in the password manager.

## 9. Troubleshooting

| You see | Do |
|---|---|
| The web server or worker exits at once, naming a setting | Fix that line in `~/.loopsignal/real.env` (usually a Google value) |
| Google says `redirect_uri_mismatch` | The redirect URIs in step 2.4 must match exactly, including `http://localhost:3000` (not `127.0.0.1`) |
| Google says "Access blocked" or "not a test user" | Add your address under **Test users** (step 2.3) and use that account |
| Sign-in fails with an access error | The email you signed in with must match the one in `real:first-admin` |
| The mailbox says **Needs attention** | Normal about weekly in Testing mode: **Connect Gmail** again |
| Nothing is arriving | Is `real:worker` running? Is the Mac awake? **Sync now** on Connections. See [Gmail and Chat](integrations.md) |
| "port is already in use" | Something else holds 3000, 5433 or 6380 (the development server?). Stop it, or re-run `local:init` with other ports on a new folder |
| You lost `real.env` | The data cannot be read without its keys. Restore the file from your own copy; there is no other way |
