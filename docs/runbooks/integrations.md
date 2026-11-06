# Gmail and Google Chat

Both are behind feature flags that are **off by default**, and both have so far been exercised only against a fake Google. Read `docs/ARCHITECTURE.md` sections 4e and 4f and `docs/GOOGLE_CHAT.md` for how they work; this page is for operating them.

## Turning one on

1. Use a Google Cloud **test** project and a **test** mailbox or space. Real data needs the user's explicit authorization and legal/HR sign-off.
2. Gmail: an OAuth client (web application) with redirect URI `<AUTH_URL>/api/gmail/callback`; set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_ENABLED=true`. Optional push needs `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT` together.
   Chat: one Chat app (service account); set `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` (the whole key file, one line) and `GOOGLE_CHAT_ENABLED=true`. Each customer's Workspace admin approves `chat.app.messages.readonly` once and people add the app to the spaces.
3. Restart web **and** worker (the scans and schedules exist only while enabled). An admin then connects from **Connections**.

## Turning one off

`GMAIL_ENABLED=false` / `GOOGLE_CHAT_ENABLED=false`, restart. Nothing reaches Google; routes answer 404; scans stop. Existing data and connections stay. To also cut Google's access, **Disconnect** each connection first (it revokes at Google and deletes our tokens).

## Symptoms

| You see | It means | Do |
|---|---|---|
| Gmail row says **Needs attention** | Google refused the stored credentials for good (the user revoked access, or the grant expired). Syncing stopped; audited once (`connection.auth_failed`) | An admin presses **Connect Gmail** again for that mailbox. It keeps the same source and position, so nothing is read twice |
| Gmail: no new mail, status Connected | Polling runs every 3 minutes; look for `ingest.resync`, rate-limit retries, dead letters ([Queues](queues.md)). A history gap triggers an automatic bounded re-read (`resyncs` in the sync log) | Wait one interval; **Sync now**; check the worker is running |
| `gmail.watch_renewal_failed` | A push watch could not be renewed (they last 7 days). Polling still works; mail is only slower | Check credentials; reconnect if "Needs attention" |
| Push endpoint returns 401 in Google's logs | Token audience or service account does not match `GMAIL_PUSH_AUDIENCE` / `GMAIL_PUSH_SERVICE_ACCOUNT` | Fix the settings; the log line `gmail.push_rejected` carries a reason code |
| Chat: **Verify** says "cannot read that space" | The app is not in the space, or the admin has not approved the scope | Add the app to the space; confirm the admin approval; verify again |
| Chat: **Verify** says "code was not found" | Nobody posted the code in that space, or it is older than the request | Post the code (it is shown on the Connections page) and verify again |
| Chat: "That space is already connected" | Another organization holds it (you cannot see which). It frees when that organization removes it | Ask who administers it; do not retry in a loop |
| Chat space shows Connected but nothing arrives; log `ingest.source_unavailable` | The app was removed from the space, or its access is no longer approved | Re-add the app; the next scan resumes with nothing lost |
| log `chat.app_credentials_rejected` (error) | Google refuses the Chat app's service account (key disabled or deleted) | [Key rotation](key-rotation.md), Chat app |
| Chat replies do not count as the team answering | The teammate is not linked | Connections → People in Chat → link them. It applies to later messages only |

## Facts worth knowing

- Disconnect never deletes collected messages; it deletes the tokens and stops syncing. Collected content follows [retention](retention.md).
- A space is bound to one organization at a time. Removing it frees it.
- Chat reads **public** messages only and never DMs. Gmail reads the INBOX and SENT labels, never drafts, spam or trash, and never attachments' content.
- The Chat and Gmail adapters never log message content or tokens; log lines carry ids, counts and error classes.
