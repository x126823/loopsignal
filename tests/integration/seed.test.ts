import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { decryptField, parseFieldKey } from "@/lib/crypto/fields";
import { withTenant, type TenantTx } from "@/lib/db";
import { verifyAuditChain } from "@/modules/audit";
import { verifyItemMetrics } from "@/modules/lifecycle";
import { stableId } from "../../prisma/seed-scenarios";

// Requires `npm run db:seed` (CI runs it before tests).
const ACME = "00000000-0000-4000-8000-000000000001";
const GLOBEX = "00000000-0000-4000-8000-000000000002";
const key = () => parseFieldKey(process.env["FIELD_ENCRYPTION_KEY"]!);
const acme = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ organizationId: ACME }, fn);
// Items get engine-generated ids, so scenarios are found through their (deterministic) thread.
const byKey = (tx: TenantTx, k: string) => tx.trackedItem.findFirstOrThrow({ where: { threadId: stableId(`acme:thread:${k}`) } });

describe("seeded scenarios", () => {
  it("creates items across all lifecycle states in two teams", async () => {
    const items = await acme((tx) => tx.trackedItem.findMany());
    const states = new Set(items.map((i) => i.state));
    for (const s of ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "RESOLUTION_PROPOSED", "CLOSED"]) expect(states).toContain(s);
    expect(new Set(items.map((i) => i.teamId)).size).toBe(2);
    expect(items.length).toBeGreaterThanOrEqual(9);
  });

  it("keeps every item's state consistent with its LifecycleEvents, and the metrics with the events", async () => {
    await acme(async (tx) => {
      for (const it of await tx.trackedItem.findMany()) {
        const events = await tx.lifecycleEvent.findMany({ where: { itemId: it.id }, orderBy: { seq: "asc" } });
        expect(await verifyItemMetrics(tx, it.id), it.title).toEqual({ consistent: true, differences: [] });
        expect(events.at(-1)!.toState, it.title).toBe(it.state);
        const current = events.filter((e) => e.cycle === Math.max(...events.map((x) => x.cycle)));
        const first = (state: string) => current.find((e) => e.toState === state)?.createdAt.getTime() ?? null;
        expect(it.ackAt?.getTime() ?? null, `${it.title} ack`).toBe(first("ACKNOWLEDGED"));
        expect(it.firstSubstantiveResponseAt?.getTime() ?? null, `${it.title} response`).toBe(first("RESPONDED"));
        expect(it.resolvedAt?.getTime() ?? null, `${it.title} resolved`).toBe(first("RESOLUTION_CONFIRMED"));
        expect(it.closedAt?.getTime() ?? null, `${it.title} closed`).toBe(first("CLOSED"));
        expect(it.reopenCount).toBe(events.filter((e) => e.toState === "REOPENED").length);
      }
    });
  });

  it("separates acknowledgment, response, proposal, confirmation and closure (rule 5)", async () => {
    await acme(async (tx) => {
      const printer = await byKey(tx, "printer");
      expect([printer.state, printer.ackAt !== null, printer.firstSubstantiveResponseAt]).toEqual(["ACKNOWLEDGED", true, null]);
      const proposed = await byKey(tx, "password-loop");
      expect([proposed.state, proposed.resolvedAt, proposed.closedAt]).toEqual(["RESOLUTION_PROPOSED", null, null]);
      const pending = await tx.approvalRequest.findMany({ where: { itemId: proposed.id } });
      expect(pending.map((p) => [p.requestedTransition, p.status])).toEqual([["RESOLUTION_CONFIRMED", "PENDING"]]);
      const closed = await byKey(tx, "address-change");
      expect(closed.resolvedAt).not.toBeNull();
      expect(closed.closedAt!.getTime()).toBeGreaterThan(closed.resolvedAt!.getTime());
    });
  });

  it("only humans confirm or close, each with an approved ApprovalRequest (rule 2)", async () => {
    await acme(async (tx) => {
      const decisions = await tx.lifecycleEvent.findMany({ where: { toState: { in: ["RESOLUTION_CONFIRMED", "CLOSED"] } } });
      expect(decisions.length).toBeGreaterThanOrEqual(4);
      for (const e of decisions) {
        expect(e.actorType).toBe("USER");
        expect(e.actorId).not.toBeNull();
        const approval = await tx.approvalRequest.findFirst({ where: { itemId: e.itemId, requestedTransition: e.toState, status: "APPROVED" } });
        expect(approval?.decidedBy).toBe(e.actorId);
      }
    });
  });

  it("tracks a reopened item as cycle 2 with prior history preserved", async () => {
    await acme(async (tx) => {
      const it = await byKey(tx, "dashboard-totals");
      expect([it.reopenCount, it.closedAt, it.resolvedAt]).toEqual([1, null, null]);
      const events = await tx.lifecycleEvent.findMany({ where: { itemId: it.id } });
      expect(events.some((e) => e.cycle === 1 && e.toState === "CLOSED")).toBe(true);
      expect(Math.max(...events.map((e) => e.cycle))).toBe(2);
    });
  });

  it("stores evidence quotes that are verbatim substrings of the source message (rule 6)", async () => {
    await acme(async (tx) => {
      const runs = await tx.analysisRun.findMany({ where: { messageId: { not: null } } });
      let checked = 0;
      for (const run of runs) {
        const msg = await tx.message.findUniqueOrThrow({ where: { id: run.messageId! } });
        const body = decryptField(msg.bodyText, key(), `${ACME}:Message.bodyText`);
        for (const ev of run.evidence as Array<{ quote: string }>) {
          expect(body, `${run.analyzer}`).toContain(ev.quote);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(10);
    });
  });

  it("routes the uncertain cross-channel match and the low-confidence item to review, never auto-merging (rule 9)", async () => {
    await acme(async (tx) => {
      const cand = await tx.correlationCandidate.findMany();
      expect(cand).toHaveLength(1);
      expect([cand[0]!.status, cand[0]!.score]).toEqual(["PENDING", 0.72]);
      expect((await tx.message.findUniqueOrThrow({ where: { id: cand[0]!.subjectId } })).provider).toBe("GOOGLE_CHAT");
      expect(await tx.trackedItem.count({ where: { threadId: stableId("acme:thread:checkout-outage-chat") } })).toBe(0);
      const reviews = await tx.reviewTask.findMany({ where: { status: "OPEN" } });
      expect(reviews.map((r) => r.type).sort()).toEqual(["CORRELATION", "LOW_CONFIDENCE"]);
      expect((await byKey(tx, "ambiguous")).needsReview).toBe(true);
    });
  });

  it("records SLA breaches for late or missing acknowledgment", async () => {
    await acme(async (tx) => {
      const ids = Object.fromEntries(await Promise.all(["battery", "contract-question", "printer"].map(async (k) => [k, (await byKey(tx, k)).id])));
      const timers = await tx.slaTimer.findMany({ where: { itemId: { in: Object.values(ids) }, type: "ACK" } });
      const byItem = new Map(timers.map((t) => [t.itemId, t.state]));
      expect(byItem.get(ids["battery"]!)).toBe("BREACHED"); // acked, but late
      expect(byItem.get(ids["contract-question"]!)).toBe("BREACHED"); // never acked
      expect(byItem.get(ids["printer"]!)).toBe("MET");
      expect(await tx.slaBreach.count()).toBeGreaterThanOrEqual(2);
    });
  });

  it("encrypts bodies and raw payloads, and never stores plaintext", async () => {
    await acme(async (tx) => {
      const msgs = await tx.message.findMany();
      expect(msgs.length).toBeGreaterThan(15);
      for (const m of msgs) {
        expect(Buffer.from(m.bodyText).includes(Buffer.from("printer"))).toBe(false);
        expect(decryptField(m.bodyText, key(), `${ACME}:Message.bodyText`).length).toBeGreaterThan(10);
      }
      const raw = await tx.rawEvent.findFirstOrThrow();
      expect(JSON.parse(decryptField(raw.payload, key(), `${ACME}:RawEvent.payload`)).synthetic).toBe(true);
    });
  });

  it("uses only synthetic addresses and a SYNTHETIC connection (rule 7)", async () => {
    await acme(async (tx) => {
      expect((await tx.sourceConnection.findMany()).every((c) => c.provider === "SYNTHETIC")).toBe(true);
      const participants = await tx.participant.findMany();
      expect(participants.every((p) => /\.synthetic\.(test)$|@synthetic\.loopsignal\.test$/.test(p.address))).toBe(true);
    });
  });

  it("leaves intact audit chains in both organizations", async () => {
    for (const org of [ACME, GLOBEX]) {
      expect(await withTenant({ organizationId: org }, (tx) => verifyAuditChain(tx, org))).toEqual({ intact: true });
      expect(await withTenant({ organizationId: org }, (tx) => tx.auditLog.count())).toBeGreaterThanOrEqual(4); // Globex: 2 created + 1 transition + fixture marker
    }
  });

  it("keeps the two organizations isolated", async () => {
    const globexItems = await withTenant({ organizationId: GLOBEX }, (tx) => tx.trackedItem.findMany());
    expect(globexItems).toHaveLength(2);
    const acmeIds = new Set((await acme((tx) => tx.trackedItem.findMany())).map((i) => i.id));
    expect(globexItems.some((i) => acmeIds.has(i.id))).toBe(false);
  });

  it("was driven through the engine: analyzer steps are attributed to their AnalysisRun, every transition is audited", async () => {
    await acme(async (tx) => {
      const events = await tx.lifecycleEvent.findMany({ where: { fromState: { not: null } } });
      expect(events.length).toBeGreaterThan(15);
      for (const e of events.filter((x) => x.actorType === "ANALYZER")) {
        expect(e.analysisRunId, `${e.toState}`).not.toBeNull();
        expect((await tx.analysisRun.findUniqueOrThrow({ where: { id: e.analysisRunId! } })).status).toBe("OK");
      }
      expect(events.some((e) => e.actorType === "ANALYZER")).toBe(true);
      const audited = await tx.auditLog.count({ where: { action: "item.transitioned" } });
      expect(audited).toBe(events.length);
    });
  });

  it("queued the proposed resolution's approval through the engine, not by hand", async () => {
    await acme(async (tx) => {
      const it = await byKey(tx, "password-loop");
      expect(await tx.auditLog.count({ where: { entityId: it.id, action: "item.approval_requested" } })).toBe(1);
    });
  });

  it("is idempotent: running the seed again changes nothing", async () => {
    const counts = () => withTenant({ organizationId: ACME }, async (tx) => [
      await tx.trackedItem.count(), await tx.message.count(), await tx.lifecycleEvent.count(), await tx.auditLog.count(),
    ]);
    const before = await counts();
    const out = execFileSync("node", ["--env-file-if-exists=.env", "--import", "tsx", "prisma/seed.ts"], { encoding: "utf8", env: process.env });
    expect(out).toMatch(/already seeded/);
    expect(await counts()).toEqual(before);
  }, 60_000);
});
