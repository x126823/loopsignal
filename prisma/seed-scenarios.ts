/**
 * Synthetic scenario generator. Synthetic data only (CLAUDE.md rule 7): every address ends in
 * .synthetic.test and the connection provider is SYNTHETIC.
 *
 * FIXTURE EXCEPTION to rule 1: this file writes TrackedItem.state (and the derived metric timestamps) directly,
 * because the lifecycle engine does not exist until Sprint 3. It stays consistent by writing the matching
 * LifecycleEvent and AuditLog rows, deriving the four metrics by replaying the steps, and refusing to emit a
 * RESOLUTION_CONFIRMED or CLOSED step that is not performed by a human (rule 2). Sprint 3 replaces this with
 * scenarios driven through the engine.
 *
 * Message and thread providers are GMAIL or GOOGLE_CHAT so cross-channel scenarios are representable;
 * nothing here touches a real provider.
 */
import { createHash } from "node:crypto";
import { withTenant, type TenantTx } from "../src/lib/db";
import { encryptField, parseFieldKey } from "../src/lib/crypto/fields";
import { recordAudit } from "../src/modules/audit";
import type { ItemState, MessageLinkRole, Priority } from "../generated/prisma/enums";

const BASE = Date.parse("2026-10-05T09:00:00Z"); // fixed so reruns and tests are deterministic
const NOW = BASE + 2 * 24 * 60 * 60 * 1000; // "current time" for SLA timer states in fixtures
const at = (min: number) => new Date(BASE + min * 60_000);

/** Deterministic UUID from a key (idempotent, collision-free for fixture purposes). */
export function stableId(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Msg { from: "customer" | "agent"; handle?: string; atMin: number; text: string }
interface Step {
  to: ItemState;
  /** Index of the message that triggered this step. */
  msg?: number;
  /** Used when no message triggers the step (human decisions); minutes after BASE. */
  atMin?: number;
  actor: "SYSTEM" | "USER";
  by?: string; // user handle when actor is USER
  analyzer?: string;
  confidence?: number;
  /** Must be a verbatim substring of the triggering message (rule 6). */
  evidence?: string;
  reason?: string;
}
interface Scenario {
  key: string;
  org: "acme" | "globex";
  team: string;
  channel: "gmail" | "chat";
  subject: string;
  customer: number;
  priority?: Priority;
  owner?: string;
  needsReview?: boolean;
  /** Message only, no TrackedItem (not actionable). */
  noItem?: boolean;
  messages: Msg[];
  steps: Step[];
}

const SCENARIOS: Scenario[] = [
  { key: "printer", org: "acme", team: "Support", channel: "gmail", customer: 1, subject: "Printer offline in building 4", owner: "carol",
    messages: [
      { from: "customer", atMin: 0, text: "Our printer in building 4 has been offline since this morning. Can someone take a look?" },
      { from: "agent", handle: "carol", atMin: 20, text: "Thanks for letting us know, we have received this and will get back to you." },
    ],
    steps: [{ to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.96, evidence: "we have received this" }] },

  { key: "duplicate-charge", org: "acme", team: "Billing", channel: "gmail", customer: 2, subject: "Refund for duplicate charge", priority: "HIGH", owner: "gina",
    messages: [
      { from: "customer", atMin: 30, text: "I was charged twice for invoice 1042. Please refund the duplicate." },
      { from: "agent", handle: "gina", atMin: 45, text: "Got your message, checking now." },
      { from: "agent", handle: "gina", atMin: 150, text: "I checked invoice 1042 and confirmed a duplicate charge. The refund will be issued within three business days." },
    ],
    steps: [
      { to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.93, evidence: "Got your message" },
      { to: "RESPONDED", msg: 2, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.91, evidence: "confirmed a duplicate charge" },
    ] },

  { key: "vpn", org: "acme", team: "Support", channel: "gmail", customer: 3, subject: "VPN access request for new contractor", owner: "bob",
    messages: [
      { from: "customer", atMin: 60, text: "Please set up VPN access for our new contractor starting Monday." },
      { from: "agent", handle: "bob", atMin: 70, text: "Received, thanks." },
      { from: "agent", handle: "bob", atMin: 200, text: "I need the contractor's manager approval first. Please reply with their name and I will start the request." },
      { from: "customer", atMin: 260, text: "The manager is Dana Okafor." },
      { from: "agent", handle: "bob", atMin: 300, text: "Approval requested and provisioning has started. I expect it to be ready tomorrow." },
    ],
    steps: [
      { to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.9, evidence: "Received, thanks" },
      { to: "RESPONDED", msg: 2, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.88, evidence: "I need the contractor's manager approval first" },
      { to: "IN_PROGRESS", msg: 4, actor: "SYSTEM", analyzer: "progress", confidence: 0.9, evidence: "provisioning has started" },
    ] },

  { key: "password-loop", org: "acme", team: "Support", channel: "gmail", customer: 4, subject: "Password reset keeps looping", owner: "carol",
    messages: [
      { from: "customer", atMin: 120, text: "The password reset email sends me back to the login page every time." },
      { from: "agent", handle: "carol", atMin: 130, text: "We're on it." },
      { from: "agent", handle: "carol", atMin: 240, text: "The reset link was being blocked by a cached redirect. I have cleared it on our side." },
      { from: "agent", handle: "carol", atMin: 400, text: "I believe this is fixed now. Please try the reset again and let me know if it works." },
    ],
    steps: [
      { to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.9, evidence: "We're on it" },
      { to: "RESPONDED", msg: 2, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.92, evidence: "blocked by a cached redirect" },
      { to: "RESOLUTION_PROPOSED", msg: 3, actor: "SYSTEM", analyzer: "resolution", confidence: 0.84, evidence: "I believe this is fixed now" },
    ] },

  { key: "address-change", org: "acme", team: "Billing", channel: "gmail", customer: 5, subject: "Update billing address on account", owner: "gina",
    messages: [
      { from: "customer", atMin: 180, text: "Please update our billing address to 12 Example Street." },
      { from: "agent", handle: "gina", atMin: 195, text: "Thanks, I have this and will update it today." },
      { from: "agent", handle: "gina", atMin: 260, text: "The billing address now reads 12 Example Street on your account and on future invoices." },
      { from: "customer", atMin: 300, text: "Confirmed, that looks right. Thank you." },
    ],
    steps: [
      { to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.94, evidence: "I have this and will update it today" },
      { to: "RESPONDED", msg: 2, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.9, evidence: "now reads 12 Example Street" },
      { to: "RESOLUTION_PROPOSED", msg: 2, actor: "SYSTEM", analyzer: "resolution", confidence: 0.8, evidence: "on future invoices" },
      { to: "RESOLUTION_CONFIRMED", msg: 3, actor: "USER", by: "gina", reason: "Customer confirmed", evidence: "Confirmed, that looks right" },
      { to: "CLOSED", atMin: 320, actor: "USER", by: "gina", reason: "Closed after customer confirmation" },
    ] },

  { key: "dashboard-totals", org: "acme", team: "Support", channel: "gmail", customer: 6, subject: "Dashboard shows wrong totals", priority: "HIGH", owner: "bob",
    messages: [
      { from: "customer", atMin: 360, text: "The weekly dashboard totals do not match our export." },
      { from: "agent", handle: "bob", atMin: 372, text: "Acknowledged, looking into it." },
      { from: "agent", handle: "bob", atMin: 420, text: "A timezone offset was double-counting Sunday. I have corrected the report query." },
      { from: "customer", atMin: 480, text: "Thanks, the totals match now." },
      { from: "customer", atMin: 1800, text: "The totals are wrong again this week, same as before." },
      { from: "agent", handle: "bob", atMin: 1815, text: "Thanks for flagging, reopening and checking now." },
    ],
    steps: [
      { to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.92, evidence: "Acknowledged, looking into it" },
      { to: "RESPONDED", msg: 2, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.9, evidence: "double-counting Sunday" },
      { to: "RESOLUTION_PROPOSED", msg: 2, actor: "SYSTEM", analyzer: "resolution", confidence: 0.85, evidence: "corrected the report query" },
      { to: "RESOLUTION_CONFIRMED", msg: 3, actor: "USER", by: "bob", reason: "Customer confirmed", evidence: "the totals match now" },
      { to: "CLOSED", atMin: 500, actor: "USER", by: "bob", reason: "Closed after confirmation" },
      { to: "REOPENED", msg: 4, actor: "USER", by: "bob", reason: "Same issue reported again", evidence: "wrong again this week" },
      { to: "ACKNOWLEDGED", msg: 5, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.9, evidence: "reopening and checking now" },
    ] },

  { key: "contract-question", org: "acme", team: "Billing", channel: "gmail", customer: 7, subject: "Question about contract renewal terms",
    messages: [{ from: "customer", atMin: 600, text: "Can you confirm the renewal terms for our annual contract before Friday?" }],
    steps: [] },

  { key: "battery", org: "acme", team: "Support", channel: "chat", customer: 8, subject: "Laptop battery swelling", priority: "URGENT", owner: "carol",
    messages: [
      { from: "customer", atMin: 700, text: "My laptop battery looks swollen and the trackpad is lifting. Is it safe to keep using?" },
      { from: "agent", handle: "carol", atMin: 990, text: "Seen this, thank you." },
    ],
    steps: [{ to: "ACKNOWLEDGED", msg: 1, actor: "SYSTEM", analyzer: "ack_detector", confidence: 0.89, evidence: "Seen this" }] },

  { key: "checkout-outage-mail", org: "acme", team: "Support", channel: "gmail", customer: 9, subject: "Outage on checkout page", priority: "URGENT", owner: "bob",
    messages: [
      { from: "customer", atMin: 800, text: "The checkout page returns an error for all our customers right now." },
      { from: "agent", handle: "bob", atMin: 806, text: "Confirmed on our side, the payment service is failing health checks. We are rolling back the last deploy." },
    ],
    steps: [
      { to: "RESPONDED", msg: 1, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.93, evidence: "payment service is failing health checks" },
      { to: "IN_PROGRESS", msg: 1, actor: "SYSTEM", analyzer: "progress", confidence: 0.9, evidence: "We are rolling back the last deploy" },
    ] },

  { key: "checkout-outage-chat", org: "acme", team: "Support", channel: "chat", customer: 10, subject: "Checkout is down for customers?", noItem: true,
    messages: [{ from: "customer", atMin: 815, text: "Is checkout down for anyone else? Customers are reporting errors at payment." }],
    steps: [] },

  { key: "ambiguous", org: "acme", team: "Support", channel: "gmail", customer: 11, subject: "Thoughts on reports", needsReview: true,
    messages: [{ from: "customer", atMin: 900, text: "Maybe someone could look at the reports at some point, no rush." }],
    steps: [] },

  { key: "newsletter", org: "acme", team: "Support", channel: "gmail", customer: 12, subject: "Weekly product newsletter", noItem: true,
    messages: [{ from: "customer", atMin: 950, text: "This week in product: three new templates and a refreshed editor. Unsubscribe at any time." }],
    steps: [] },

  { key: "globex-pump", org: "globex", team: "Operations", channel: "gmail", customer: 20, subject: "Pump 3 pressure alarm", priority: "HIGH",
    messages: [{ from: "customer", atMin: 100, text: "Pump 3 is showing a pressure alarm again. Please advise." }], steps: [] },

  { key: "globex-schedule", org: "globex", team: "Operations", channel: "gmail", customer: 21, subject: "Shift schedule for next week", owner: "gina",
    messages: [
      { from: "customer", atMin: 200, text: "Can you share the shift schedule for next week?" },
      { from: "agent", handle: "gina", atMin: 230, text: "The schedule for next week is posted on the operations board and attached here." },
    ],
    steps: [{ to: "RESPONDED", msg: 1, actor: "SYSTEM", analyzer: "substantive_response", confidence: 0.9, evidence: "schedule for next week is posted" }] },
];

const ROLE_FOR: Partial<Record<ItemState, MessageLinkRole>> = {
  ACKNOWLEDGED: "ACK", RESPONDED: "RESPONSE", IN_PROGRESS: "PROGRESS", RESOLUTION_PROPOSED: "RESOLUTION",
};

interface Derived {
  state: ItemState; cycle: number; reopenCount: number;
  ackAt: Date | null; firstSubstantiveResponseAt: Date | null; resolvedAt: Date | null; closedAt: Date | null;
  events: Array<{ step: Step; from: ItemState | null; cycle: number; when: Date }>;
}

/** Replay steps to derive state, cycle, and the four metrics (never hand-edited timestamps, rule 4). */
function derive(s: Scenario): Derived {
  const d: Derived = { state: "RECEIVED", cycle: 1, reopenCount: 0, ackAt: null, firstSubstantiveResponseAt: null, resolvedAt: null, closedAt: null, events: [] };
  let prev: ItemState | null = null;
  for (const step of s.steps) {
    if ((step.to === "RESOLUTION_CONFIRMED" || step.to === "CLOSED") && step.actor !== "USER") {
      throw new Error(`Scenario ${s.key}: ${step.to} requires a human actor (rule 2)`);
    }
    const when = step.msg !== undefined ? at(s.messages[step.msg]!.atMin) : at(step.atMin!);
    if (step.to === "REOPENED") {
      d.cycle += 1; d.reopenCount += 1;
      d.ackAt = d.firstSubstantiveResponseAt = d.resolvedAt = d.closedAt = null; // item-level metrics reflect the current cycle
    }
    if (step.to === "ACKNOWLEDGED") d.ackAt ??= when;
    if (step.to === "RESPONDED") d.firstSubstantiveResponseAt ??= when;
    if (step.to === "RESOLUTION_CONFIRMED") d.resolvedAt = when;
    if (step.to === "CLOSED") d.closedAt = when;
    d.events.push({ step, from: prev ?? "RECEIVED", cycle: d.cycle, when });
    prev = step.to;
    d.state = step.to;
  }
  return d;
}

interface Ctx {
  tx: TenantTx; organizationId: string; key: Buffer;
  userId: (handle: string) => string; teamId: (name: string) => string;
}

async function seedOrg(c: Ctx, org: "acme" | "globex"): Promise<number> {
  const { tx, organizationId } = c;
  const sentinel = stableId(`${org}:thread:${SCENARIOS.find((s) => s.org === org)!.key}`);
  if (await tx.thread.findUnique({ where: { id: sentinel } })) return 0; // already seeded: idempotent

  const owner = c.userId(org === "acme" ? "alice" : "frank");
  const connection = await tx.sourceConnection.create({
    data: { id: stableId(`${org}:conn`), organizationId, provider: "SYNTHETIC", ownerUserId: owner, scopes: ["synthetic.read"] },
  });
  const calendar = await tx.businessCalendar.create({
    data: { id: stableId(`${org}:cal`), organizationId, timezone: "UTC",
            hours: { mon: ["09:00", "17:00"], tue: ["09:00", "17:00"], wed: ["09:00", "17:00"], thu: ["09:00", "17:00"], fri: ["09:00", "17:00"] } },
  });
  const policy = await tx.slaPolicy.create({
    data: { id: stableId(`${org}:sla`), organizationId, name: "Default", ackTargetSec: 3600, responseTargetSec: 14_400,
            resolveTargetSec: 172_800, closeTargetSec: 259_200, calendarId: calendar.id, warnAtPct: 80 },
  });
  const sources = new Map<string, string>();
  for (const [channel, kind, externalId] of [["gmail", "MAILBOX", "support@synthetic.test"], ["chat", "SPACE", "spaces/synthetic-support"]] as const) {
    const src = await tx.monitoredSource.create({
      data: { id: stableId(`${org}:src:${channel}`), organizationId, connectionId: connection.id, kind, externalId },
    });
    sources.set(channel, src.id);
  }

  let count = 0;
  for (const s of SCENARIOS.filter((x) => x.org === org)) {
    const provider = s.channel === "gmail" ? "GMAIL" : "GOOGLE_CHAT";
    const threadId = stableId(`${org}:thread:${s.key}`);
    await tx.thread.create({ data: { id: threadId, organizationId, provider, externalThreadId: `synthetic-thread-${s.key}`, canonicalKey: sha(s.subject.toLowerCase()).slice(0, 16) } });

    const customerAddr = `customer${s.customer}@customer.synthetic.test`;
    const customer = await tx.participant.upsert({
      where: { organizationId_address: { organizationId, address: customerAddr } },
      create: { id: stableId(`${org}:p:${customerAddr}`), organizationId, address: customerAddr, displayName: `Customer ${s.customer}` },
      update: {},
    });

    const messageIds: string[] = [];
    for (const [i, m] of s.messages.entries()) {
      const id = stableId(`${org}:msg:${s.key}:${i}`);
      messageIds.push(id);
      const agentAddr = m.handle ? `${m.handle}@synthetic.loopsignal.test` : undefined;
      const sender = m.from === "customer" ? customer.id : (await tx.participant.upsert({
        where: { organizationId_address: { organizationId, address: agentAddr! } },
        create: { id: stableId(`${org}:p:${agentAddr}`), organizationId, address: agentAddr!, displayName: m.handle!, userId: c.userId(m.handle!) },
        update: {},
      })).id;
      const rawEvent = await tx.rawEvent.create({
        data: { id: stableId(`${org}:raw:${s.key}:${i}`), organizationId, provider, externalId: `synthetic-raw-${s.key}-${i}`,
                payload: encryptField(JSON.stringify({ synthetic: true, subject: s.subject }), c.key, `${organizationId}:RawEvent.payload`),
                payloadHash: sha(`${s.key}:${i}`), receivedAt: at(m.atMin) },
      });
      await tx.message.create({
        data: { id, organizationId, monitoredSourceId: sources.get(s.channel)!, threadId, provider,
                externalMessageId: `synthetic-msg-${s.key}-${i}`, senderParticipantId: sender, rawEventId: rawEvent.id,
                sentAt: at(m.atMin), subject: s.subject, bodyText: encryptField(m.text, c.key, `${organizationId}:Message.bodyText`),
                bodyHash: sha(m.text), direction: m.from === "customer" ? "INBOUND" : "OUTBOUND" },
      });
    }

    if (s.noItem) {
      await tx.analysisRun.create({
        data: { id: stableId(`${org}:run:${s.key}:intent`), organizationId, analyzer: "intent_classifier", messageId: messageIds[0]!,
                provider: "fake", model: "fake-1", promptVersion: "v1", inputHash: sha(s.messages[0]!.text),
                output: { actionable: false }, confidence: 0.97, evidence: [], recommendedAction: "NOT_ACTIONABLE", requiresHumanApproval: false, status: "OK" },
      });
      count++;
      continue;
    }

    const d = derive(s);
    const itemId = stableId(`${org}:item:${s.key}`);
    await tx.trackedItem.create({
      data: { id: itemId, organizationId, teamId: c.teamId(s.team), ownerUserId: s.owner ? c.userId(s.owner) : null,
              originMessageId: messageIds[0]!, threadId, title: s.subject, priority: s.priority ?? "NORMAL", state: d.state,
              slaPolicyId: policy.id, ackAt: d.ackAt, firstSubstantiveResponseAt: d.firstSubstantiveResponseAt,
              resolvedAt: d.resolvedAt, closedAt: d.closedAt, reopenCount: d.reopenCount, version: d.events.length,
              needsReview: s.needsReview ?? false, createdAt: at(s.messages[0]!.atMin) },
    });
    if (s.owner) {
      await tx.itemOwnership.create({ data: { id: stableId(`${org}:own:${s.key}`), organizationId, itemId, userId: c.userId(s.owner), assignedAt: at(s.messages[0]!.atMin) } });
    }

    const links = new Map<number, MessageLinkRole>([[0, "ORIGIN"]]);
    for (const e of d.events) if (e.step.msg !== undefined && !links.has(e.step.msg)) links.set(e.step.msg, ROLE_FOR[e.step.to] ?? "OTHER");
    for (const [i, role] of links) {
      await tx.itemMessageLink.create({ data: { id: stableId(`${org}:link:${s.key}:${i}`), organizationId, itemId, messageId: messageIds[i]!, role } });
    }

    // RECEIVED: the creation event.
    await tx.lifecycleEvent.create({
      data: { id: stableId(`${org}:ev:${s.key}:0`), organizationId, itemId, cycle: 1, fromState: null, toState: "RECEIVED",
              actorType: "SYSTEM", reason: "Actionable message received", createdAt: at(s.messages[0]!.atMin) },
    });
    await recordAudit(tx, { organizationId, actorType: "SYSTEM", action: "item.created", entityType: "TrackedItem", entityId: itemId, metadata: { toState: "RECEIVED", fixture: true } });

    for (const [n, e] of d.events.entries()) {
      const { step } = e;
      let analysisRunId: string | undefined;
      if (step.analyzer) {
        const msg = s.messages[step.msg!]!;
        if (!step.evidence || !msg.text.includes(step.evidence)) throw new Error(`Scenario ${s.key}: evidence must be a verbatim substring of the message (rule 6)`);
        analysisRunId = stableId(`${org}:run:${s.key}:${n}`);
        await tx.analysisRun.create({
          data: { id: analysisRunId, organizationId, analyzer: step.analyzer, itemId, messageId: messageIds[step.msg!]!, provider: "fake",
                  model: "fake-1", promptVersion: "v1", inputHash: sha(`${s.key}:${n}:${msg.text}`),
                  output: { to: step.to }, confidence: step.confidence ?? null, evidence: [{ quote: step.evidence }],
                  recommendedAction: `TRANSITION_${step.to}`, requiresHumanApproval: false, status: "OK" },
        });
      }
      const actorId = step.actor === "USER" ? c.userId(step.by!) : null;
      await tx.lifecycleEvent.create({
        data: { id: stableId(`${org}:ev:${s.key}:${n + 1}`), organizationId, itemId, cycle: e.cycle, fromState: e.from, toState: step.to,
                actorType: step.actor, actorId, analysisRunId: analysisRunId ?? null,
                evidence: step.evidence ? [{ quote: step.evidence }] : undefined, reason: step.reason ?? null, createdAt: e.when },
      });
      await recordAudit(tx, {
        organizationId, actorType: step.actor, actorId: actorId ?? undefined, action: "item.transitioned", entityType: "TrackedItem",
        entityId: itemId, metadata: { fromState: e.from, toState: step.to, cycle: e.cycle, fixture: true },
      });
      if (step.actor === "USER" && (step.to === "RESOLUTION_CONFIRMED" || step.to === "CLOSED")) {
        await tx.approvalRequest.create({
          data: { id: stableId(`${org}:appr:${s.key}:${n}`), organizationId, itemId, requestedTransition: step.to, status: "APPROVED",
                  decidedBy: actorId, decidedAt: e.when, reason: step.reason ?? null, createdAt: e.when },
        });
      }
    }

    if (d.state === "RESOLUTION_PROPOSED") {
      await tx.approvalRequest.create({
        data: { id: stableId(`${org}:appr:${s.key}:pending`), organizationId, itemId, requestedTransition: "RESOLUTION_CONFIRMED", status: "PENDING" },
      });
    }
    if (s.needsReview) {
      await tx.reviewTask.create({ data: { id: stableId(`${org}:review:${s.key}`), organizationId, type: "LOW_CONFIDENCE", refType: "TrackedItem", refId: itemId } });
      await tx.analysisRun.create({
        data: { id: stableId(`${org}:run:${s.key}:intent`), organizationId, analyzer: "intent_classifier", itemId, messageId: messageIds[0]!, provider: "fake",
                model: "fake-1", promptVersion: "v1", inputHash: sha(s.messages[0]!.text), output: { actionable: true }, confidence: 0.41,
                evidence: [{ quote: "Maybe someone could look at the reports" }], recommendedAction: "NEEDS_REVIEW", requiresHumanApproval: true, status: "OK" },
      });
    }

    // SLA timers for the first two targets, with states derived against the fixed fixture clock.
    const start = at(s.messages[0]!.atMin).getTime();
    for (const [type, targetSec, met] of [["ACK", policy.ackTargetSec, d.ackAt], ["RESPONSE", policy.responseTargetSec, d.firstSubstantiveResponseAt]] as const) {
      const due = start + targetSec * 1000;
      const state = met ? (met.getTime() <= due ? "MET" : "BREACHED") : due < NOW ? "BREACHED" : "RUNNING";
      const timer = await tx.slaTimer.create({
        data: { id: stableId(`${org}:timer:${s.key}:${type}`), organizationId, itemId, type, startedAt: new Date(start), dueAt: new Date(due),
                state, resolvedAt: met ?? null },
      });
      if (state === "BREACHED") {
        await tx.slaBreach.create({ data: { id: stableId(`${org}:breach:${s.key}:${type}`), organizationId, timerId: timer.id, breachedAt: new Date(Math.min(NOW, met?.getTime() ?? NOW)) } });
      }
    }
    count++;
  }

  if (org === "acme") {
    // Cross-channel candidate: the Google Chat message probably duplicates the Gmail outage item. Uncertain, so it
    // goes to the review queue and is never auto-merged (rule 9).
    const target = stableId("acme:item:checkout-outage-mail");
    const chatMsg = stableId("acme:msg:checkout-outage-chat:0");
    await tx.correlationCandidate.create({
      data: { id: stableId("acme:corr:checkout"), organizationId, subjectType: "Message", subjectId: chatMsg, targetItemId: target, score: 0.72,
              rationale: { signals: ["same topic: checkout errors", "within 20 minutes", "different channel"], belowAutoMergeThreshold: true } },
    });
    await tx.reviewTask.create({ data: { id: stableId("acme:review:checkout"), organizationId, type: "CORRELATION", refType: "CorrelationCandidate", refId: stableId("acme:corr:checkout") } });
  }
  await recordAudit(tx, { organizationId, actorType: "SYSTEM", action: "fixture.seeded", entityType: "Organization", entityId: organizationId, metadata: { scenarios: count, synthetic: true } });
  return count;
}

export async function seedScenarios(ids: {
  orgs: Record<"acme" | "globex", string>;
  teams: Record<string, string>;
  userId: (handle: string) => string;
}): Promise<void> {
  const key = parseFieldKey(process.env["FIELD_ENCRYPTION_KEY"] ?? "");
  for (const org of ["acme", "globex"] as const) {
    const organizationId = ids.orgs[org];
    const n = await withTenant({ organizationId }, (tx) =>
      seedOrg({
        tx, organizationId, key, userId: ids.userId,
        teamId: (name) => ids.teams[`${org}:${name}`] ?? (() => { throw new Error(`Unknown team ${org}:${name}`); })(),
      }, org));
    console.log(n === 0 ? `Scenarios for ${org}: already seeded` : `Scenarios for ${org}: seeded ${n}`);
  }
}
