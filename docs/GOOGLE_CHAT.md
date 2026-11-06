# Google Chat: feasibility decision (Sprint 12)

Status: **decided** for the polling adapter built this sprint. Built and verified against a fake Google only; no real Workspace domain, space or
credential was involved (CLAUDE.md rule 7). Facts below come from Google's published documentation as read during the spike (links at the end);
anything the documentation did not settle is listed under "Unconfirmed" and must be checked against a real test domain before production use.

## Question

Can LoopSignal read the Chat spaces of a customer's Workspace, and how, without over-reaching on privacy or tenant isolation?

## What Google allows (confirmed in the docs)

| Option | How | Reads | Cost to the customer | Verdict |
|---|---|---|---|---|
| **A. User authorization** | Each person approves OAuth scope `chat.messages.readonly` (a *restricted* scope: needs Google's verification and security assessment). | Everything that person can see, **including their DMs and group chats**. | Per-person consent, per-person refresh tokens to protect. | Rejected: widest privacy exposure, most credential handling. |
| **B. Domain-wide delegation** | A service account impersonates users after an admin grants it user scopes. | Same as A, for **any user in the domain**. | One admin grant, enormous blast radius. | Rejected: reads private DMs as if we were a person, contradicts least privilege. Also **not available** for the app-auth scopes (`chat.bot`, `chat.app.*`). |
| **C. Chat app, app authentication** | A Chat app (service account) is added to spaces; scope `chat.app.messages.readonly` (restricted), approved **once by a Workspace administrator**. | Messages of spaces the app is a member of; **public messages only** ("doesn't include private messages"). | One admin approval; people add the app to the spaces they want monitored. | **Chosen.** |

Also confirmed:
- `spaces.messages.list` takes `filter` on `createTime` (`>`, `<`), a single `thread.name`, `pageSize` up to 1000, `showDeleted`, and returns oldest first by default. System messages (joins etc.) are excluded; deleted messages have no content. A space with no messages answers `{}`.
- A message carries `name`, `createTime`, `sender` (a `users/<id>` name, a display name and a type), `text`, `thread` (`name`), `threadReply`. **No sender email address** is documented, and Chat has **no subject line**.
- **Interaction events** (a Chat app's normal inbound channel) fire only for DMs with the app, @mentions of the app, link previews and slash commands: **not for every message**. They cannot monitor a space.
- **Workspace Events API** can push `google.workspace.chat.message.v1.created` for a space to a Pub/Sub topic (publisher `chat-api-push@system.gserviceaccount.com`); a space subscription needs the app (admin-approved) or a user to be a member. Subscriptions must be renewed (`ttl: 0` asks for the maximum) and Google says not to rely on expiry reminder events; the maximum lifetime depends on whether resource data is included. A *customer-wide* subscription needs an Enterprise SKU and a separate scope (`chat.app.all.messages.readonly`).

## Decision

1. **Read with a Chat app using app authentication, added by customers to the spaces they choose. No delegation, no per-user tokens.** One product-wide service account (an env secret, not a per-customer secret) signs a JWT and acts as the app. The key file's own `token_uri` is ignored.
2. **A space is bound to an organization only by proof.** Because one app serves every customer, being able to read a space says nothing about which organization owns it. An organization admin requests a claim; a person posts the one-time code (`LS-XXXX-XXXX`, 24-hour life, stored encrypted) in the space; reading the space finds it and binds the space to that organization. A space is bound to **at most one organization at a time**, checked under a per-space database lock; removing a space frees it.
3. **Polling is the source of truth; push is deferred.** Every three minutes a scan queues a sync of each enabled space, reading `messages.list` with `createTime > cursor`. Workspace Events push is not built: its subscription lifetimes and lifecycle events could not be confirmed from the documentation, and polling alone is sufficient (the same stance as Gmail).
4. **Our team is identified by an admin-maintained link,** because Chat gives only an opaque person id. An admin links Chat people to LoopSignal users; messages from a linked person are recorded as our team's (OUTBOUND), which is what lets a reply count as an acknowledgment or response. Other apps and bots are INTERNAL and never tracked as requests. The link applies to messages collected afterwards; history is not rewritten.
5. **Behind a feature flag, off by default** (`GOOGLE_CHAT_ENABLED`), exactly like Gmail.

## Consequences and limits

- **Public messages only; no DMs.** Private conversations are out of scope by construction.
- **No push:** new messages appear within one polling interval (3 minutes).
- **Threading:** in a space without threaded replies each message is its own thread, so replies cannot be linked to the request they answer. Items from such spaces will be one-message items. The `thread.name` is used when Chat provides one.
- **Titles:** Chat has no subject, and subjects are stored unencrypted while message text is encrypted, so an item from Chat is titled `Chat message from <sender display name>`, never with text from the message.
- **Edits:** messages are read once, when they first appear; a later edit is not re-read (a re-read after an edit is recorded as a conflict and the original kept, as designed).
- **Identity:** the team link is manual. A real deployment will want it prefilled (for example from the Directory API, which needs another scope and another approval).
- **If the app is removed from a space** (or its access is not approved) the space is skipped quietly with a log line and retried at the next scan; nothing is disabled or lost, and syncing resumes by itself. There is no on-screen indicator yet, only a stale "last sync".
- **Cursor:** two messages created in the same microsecond across two separate listings is the one theoretical way to skip a message; judged negligible and documented rather than papered over.

## Unconfirmed (verify on a real test domain before any production use)

- Which HTTP status Chat returns when the app is not a member of a space (403 or 404). Both are handled identically.
- Whether `sender.displayName` is populated for app-authenticated reads of every sender (docs say name and type are only guaranteed for some users).
- The exact `orderBy` syntax. The adapter omits it and relies on the documented default (`createTime ASC`), and does not depend on order inside a page.
- Subscription maximum lifetime and renewal behaviour (needed only if push is added).
- Whether Google's restricted-scope verification applies to a Marketplace-listed Chat app in the same way as to OAuth apps. It is a prerequisite for real customers either way.

## Follow-ups

Push via the Workspace Events API with renewal; Directory-based prefill of the team link; an on-screen "app cannot read this space" indicator and notification; handling of edited and deleted messages; reply linking for unthreaded spaces.

## Sources (Google documentation read during the spike)

- Chat API authentication and authorization: https://developers.google.com/workspace/chat/authenticate-authorize
- `spaces.messages.list`: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list
- `spaces.messages` resource: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
- Chat events with the Workspace Events API: https://developers.google.com/workspace/events/guides/events-chat
- Create a subscription: https://developers.google.com/workspace/events/guides/create-subscription
- Update or renew a subscription: https://developers.google.com/workspace/events/guides/update-subscription
- Receive and respond to interactions: https://developers.google.com/workspace/chat/receive-respond-interactions
