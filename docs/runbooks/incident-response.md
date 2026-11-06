# Incident response

For anything that might expose data, misuse a credential, or make the audit trail untrustworthy. Time matters more than elegance: contain, then investigate.

## Contain: switches, cheapest first

All of these are reversible and none deletes data.

| Switch | What it does | How |
|---|---|---|
| Stop one connection | Disables a mailbox or space, revokes Google's grant, deletes our copy of the tokens | Connections page, **Disconnect** (admin). A space: **Disconnect** on the space |
| `GMAIL_ENABLED=false` | No Gmail sync, scan, watch renewal, consent or push endpoint (it answers 404) | Environment, restart web and worker |
| `GOOGLE_CHAT_ENABLED=false` | Same for Chat | Environment, restart |
| `LLM_PROVIDER=fake` | No message content is sent to a model | Environment, restart worker |
| `MAINTENANCE_JOBS_ENABLED=false` | Stops the daily retention pass and audit verification schedules (use it to **preserve evidence**, so nothing is purged while you investigate) | Environment, restart worker. Running `ops:retention` by hand still works |
| Sign someone out everywhere | Ends every session of one person, on every device (they sign in again). A member can do it for themselves; an administrator for any member | **Security** page. Audited (`session.revoked`, `session.revoked_self`) |
| Rotate `AUTH_SECRET` | Signs **everyone** out (all sessions become invalid) | [Key rotation](key-rotation.md) |
| Rotate the Google client secret / Chat key | Cuts off a leaked app credential | [Key rotation](key-rotation.md) |

## Triage

1. **What is exposed?** Ids and counts only. Which organization(s)? (`organizationId` is on every log line and audit row.)
2. **Is it still happening?** Contain with the table above.
3. **Preserve evidence:** `MAINTENANCE_JOBS_ENABLED=false`; take a backup now (`npm run drill:restore` takes one and proves it); keep logs. Do **not** run retention or erasure on affected organizations unless legally required.
4. **Look at the audit log** (append-only, hash-chained): `connection.*`, `participant.erased`, `retention.*`, `membership.*`, `approval.*`, `auth_failed`. The Retention page shows the last verification; [Audit log integrity](audit-chain.md) if it failed.
5. **Notify** according to your legal and contractual obligations (this repository does not decide them). Monitoring communications carries notice and consent duties (SECURITY.md section 3).

## Scenarios

- **A token or key may have leaked.** Contain the integration, then rotate that credential ([Key rotation](key-rotation.md)). A leaked `FIELD_ENCRYPTION_KEY` plus a database copy exposes content: rotate, then treat the exposure as a data incident.
- **A person says our data about them must go.** [Retention and erasure](retention.md), `ops:erase-person`.
- **Wrong data shown to the wrong person.** Capture the page and the user ids (not content), disable the affected feature if you can, and tell engineering: tenant isolation is enforced twice (query scoping and row-level security) and tested for every table, so a leak means one of the two layers has a defect.
- **A message is trying to give the system instructions.** Expected: content is untrusted; analyzers cannot act and humans approve confirmations and closures. Nothing to contain; keep the message id for the injection test suite.
- **The audit check failed.** [Audit log integrity](audit-chain.md).

## Known gaps

Things this project does **not** do yet, so you do not assume they exist:

- Alerting is a webhook you configure ([Alerting](alerting.md)); the paging behind it is yours, and a down webhook is only visible in the log.
- A connection that needs attention raises an alert (if the webhook is set) and shows on the Connections page; there is no in-app notification.
- Secret scanning covers committed files and git history (`npm run scan:secrets`, `-- --history`, both in CI), not other places secrets can live. A secret found in history must be rotated even if it was later removed.
- Backups are proven locally by a drill; scheduling, off-site copies and retention of backups are an environment concern.
- The Pub/Sub push endpoint and Google Chat's behaviour against a real domain have not been exercised.
