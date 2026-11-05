// Runs under tsx (like the seed), where the application modules load normally. The browser tests call this to create synthetic
// organizations and items through the real lifecycle engine, so the Playwright process itself stays light.
//   node --import tsx e2e/fixture-cli.ts <command> '<json args>'   ->  prints one line: @@JSON@@<result>
import { createPrismaClient, withTenant } from "../src/lib/db";
import { ManualClock } from "../src/lib/clock";
import { apply, createItem, propose, queueReviewTask } from "../src/modules/lifecycle";
import { createPolicy, reconcileItem } from "../src/modules/sla";
import { purgeOrgs, syntheticEmail, testKey } from "../tests/helpers/fixtures";
import { at, createEngineFixture, createMessage, createThreadWithMessage, engineOpts, type EngineFixture } from "../tests/helpers/engine-fixture";

const owner = createPrismaClient(process.env["DATABASE_URL"]!);
const SYSTEM = { type: "SYSTEM" as const };
let clock = Math.floor(Math.random() * 1_000); // spread timestamps so separate invocations never collide
const tick = () => at(10 + ++clock);
const inOrg = <T>(f: EngineFixture, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ organizationId: f.organizationId }, fn);

async function move(f: EngineFixture, itemId: string, to: "RESPONDED" | "RESOLUTION_PROPOSED") {
  const out = await inOrg(f, (tx) => propose(tx, { organizationId: f.organizationId, itemId, to, occurredAt: tick(), actor: SYSTEM }, engineOpts));
  if (out.outcome !== "APPLIED") throw new Error(`move ${to}: ${JSON.stringify(out)}`);
}

// Method shorthand keeps each command's own argument type while letting the table be looked up by name.
const commands: Record<string, (args: never) => Promise<unknown>> = {
  async "new-org"() {
    const f = await createEngineFixture(owner);
    await owner.user.update({ where: { id: f.users.member }, data: { name: "Carol Member" } });
    await owner.user.update({ where: { id: f.users.lead }, data: { name: "Bob Lead" } });
    await owner.user.update({ where: { id: f.users.viewer }, data: { name: "Dave Viewer" } });
    return { ...f, emails: Object.fromEntries(Object.entries(f.users).map(([k, id]) => [k, syntheticEmail(id)])) };
  },

  async "new-item"(a: { org: EngineFixture; title: string; state?: "RECEIVED" | "RESPONDED" | "RESOLUTION_PROPOSED"; suggestConfirmation?: boolean }) {
    const f = a.org;
    const { threadId, messageId } = await createThreadWithMessage(owner, f, "Our checkout page returns an error for every customer. Can you look into this urgently?", 0);
    const created = await inOrg(f, (tx) => createItem(tx, { organizationId: f.organizationId, teamId: f.teamId, originMessageId: messageId, threadId, title: a.title, occurredAt: tick(), actor: SYSTEM }, engineOpts));
    if (created.outcome !== "CREATED") throw new Error("item not created");
    const itemId = created.itemId;
    if (a.state === "RESPONDED" || a.state === "RESOLUTION_PROPOSED") {
      await createMessage(owner, f, threadId, "Thanks, we have identified the cause on our side.", 20, "OUTBOUND");
      await move(f, itemId, "RESPONDED");
    }
    if (a.state === "RESOLUTION_PROPOSED") {
      await createMessage(owner, f, threadId, "The issue is now fixed. Please let us know if it works for you.", 30, "OUTBOUND");
      await move(f, itemId, "RESOLUTION_PROPOSED");
    }
    if (a.suggestConfirmation) {
      const reply = await createMessage(owner, f, threadId, "Works now, thanks! You can close this.", 40, "INBOUND");
      const out = await inOrg(f, (tx) => propose(tx, { organizationId: f.organizationId, itemId, to: "RESOLUTION_CONFIRMED", occurredAt: tick(), actor: SYSTEM }, engineOpts));
      if (out.outcome !== "APPROVAL_REQUIRED") throw new Error(`expected a queued approval, got ${JSON.stringify(out)}`);
      await owner.analysisRun.create({
        data: {
          organizationId: f.organizationId, analyzer: "resolution_analyzer", itemId, messageId: reply.id, provider: "fake-heuristic", model: "heuristic-1", promptVersion: "1",
          inputHash: `e2e-${itemId}`, output: {}, confidence: 0.9, evidence: [{ messageId: reply.id, quote: "Works now" }], recommendedAction: "TRANSITION_RESOLUTION_CONFIRMED",
          requiresHumanApproval: true, status: "OK",
        },
      });
    }
    return { itemId, threadId };
  },

  // An item with SLA timers built by the real SLA engine at fixed, explicit times (received at(0); optionally answered at(20)).
  // The page reads the real clock, so anything still open there is long overdue, which is exactly what the test asserts.
  async "new-sla-item"(a: { org: EngineFixture; title: string; replied?: boolean }) {
    const f = a.org;
    let policyId = (await owner.slaPolicy.findFirst({ where: { organizationId: f.organizationId } }))?.id;
    if (!policyId) policyId = (await createPolicy(f.principals.admin, { name: "Default", ackTargetSec: 3600, responseTargetSec: 14_400, resolveTargetSec: 172_800, closeTargetSec: 259_200, warnAtPct: 80 })).id;
    const { threadId, messageId } = await createThreadWithMessage(owner, f, "Our checkout page returns an error for every customer. Can you look into this urgently?", 0);
    const created = await inOrg(f, (tx) => createItem(tx, { organizationId: f.organizationId, teamId: f.teamId, originMessageId: messageId, threadId, title: a.title, occurredAt: at(0), actor: SYSTEM, slaPolicyId: policyId }, engineOpts));
    if (created.outcome !== "CREATED") throw new Error("item not created");
    if (a.replied) {
      await createMessage(owner, f, threadId, "Thanks, we have identified the cause on our side.", 20, "OUTBOUND");
      const out = await inOrg(f, (tx) => propose(tx, { organizationId: f.organizationId, itemId: created.itemId, to: "RESPONDED", occurredAt: at(20), actor: SYSTEM }, engineOpts));
      if (out.outcome !== "APPLIED") throw new Error(`respond: ${JSON.stringify(out)}`);
    }
    await reconcileItem(f.organizationId, created.itemId, { clock: new ManualClock(at(30)) });
    return { itemId: created.itemId, threadId };
  },

  async "human-move"(a: { org: EngineFixture; itemId: string; to: "RESOLUTION_CONFIRMED" | "CLOSED" }) {
    const f = a.org;
    // Each invocation is a separate process with its own clock, so continue from the item's own latest event.
    const last = await owner.lifecycleEvent.findFirstOrThrow({ where: { itemId: a.itemId }, orderBy: { seq: "desc" } });
    const occurredAt = new Date(last.createdAt.getTime() + 60_000);
    const out = await inOrg(f, (tx) => apply(tx, { organizationId: f.organizationId, itemId: a.itemId, to: a.to, occurredAt, actor: { type: "USER", principal: f.principals.admin } }, engineOpts));
    if (out.outcome !== "APPLIED") throw new Error(`human-move ${a.to}: ${JSON.stringify(out)}`);
    return { ok: true };
  },

  async "queue-review"(a: { org: EngineFixture; type: "OWNERSHIP" | "LOW_CONFIDENCE"; itemId: string }) {
    return queueReviewTask(a.org.organizationId, { type: a.type, refType: "TrackedItem", refId: a.itemId });
  },

  async cleanup(a: { orgs: EngineFixture[] }) {
    await purgeOrgs(owner, a.orgs.map((o) => o.organizationId));
    await owner.user.deleteMany({ where: { id: { in: a.orgs.flatMap((o) => Object.values(o.users)) } } });
    return { ok: true };
  },
};

async function main(): Promise<void> {
  const [name, raw] = process.argv.slice(2);
  const run = commands[name ?? ""];
  if (!run) throw new Error(`unknown command ${name}`);
  const result = await (run as (args: unknown) => Promise<unknown>)(raw ? JSON.parse(raw) : {});
  process.stdout.write(`@@JSON@@${JSON.stringify(result)}\n`);
}

void testKey;
main().then(() => owner.$disconnect()).catch(async (e: Error) => {
  console.error(e.stack);
  await owner.$disconnect();
  process.exit(1);
});
