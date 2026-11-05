import { gid, goldenCase, type GoldenCandidate } from "../types";

export const ALICE: GoldenCandidate = { id: gid("candidate:alice"), name: "Alice Admin", handle: "alice" };
export const BOB: GoldenCandidate = { id: gid("candidate:bob"), name: "Bob Lead", handle: "bob" };
export const CAROL: GoldenCandidate = { id: gid("candidate:carol"), name: "Carol Member", handle: "carol" };
const TEAM = [ALICE, BOB, CAROL];

const c = <E>(id: string, expected: E, text: string, note?: string) => goldenCase(id, expected, [["in", text]], { candidates: TEAM, ...(note ? { note } : {}) });

/** Ownership resolver golden set. expected.ownerUserId: who the message explicitly names, or null. */
export const OWNERSHIP_CASES = [
  c("owner-at-mention", { ownerUserId: CAROL.id }, "@carol can you take this one? The export is failing for us."),
  c("owner-direct-address", { ownerUserId: BOB.id }, "Bob, could you handle this renewal question when you get a chance?"),
  c("owner-handoff", { ownerUserId: ALICE.id }, "I have asked Alice to look into the billing discrepancy."),
  c("owner-cc", { ownerUserId: CAROL.id }, "Copying Carol so she can pick this up. The SSO setup is stuck."),
  c("owner-hi-name", { ownerUserId: CAROL.id }, "Hi Carol, please take a look at the attached invoice."),
  c("owner-handle-mention", { ownerUserId: BOB.id }, "Routing to @bob since he handled our last contract."),
  c("owner-no-name", { ownerUserId: null }, "This looks like a billing question, can someone help?"),
  c("owner-anyone", { ownerUserId: null }, "Can someone take this? Whoever is free is fine."),
  c("owner-two-names", { ownerUserId: null }, "Alice and Bob, whichever of you is free, please look at this."),
  c("owner-topic-guess", { ownerUserId: null }, "Our database keeps timing out, this must be an infrastructure issue."),
  c("owner-manager", { ownerUserId: null }, "Please escalate this to your manager."),
  c("owner-signoff", { ownerUserId: null }, "Thanks for the quick fix. Best regards, Carol", "a customer named Carol signing off does not name our Carol as owner"),
  c("owner-company-name", { ownerUserId: null }, "The invoice came from Bob's Hardware and the total is wrong.", "a name inside a company name"),
  c("owner-other-person", { ownerUserId: null }, "Our CFO, Alice Johnson, asked me to write about the contract.", "same first name, different person"),
  c("owner-empty-team-style", { ownerUserId: null }, "Hello, I would like to know more about your pricing."),
];
