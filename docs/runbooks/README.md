# Runbooks

Operating LoopSignal. Each runbook is written to be followed under stress: what it is for, how to tell, the exact steps and commands, how to verify, and how to undo. Everything here was exercised against the real stack on synthetic data in Sprint 13 (see each page for what was measured).

| Runbook | Use it when |
|---|---|
| [Running on your Mac with real data](local-mac.md) | One person, their own Gmail, offline analysis, on one Mac: the safe local setup, Google steps, backups, and how to remove it |
| [First deployment](first-deployment.md) | Standing up an environment for the first time, step by step, in order |
| [Production checklist](production-checklist.md) | What must be true of a deployment; reviewing one |
| [Incident response](incident-response.md) | Anything that might be a security or data incident; the containment switches |
| [Key rotation](key-rotation.md) | Rotating `FIELD_ENCRYPTION_KEY`, `AUTH_SECRET`, Google client or Chat app credentials, or after a suspected leak |
| [Backup and restore](backup-restore.md) | Taking backups, proving they restore, or restoring for real |
| [Retention and erasure](retention.md) | Changing how long content is kept, running a pass, or honouring an erasure request |
| [Alerting](alerting.md) | Setting up the webhook, what each alert means, testing it |
| [Audit log integrity](audit-chain.md) | The daily check reports a broken chain or a mismatched anchor; setting up anchors |
| [Gmail and Google Chat](integrations.md) | A connection needs attention, mail or Chat stopped arriving, enabling or disabling an integration |
| [Queues and dead letters](queues.md) | Jobs failing, backlog growing, analysis deferred, database connection errors |
| [Load test and capacity](load-test.md) | Sizing, regression checks, or "is it slow?" |

## Rules that apply to every runbook

1. **Never paste message content, tokens, keys or secrets** into a ticket, chat or log. The tooling prints ids, counts and error classes for exactly this reason. If a command ever prints something else, stop and report it.
2. **Synthetic data only** until the user authorizes real data (CLAUDE.md rule 7). Real mailboxes and spaces additionally need legal/HR sign-off (SECURITY.md section 3).
3. **Contain first, investigate second.** The switches in [Incident response](incident-response.md) are cheap and reversible.
4. **Do not "fix" the audit log or the lifecycle events.** They are append-only on purpose. If they look wrong, preserve them and read [Audit log integrity](audit-chain.md).
5. **Write down what you did,** with times and commands (not content). Corrections are new entries.
