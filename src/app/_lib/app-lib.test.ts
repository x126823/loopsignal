import { describe, expect, it } from "vitest";
import type { Principal } from "@/modules/identity";
import type { ItemState } from "../../../generated/prisma/enums";
import { availableTransitions, canDecideApproval, transitionButtonLabel } from "./available-actions";
import { approvalForm, devLoginForm, formObject, orgForm, ownerForm, reviewForm, transitionForm } from "./forms";
import { isNoticeKey, noticeForDecision, noticeForOutcome, noticeForOwner, noticeForReview, NOTICES, parseNotice } from "./notices";

const U = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const p = (orgRole: Principal["orgRole"], teamRole?: Principal["orgRole"]): Principal => ({ userId: U, organizationId: ORG, orgRole, teamRoles: teamRole ? { [TEAM]: teamRole } : {} });
const item = (state: ItemState) => ({ organizationId: ORG, state, teamId: TEAM });

describe("availableTransitions (which buttons to offer)", () => {
  it("offers confirmation only from RESOLUTION_PROPOSED, and closing only from RESOLUTION_CONFIRMED", () => {
    expect(availableTransitions(p("MEMBER", "MEMBER"), item("RESOLUTION_PROPOSED"))).toEqual(expect.arrayContaining(["RESOLUTION_CONFIRMED", "IN_PROGRESS"]));
    expect(availableTransitions(p("MEMBER", "MEMBER"), item("RESOLUTION_CONFIRMED"))).toEqual(expect.arrayContaining(["CLOSED", "REOPENED"]));
    for (const state of ["RECEIVED", "ACKNOWLEDGED", "RESPONDED", "IN_PROGRESS", "CLOSED", "REOPENED"] as ItemState[]) {
      expect(availableTransitions(p("ORG_ADMIN"), item(state)), state).not.toContain("CLOSED");
      expect(availableTransitions(p("ORG_ADMIN"), item(state)), state).not.toContain("RESOLUTION_CONFIRMED");
    }
  });

  it("offers nothing to viewers and auditors, or to someone with no role on the team", () => {
    for (const state of ["RESPONDED", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED"] as ItemState[]) {
      expect(availableTransitions(p("VIEWER", "VIEWER"), item(state)), `viewer ${state}`).toEqual([]);
      expect(availableTransitions(p("AUDITOR", "AUDITOR"), item(state)), `auditor ${state}`).toEqual([]);
      expect(availableTransitions(p("MEMBER"), item(state)), `no team role ${state}`).toEqual([]);
    }
  });

  it("never offers the automated-only transitions to a person (acknowledged, responded)", () => {
    for (const state of ["RECEIVED", "ACKNOWLEDGED", "REOPENED"] as ItemState[]) {
      const offered = availableTransitions(p("ORG_ADMIN"), item(state));
      expect(offered).not.toContain("ACKNOWLEDGED");
      expect(offered).not.toContain("RESPONDED");
    }
  });

  it("respects the organization's approval bar for confirm and close, but not for ordinary actions", () => {
    const member = p("MEMBER", "MEMBER");
    const strict = { approvalMinRole: "TEAM_LEAD" } as const;
    expect(availableTransitions(member, item("RESOLUTION_PROPOSED"), strict)).not.toContain("RESOLUTION_CONFIRMED");
    expect(availableTransitions(member, item("RESOLUTION_PROPOSED"), strict)).toContain("IN_PROGRESS"); // rejecting a proposal is an ordinary action
    expect(availableTransitions(p("TEAM_LEAD", "TEAM_LEAD"), item("RESOLUTION_PROPOSED"), strict)).toContain("RESOLUTION_CONFIRMED");
    expect(availableTransitions(member, item("RESOLUTION_CONFIRMED"), strict)).not.toContain("CLOSED");
  });

  it("a principal from another organization is offered nothing", () => {
    expect(availableTransitions({ ...p("ORG_ADMIN"), organizationId: "44444444-4444-4444-8444-444444444444" }, item("RESOLUTION_PROPOSED"))).toEqual([]);
  });

  it("canDecideApproval follows the same rule", () => {
    expect(canDecideApproval(p("MEMBER", "MEMBER"), item("RESOLUTION_PROPOSED"), "RESOLUTION_CONFIRMED")).toBe(true);
    expect(canDecideApproval(p("VIEWER", "VIEWER"), item("RESOLUTION_PROPOSED"), "RESOLUTION_CONFIRMED")).toBe(false);
    expect(canDecideApproval(p("MEMBER", "MEMBER"), item("RECEIVED"), "RESOLUTION_CONFIRMED")).toBe(false); // not reachable from here
  });

  it("labels reject-proposal differently from marking in progress", () => {
    expect(transitionButtonLabel("RESOLUTION_PROPOSED", "IN_PROGRESS")).toBe("Reject proposal");
    expect(transitionButtonLabel("RESPONDED", "IN_PROGRESS")).toBe("Mark in progress");
    expect(transitionButtonLabel("RESPONDED", "RESOLUTION_PROPOSED")).toBe("Propose resolution");
  });
});

describe("form schemas", () => {
  const base = { itemId: U, to: "CLOSED", expectedVersion: "4" };
  it("accepts a valid transition, coerces the version, and drops an empty reason", () => {
    expect(transitionForm.parse({ ...base, reason: "  " })).toEqual({ itemId: U, to: "CLOSED", expectedVersion: 4 });
    expect(transitionForm.parse({ ...base, reason: " ok " }).reason).toBe("ok");
  });
  it("rejects targets a person cannot ask for, bad ids and versions, and over-long reasons", () => {
    for (const bad of [{ to: "ACKNOWLEDGED" }, { to: "RESPONDED" }, { to: "NOPE" }, { itemId: "x" }, { expectedVersion: "0" }, { expectedVersion: "abc" }, { reason: "x".repeat(501) }]) {
      expect(transitionForm.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(transitionForm.safeParse({ itemId: U, to: "CLOSED" }).success).toBe(false); // the version is required
  });
  it("validates approvals, owners, reviews, organizations and dev login", () => {
    expect(approvalForm.safeParse({ approvalRequestId: U, itemId: U, decision: "APPROVE", expectedVersion: "2" }).success).toBe(true);
    expect(approvalForm.safeParse({ approvalRequestId: U, itemId: U, decision: "MAYBE", expectedVersion: "2" }).success).toBe(false);
    expect(ownerForm.parse({ itemId: U, userId: "" }).userId).toBeNull();
    expect(ownerForm.parse({ itemId: U, userId: U }).userId).toBe(U);
    expect(ownerForm.safeParse({ itemId: U, userId: "carol" }).success).toBe(false);
    expect(reviewForm.safeParse({ taskId: U, status: "RESOLVED" }).success).toBe(true);
    expect(reviewForm.safeParse({ taskId: U, status: "DELETED" }).success).toBe(false);
    expect(orgForm.safeParse({ organizationId: "nope" }).success).toBe(false);
    expect(devLoginForm.parse({ email: "  Alice@Synthetic.LoopSignal.Test " }).email).toBe("alice@synthetic.loopsignal.test");
    expect(devLoginForm.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
  it("ignores unknown fields and framework fields when reading FormData", () => {
    const fd = new FormData();
    fd.append("itemId", U);
    fd.append("itemId", "second-value");
    fd.append("$ACTION_ID_abc", "x");
    fd.append("file", new Blob(["x"]), "x.txt");
    expect(formObject(fd)).toEqual({ itemId: U });
  });
});

describe("notices", () => {
  it("only honours known keys from the URL", () => {
    expect(parseNotice("applied")?.tone).toBe("success");
    expect(parseNotice(["applied", "forbidden"])?.key).toBe("applied");
    for (const bad of [undefined, "", "<script>alert(1)</script>", "__proto__", "constructor", "toString", "Hello world"]) expect(parseNotice(bad), String(bad)).toBeNull();
    expect(isNoticeKey("constructor")).toBe(false);
  });
  it("maps every engine outcome to a notice", () => {
    expect(noticeForOutcome({ outcome: "APPLIED", itemId: U, fromState: "RECEIVED", toState: "CLOSED", version: 2, eventId: U })).toBe("applied");
    expect(noticeForOutcome({ outcome: "APPROVAL_REQUIRED", approvalRequestId: U })).toBe("queued");
    expect(noticeForOutcome({ outcome: "NEEDS_REVIEW", reviewTaskId: U, reason: "LOW_CONFIDENCE" })).toBe("review");
    expect(noticeForOutcome({ outcome: "NOOP", reason: "ALREADY_IN_STATE" })).toBe("noop");
    const rejected = (reason: Parameters<typeof noticeForOutcome>[0] extends infer O ? (O extends { outcome: "REJECTED"; reason: infer R } ? R : never) : never) => noticeForOutcome({ outcome: "REJECTED", reason });
    expect(rejected("STALE_VERSION")).toBe("stale");
    expect(rejected("ILLEGAL_TRANSITION")).toBe("illegal");
    expect(rejected("INVALID_ACTOR")).toBe("illegal");
    expect(rejected("THREAD_HAS_OPEN_ITEM")).toBe("thread_open");
    expect(rejected("NOT_FOUND")).toBe("not_found");
  });
  it("maps decisions, owners and reviews, and every key it can return exists", () => {
    const keys = [
      noticeForDecision({ outcome: "DECIDED", approvalRequestId: U, status: "APPROVED", transition: { outcome: "APPLIED", itemId: U, fromState: "RECEIVED", toState: "CLOSED", version: 2, eventId: U } }),
      noticeForDecision({ outcome: "DECIDED", approvalRequestId: U, status: "REJECTED" }),
      noticeForDecision({ outcome: "DECIDED", approvalRequestId: U, status: "APPROVED", transition: { outcome: "REJECTED", reason: "STALE_VERSION" } }),
      noticeForDecision({ outcome: "REJECTED", reason: "NOT_PENDING" }),
      noticeForOwner({ outcome: "ASSIGNED", ownerUserId: U }), noticeForOwner({ outcome: "NOOP" }), noticeForOwner({ outcome: "REJECTED", reason: "NOT_A_MEMBER" }),
      noticeForReview({ outcome: "RESOLVED" }), noticeForReview({ outcome: "DISMISSED" }), noticeForReview({ outcome: "REJECTED", reason: "NOT_OPEN" }),
    ];
    expect(keys).toEqual(["approved", "rejected", "stale", "not_pending", "owner_assigned", "owner_noop", "owner_not_member", "review_resolved", "review_dismissed", "review_not_open"]);
    for (const k of keys) expect(Object.keys(NOTICES)).toContain(k);
  });
});
