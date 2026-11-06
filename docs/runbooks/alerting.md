# Alerting

LoopSignal logs errors, but nobody reads logs at 3 a.m. When something needs a person, it can also POST a small JSON document to a webhook you configure, which your paging or chat tool turns into a page or a message. This repository **emits** the alert; delivering it to a human is the receiver's job.

## Turn it on

```
ALERT_WEBHOOK_URL=https://hooks.example.com/…      # https only (http is accepted for localhost, for testing); redirects are never followed
ALERT_WEBHOOK_SECRET=<16+ random characters>       # recommended: signs every alert so the receiver can verify it came from you
ALERT_DEDUPE_MINUTES=60                            # a recurring problem alerts once per this window, per process
```
Restart the web server **and** the worker (alerts are raised from both). Then prove it works end to end:
```
npm run ops:test-alert        # sends an `alert.test`; prints {"result":"sent"} and exits 0, or fails loudly (exit 1)
```
With no URL set, alerts are only logged (`alert.raised`, at the alert's severity), nothing is sent, and nothing breaks.

## What you receive

```json
{ "source": "loopsignal", "event": "audit.chain_broken", "severity": "critical",
  "summary": "An organization's audit log failed its integrity check",
  "at": "2026-11-07T10:00:00.000Z", "details": { "organizationId": "…", "firstBadSeq": 41 } }
```
**There is no free text.** The set of events is closed, each has a fixed summary, and `details` can only hold id-shaped strings, numbers, booleans and null (anything else is dropped before sending, and the count is reported as `droppedFields`). No message content, token, key, address or error text can be in an alert. Verify the signature (header `x-loopsignal-signature: sha256=<hex>`, an HMAC-SHA256 of the raw request body with your secret):
```js
const ok = crypto.timingSafeEqual(Buffer.from(header), Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex")));
```

| Event | Severity | Meaning and first step |
|---|---|---|
| `audit.chain_broken` | critical | An organization's audit log was altered or truncated outside the application. [Audit log integrity](audit-chain.md) |
| `audit.anchor_mismatch` | critical | The audit log no longer matches a signed anchor (newest rows deleted, or rewritten). [Audit log integrity](audit-chain.md) |
| `audit.verify_failed` | error | The daily check could not run for an organization (database trouble?). Repeated failures are an outage of the check |
| `chat.app_credentials_rejected` | error | Google refuses the Chat app's service account: no space can be read. [Key rotation](key-rotation.md) |
| `retention.failed` | error | The daily retention pass failed for an organization. Content is not being removed on schedule. [Retention](retention.md) |
| `worker.error` | error | A background worker reported an error (`queue`, `errorName`). Check the worker log and Redis |
| `connection.needs_attention` | warning | Google refused a mailbox's credentials; sync stopped. An admin reconnects it. [Gmail and Chat](integrations.md) |
| `gmail.watch_renewal_failed` | warning | A push watch could not be renewed. Polling still works; mail is only slower |
| `job.dead_lettered` | warning | A job used up its retries (`queue`, `errorName`). [Queues](queues.md): `npm run ops:dead-letters` |
| `alert.test` | warning | You asked for it with `ops:test-alert` |

## Behaviour you can rely on

- **Best effort, never blocking.** Sending times out after 5 seconds, is retried once, and can never fail or slow the work that raised it. A failed delivery is logged (`alert.delivery_failed`) and **tried again on the next occurrence**; it is not remembered as sent.
- **Once per window.** A problem that recurs (a scan failing every 3 minutes) alerts once per `ALERT_DEDUPE_MINUTES` per process, keyed by the event and its ids (so two organizations, or two connections, are two alerts). The window is in memory: restarting a process, or running both web and worker, can repeat an alert. `connection.needs_attention` fires only on the transition to "needs attention", not on every failed attempt.
- **Always logged.** Every alert is also written to the log (`alert.raised`), so the log tells the full story even if the webhook was down.

## What alerting does not do

- It does not page anyone by itself: your receiver does. Test the whole path (receiver, routing, who is on call) with `ops:test-alert`.
- It is not exhaustive. It covers the events above, chosen because they need a human; the rest stay in the logs. Keep log-based alerting for anything you care about beyond this list (the production checklist names the log events).
- It cannot tell you it is itself broken: if the webhook is down, the only trace is `alert.delivery_failed` in the log. Monitor that, and run `ops:test-alert` after any change to the receiver.
