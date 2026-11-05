/**
 * Synthetic scenario generator. Synthetic data only (CLAUDE.md rule 7): every address ends in
 * .synthetic.test and the connection provider is SYNTHETIC.
 *
 * Scenarios are driven through the lifecycle engine (createItem, propose, apply). Nothing here writes
 * TrackedItem state or the four metrics: the engine validates every step, derives the metrics from the events,
 * links messages, records approvals and writes the AuditLog. Human-only steps (confirm, close, reopen) are
 * performed by real seeded principals; analyzer steps carry an AnalysisRun and verbatim evidence, and the engine
 * rejects them otherwise. (Replaces the Sprint 2 direct-insert fixture.)
 *
 * Message and thread providers are GMAIL or GOOGLE_CHAT so cross-channel scenarios are representable;
 * nothing here touches a real provider.
 */
import { createHash } from "node:crypto";
import { ManualClock } from "../src/lib/clock";
import { withTenant, type TenantTx } from "../src/lib/db";
import { encryptField, parseFieldKey } from "../src/lib/crypto/fields";
import { recordAudit } from "../src/modules/audit";
import { resolvePrincipal, type Principal } from "../src/modules/identity";
import { apply, createItem, propose, type EngineOptions } from "../src/modules/lifecycle";
import { scanOrganization } from "../src/modules/sla";
import type { ItemState, Priority } from "../generated/prisma/enums";

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

interface Ctx {
  tx: TenantTx; organizationId: string; key: Buffer; opts: EngineOptions;
  userId: (handle: string) => string; teamId: (name: string) => string;
  principal: (handle: string) => Principal;
}

async function must<T extends { outcome: string }>(what: string, p: Promise<T>, ok: string[]): Promise<T> {
  const out = await p;
  if (!ok.includes(out.outcome)) throw new Error(`Seed step "${what}" failed: ${JSON.stringify(out)}`);
  return out;
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
            hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "17:00"]]])), holidays: [] },
  });
  const policy = await tx.slaPolicy.create({
    data: { id: stableId(`${org}:sla`), organizationId, name: "Default", ackTargetSec: 3600, responseTargetSec: 14_400,
            resolveTargetSec: 172_800, closeTargetSec: 259_200, calendarId: calendar.id, warnAtPct: 80 },
  });
  // Urgent items get tighter targets, around the clock (no calendar). The policy is picked once, at creation.
  const urgentPolicy = await tx.slaPolicy.create({
    data: { id: stableId(`${org}:sla:urgent`), organizationId, name: "Urgent", priority: "URGENT", ackTargetSec: 900, responseTargetSec: 3600,
            resolveTargetSec: 14_400, closeTargetSec: 86_400, warnAtPct: 80 },
  });
  const sources = new Map<string, string>();
  for (const [channel, kind, externalId] of [["gmail", "MAILBOX", "support@synthetic.test"], ["chat", "SPACE", "spaces/synthetic-support"]] as const) {
    const src = await tx.monitoredSource.create({
      data: { id: stableId(`${org}:src:${channel}`), organizationId, connectionId: connection.id, kind, externalId },
    });
    sources.set(channel, src.id);
  }

  const intentRun = (key: string, messageId: string, text: string, actionable: boolean, confidence: number, itemId?: string) =>
    tx.analysisRun.create({
      data: { id: stableId(`${org}:run:${key}:intent`), organizationId, analyzer: "intent_classifier", itemId: itemId ?? null, messageId,
              provider: "fake", model: "fake-1", promptVersion: "v1", inputHash: sha(text), output: { actionable }, confidence,
              evidence: actionable ? [{ quote: text.slice(0, 40) }] : [], recommendedAction: actionable ? (confidence < 0.8 ? "NEEDS_REVIEW" : "TRACK") : "NOT_ACTIONABLE",
              requiresHumanApproval: confidence < 0.8, status: "OK" },
    });

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

    const first = s.messages[0]!;
    if (s.noItem) {
      await intentRun(s.key, messageIds[0]!, first.text, false, 0.97);
      count++;
      continue;
    }

    // 1. Intent classification recommends tracking; the engine creates the item (low confidence => flagged for review).
    const lowConfidence = s.needsReview === true;
    const confidence = lowConfidence ? 0.41 : 0.97;
    const run = await intentRun(s.key, messageIds[0]!, first.text, true, confidence);
    const created = await must(`${s.key}: create`, createItem(tx, {
      organizationId, teamId: c.teamId(s.team), originMessageId: messageIds[0]!, threadId, title: s.subject, priority: s.priority ?? "NORMAL",
      ...(s.owner ? { ownerUserId: c.userId(s.owner) } : {}), slaPolicyId: (s.priority === "URGENT" ? urgentPolicy : policy).id, occurredAt: at(first.atMin),
      actor: { type: "ANALYZER", analyzer: "intent_classifier", analysisRunId: run.id }, confidence,
    }, c.opts), ["CREATED"]);
    const itemId = (created as { itemId: string }).itemId;

    // 2. Replay the scenario's steps through the engine.
    for (const [n, step] of s.steps.entries()) {
      const occurredAt = step.msg !== undefined ? at(s.messages[step.msg]!.atMin) : at(step.atMin!);
      const messageId = step.msg !== undefined ? messageIds[step.msg] : undefined;
      const evidence = step.evidence ? [{ quote: step.evidence }] : undefined;
      const common = { organizationId, itemId, to: step.to, occurredAt, ...(messageId ? { messageId } : {}), ...(evidence ? { evidence } : {}), ...(step.reason ? { reason: step.reason } : {}) };
      if (step.actor === "USER") {
        await must(`${s.key}: ${step.to}`, apply(tx, { ...common, actor: { type: "USER", principal: c.principal(step.by!) } }, c.opts), ["APPLIED"]);
      } else {
        const stepRun = await tx.analysisRun.create({
          data: { id: stableId(`${org}:run:${s.key}:${n}`), organizationId, analyzer: step.analyzer!, itemId, messageId: messageId ?? null, provider: "fake",
                  model: "fake-1", promptVersion: "v1", inputHash: sha(`${s.key}:${n}:${s.messages[step.msg!]!.text}`),
                  output: { to: step.to }, confidence: step.confidence ?? null, evidence: evidence ?? [],
                  recommendedAction: `TRANSITION_${step.to}`, requiresHumanApproval: false, status: "OK" },
        });
        await must(`${s.key}: ${step.to}`, propose(tx, {
          ...common, actor: { type: "ANALYZER", analyzer: step.analyzer!, analysisRunId: stepRun.id }, ...(step.confidence !== undefined ? { confidence: step.confidence } : {}),
        }, c.opts), ["APPLIED"]);
      }
    }

    // 3. A proposed resolution waits for a human: the system suggests confirmation and the engine queues the approval.
    const last = s.steps.at(-1);
    if (last?.to === "RESOLUTION_PROPOSED") {
      await must(`${s.key}: queue approval`, propose(tx, {
        organizationId, itemId, to: "RESOLUTION_CONFIRMED", occurredAt: at(s.messages[last.msg!]!.atMin + 1), actor: { type: "SYSTEM" }, reason: "Awaiting customer or owner confirmation",
      }, c.opts), ["APPROVAL_REQUIRED"]);
    }

    // 4. SLA timers are not written here: the SLA engine derives them from the events above once this transaction commits
    //    (see seedScenarios), with a fixed clock so the fixtures are deterministic.
    count++;
  }

  if (org === "acme") {
    // Cross-channel candidate: the Google Chat message probably duplicates the Gmail outage item. Uncertain, so it
    // goes to the review queue and is never auto-merged (rule 9).
    const target = stableId("acme:item:checkout-outage-mail");
    const chatMsg = stableId("acme:msg:checkout-outage-chat:0");
    const itemRow = await tx.trackedItem.findFirstOrThrow({ where: { threadId: stableId("acme:thread:checkout-outage-mail") } });
    await tx.correlationCandidate.create({
      data: { id: stableId("acme:corr:checkout"), organizationId, subjectType: "Message", subjectId: chatMsg, targetItemId: itemRow.id, score: 0.72,
              rationale: { signals: ["same topic: checkout errors", "within 20 minutes", "different channel"], belowAutoMergeThreshold: true } },
    });
    await tx.reviewTask.create({ data: { id: stableId("acme:review:checkout"), organizationId, type: "CORRELATION", refType: "CorrelationCandidate", refId: stableId("acme:corr:checkout") } });
    void target;
  }
  await recordAudit(tx, { organizationId, actorType: "SYSTEM", action: "fixture.seeded", entityType: "Organization", entityId: organizationId, metadata: { scenarios: count, synthetic: true } });
  return count;
}

/**
 * A mailbox the synthetic adapter can sync (`npm run ingest:synthetic`). Idempotent and independent of the scenario
 * sentinel, so it is also added to databases that were seeded before it existed.
 */
async function ensureIngestSource(org: "acme" | "globex", organizationId: string, teamId: string): Promise<void> {
  await withTenant({ organizationId }, async (tx) => {
    const connection = await tx.sourceConnection.findUnique({ where: { organizationId_id: { organizationId, id: stableId(`${org}:conn`) } } });
    if (!connection) return;
    await tx.monitoredSource.upsert({
      where: { id: stableId(`${org}:src:ingest`) },
      create: { id: stableId(`${org}:src:ingest`), organizationId, connectionId: connection.id, kind: "MAILBOX", externalId: "synthetic-inbox@synthetic.test", teamId },
      update: {},
    });
  });
}

export async function seedScenarios(ids: {
  orgs: Record<"acme" | "globex", string>;
  teams: Record<string, string>;
  userId: (handle: string) => string;
}): Promise<void> {
  const key = parseFieldKey(process.env["FIELD_ENCRYPTION_KEY"] ?? "");
  const opts: EngineOptions = { fieldKey: key, now: () => new Date(NOW) }; // fixed clock: fixtures are dated in the past
  for (const org of ["acme", "globex"] as const) {
    const organizationId = ids.orgs[org];
    // Human steps run as real principals, resolved from the seeded memberships.
    const handles = [...new Set(SCENARIOS.filter((x) => x.org === org).flatMap((x) => x.steps.filter((st) => st.actor === "USER").map((st) => st.by!)))];
    const principals = new Map<string, Principal>();
    for (const h of handles) {
      const p = await resolvePrincipal(ids.userId(h), organizationId);
      if (!p) throw new Error(`Seed principal ${h} has no membership in ${org}`);
      principals.set(h, p);
    }
    const n = await withTenant({ organizationId }, (tx) =>
      seedOrg({
        tx, organizationId, key, opts, userId: ids.userId,
        teamId: (name) => ids.teams[`${org}:${name}`] ?? (() => { throw new Error(`Unknown team ${org}:${name}`); })(),
        principal: (h) => principals.get(h) ?? (() => { throw new Error(`No principal for ${h}`); })(),
      }, org));
    // Timers come from the real SLA engine, run at the fixture clock. It is idempotent, so a replay changes nothing.
    if (n > 0) {
      const scan = await scanOrganization(organizationId, { clock: new ManualClock(new Date(NOW)) });
      if (scan.failures > 0) throw new Error(`SLA scan failed for ${scan.failures} seeded item(s) in ${org}`);
    }
    console.log(n === 0 ? `Scenarios for ${org}: already seeded` : `Scenarios for ${org}: seeded ${n}`);
    await ensureIngestSource(org, organizationId, ids.teams[org === "acme" ? "acme:Support" : "globex:Operations"]!);
  }
}
