import { createHmac } from "node:crypto";
import { getEnv } from "./env";
import { log } from "./log";

/**
 * Alerts: when something happens that needs a person (an audit log that fails its integrity check, the Chat app's key being refused, a
 * connection that must be reconnected, retention failing, a job that exhausted its retries), POST a small JSON document to the webhook
 * the operator configured. This repository emits it; paging someone is the receiver's job.
 *
 * Rules (CLAUDE.md rules 6 and 10):
 *  - The set of events is CLOSED and each has a fixed summary. There is no free text in an alert, so no message content, token or error
 *    text can ride along; values are limited to id-shaped strings, numbers and booleans, and anything else is dropped.
 *  - Sending is best effort and can never break the work that raised it: raiseAlert never throws, and times out after 5 seconds.
 *  - A problem that recurs alerts once per ALERT_DEDUPE_MINUTES per process, not on every occurrence.
 *  - The URL is operator configuration, https only (localhost excepted), and redirects are never followed.
 */
export const ALERTS = {
  "alert.test": { severity: "warning", summary: "This is a test alert from LoopSignal: if you can read it, alerting works", dedupeOn: [] },
  "audit.chain_broken": { severity: "critical", summary: "An organization's audit log failed its integrity check", dedupeOn: ["organizationId"] },
  "audit.verify_failed": { severity: "error", summary: "The audit log integrity check could not run for an organization", dedupeOn: ["organizationId"] },
  "audit.anchor_mismatch": { severity: "critical", summary: "An organization's audit log no longer matches a signed anchor taken earlier (rows may have been deleted or altered)", dedupeOn: ["organizationId"] },
  "connection.needs_attention": { severity: "warning", summary: "A mailbox connection was refused by Google and must be reconnected", dedupeOn: ["organizationId", "connectionId"] },
  "gmail.watch_renewal_failed": { severity: "warning", summary: "A Gmail push watch could not be renewed (polling still works)", dedupeOn: ["organizationId", "connectionId"] },
  "chat.app_credentials_rejected": { severity: "error", summary: "Google rejected the Chat app's service account, so no space can be read", dedupeOn: [] },
  "retention.failed": { severity: "error", summary: "The retention pass failed for an organization", dedupeOn: ["organizationId"] },
  "worker.error": { severity: "error", summary: "A background worker reported an error", dedupeOn: ["queue", "errorName"] },
  "job.dead_lettered": { severity: "warning", summary: "A background job used up its retries and was moved to the dead-letter queue", dedupeOn: ["queue", "errorName"] },
} as const;
export type AlertEvent = keyof typeof ALERTS;
export type AlertFields = Record<string, string | number | boolean | null | undefined>;
export type AlertResult = "sent" | "suppressed" | "disabled" | "failed";

export interface AlertDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the environment (tests). */
  config?: { url?: string | undefined; secret?: string | undefined; dedupeMinutes?: number };
}

const KEY = /^[A-Za-z][A-Za-z0-9]{0,29}$/;
const VALUE = /^[A-Za-z0-9_.:-]{1,80}$/;
const recent = new Map<string, number>(); // dedupe key -> until
const inFlight = new Set<string>();
const pending = new Set<Promise<unknown>>();

/** Keep only fields that are id-shaped. Returns the clean fields and how many were dropped (never the dropped values). */
export function cleanFields(fields: AlertFields): { fields: Record<string, string | number | boolean | null>; dropped: number } {
  const out: Record<string, string | number | boolean | null> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const ok = KEY.test(k) && (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && VALUE.test(v)));
    if (ok) out[k] = v;
    else dropped++;
  }
  return { fields: out, dropped };
}

export function buildAlertBody(event: AlertEvent, fields: AlertFields, at: Date): { body: string; clean: Record<string, string | number | boolean | null>; dropped: number } {
  const { fields: clean, dropped } = cleanFields(fields);
  const def = ALERTS[event];
  const body = JSON.stringify({ source: "loopsignal", event, severity: def.severity, summary: def.summary, at: at.toISOString(), details: clean, ...(dropped ? { droppedFields: dropped } : {}) });
  return { body, clean, dropped };
}

export async function raiseAlert(event: AlertEvent, fields: AlertFields = {}, deps: AlertDeps = {}): Promise<AlertResult> {
  const task = send(event, fields, deps).catch((): AlertResult => "failed"); // nothing may escape: an alert must never break its caller
  pending.add(task);
  void task.finally(() => pending.delete(task));
  return task;
}

/** Wait for alerts still being sent (shutdown, tests). */
export async function flushAlerts(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Forget what was recently sent (tests). */
export function resetAlertState(): void {
  recent.clear();
  inFlight.clear();
}

async function send(event: AlertEvent, fields: AlertFields, deps: AlertDeps): Promise<AlertResult> {
  const env = deps.config ? undefined : getEnv();
  const url = deps.config ? deps.config.url : env?.ALERT_WEBHOOK_URL;
  const secret = deps.config ? deps.config.secret : env?.ALERT_WEBHOOK_SECRET;
  const dedupeMinutes = deps.config?.dedupeMinutes ?? env?.ALERT_DEDUPE_MINUTES ?? 60;
  const now = (deps.now ?? Date.now)();
  const { body, clean } = buildAlertBody(event, fields, new Date(now));

  // Always logged, so the log tells the story even with no webhook.
  log(ALERTS[event].severity === "warning" ? "warn" : "error", "alert.raised", { alert: event, ...(typeof clean["organizationId"] === "string" ? { organizationId: clean["organizationId"] } : {}) });
  if (!url) return "disabled";

  const dedupeKey = `${event}|${ALERTS[event].dedupeOn.map((k) => String(clean[k] ?? "")).join("|")}`;
  if ((recent.get(dedupeKey) ?? 0) > now || inFlight.has(dedupeKey)) return "suppressed";
  inFlight.add(dedupeKey);
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "loopsignal-alerts" };
    if (secret) headers["x-loopsignal-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await doFetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          recent.set(dedupeKey, now + dedupeMinutes * 60_000);
          return "sent";
        }
      } catch {
        /* try once more */
      }
      if (attempt < 2) await sleep(500);
    }
    log("warn", "alert.delivery_failed", { alert: event });
    return "failed"; // not remembered, so the next occurrence tries again
  } finally {
    inFlight.delete(dedupeKey);
  }
}
