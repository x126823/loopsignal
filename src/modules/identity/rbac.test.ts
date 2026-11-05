import { describe, expect, it } from "vitest";
import type { Role } from "../../../generated/prisma/enums";
import { assertCan, can, ForbiddenError, type Action, type Principal } from "./rbac";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const principal = (orgRole: Role, teamRole?: Role): Principal => ({
  userId: "u",
  organizationId: ORG,
  orgRole,
  teamRoles: teamRole ? { [TEAM]: teamRole } : {},
});

const ACTIONS: Action[] = ["org:manage", "audit:view", "report:view", "team:manage", "item:view", "item:act", "item:confirm", "item:close"];
const on = { organizationId: ORG, teamId: TEAM };

// Expected allow-list per principal, on a team they belong to (or, for AUDITOR/ORG_ADMIN, org-wide).
const matrix: Array<[string, Principal, Action[]]> = [
  ["ORG_ADMIN", principal("ORG_ADMIN"), ACTIONS],
  ["TEAM_LEAD on team", principal("TEAM_LEAD", "TEAM_LEAD"), ["report:view", "team:manage", "item:view", "item:act", "item:confirm", "item:close"]],
  ["MEMBER on team", principal("MEMBER", "MEMBER"), ["report:view", "item:view", "item:act", "item:confirm", "item:close"]],
  ["VIEWER on team", principal("VIEWER", "VIEWER"), ["report:view", "item:view"]],
  ["AUDITOR (no team)", principal("AUDITOR"), ["audit:view", "report:view", "item:view"]],
  ["MEMBER not on team", principal("MEMBER"), ["report:view"]],
  ["TEAM_LEAD not on team", principal("TEAM_LEAD"), ["report:view"]],
];

describe("role matrix", () => {
  for (const [name, p, allowed] of matrix) {
    for (const action of ACTIONS) {
      const expected = allowed.includes(action);
      it(`${name}: ${action} -> ${expected ? "allow" : "deny"}`, () => {
        expect(can(p, action, on)).toBe(expected);
      });
    }
  }
});

describe("capping and scoping", () => {
  it("caps a team MEMBER role at read-only when the org role is VIEWER or AUDITOR", () => {
    for (const orgRole of ["VIEWER", "AUDITOR"] as const) {
      const p = principal(orgRole, "MEMBER");
      expect(can(p, "item:view", on)).toBe(true);
      expect(can(p, "item:act", on)).toBe(false);
      expect(can(p, "item:confirm", on)).toBe(false);
      expect(can(p, "item:close", on)).toBe(false);
    }
  });

  it("grants nothing on a team the user does not belong to", () => {
    const p = principal("MEMBER", "MEMBER");
    expect(can(p, "item:view", { organizationId: ORG, teamId: OTHER_TEAM })).toBe(false);
    expect(can(p, "item:act", { organizationId: ORG })).toBe(false);
  });

  it("denies every action, even for ORG_ADMIN, on another organization's resource", () => {
    const admin = principal("ORG_ADMIN");
    for (const action of ACTIONS) {
      expect(can(admin, action, { organizationId: OTHER_ORG, teamId: TEAM })).toBe(false);
    }
  });

  it("lets AUDITOR read items but not act, confirm or close, even with a team role", () => {
    const p = principal("AUDITOR", "AUDITOR");
    expect(can(p, "item:view", { organizationId: ORG, teamId: OTHER_TEAM })).toBe(true);
    expect(can(p, "item:act", on)).toBe(false);
    expect(can(p, "item:close", on)).toBe(false);
  });
});

describe("approvalMinRole (per-org configuration)", () => {
  it("raises the bar for confirm and close but not for acting", () => {
    const member = principal("MEMBER", "MEMBER");
    const lead = principal("TEAM_LEAD", "TEAM_LEAD");
    const opts = { approvalMinRole: "TEAM_LEAD" } as const;
    expect(can(member, "item:act", on, opts)).toBe(true);
    expect(can(member, "item:confirm", on, opts)).toBe(false);
    expect(can(member, "item:close", on, opts)).toBe(false);
    expect(can(lead, "item:confirm", on, opts)).toBe(true);
    expect(can(lead, "item:close", on, opts)).toBe(true);
  });

  it("ORG_ADMIN-only approval excludes team leads", () => {
    const lead = principal("TEAM_LEAD", "TEAM_LEAD");
    expect(can(lead, "item:close", on, { approvalMinRole: "ORG_ADMIN" })).toBe(false);
    expect(can(principal("ORG_ADMIN"), "item:close", on, { approvalMinRole: "ORG_ADMIN" })).toBe(true);
  });
});

describe("assertCan", () => {
  it("throws ForbiddenError on deny and returns on allow", () => {
    expect(() => assertCan(principal("VIEWER", "VIEWER"), "item:close", on)).toThrow(ForbiddenError);
    expect(() => assertCan(principal("MEMBER", "MEMBER"), "item:close", on)).not.toThrow();
  });
});
