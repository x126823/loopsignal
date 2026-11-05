import type { ItemState } from "../../generated/prisma/enums";
import type { AcknowledgmentResult, AnalysisOutcome, IntentResult, OwnershipResult, SubstantiveResult } from "@/modules/intelligence";
import type { TeamCandidate } from "@/modules/tenancy";

/**
 * Decision rules that sit between an analyzer's recommendation and the lifecycle engine. They are pure and deliberately
 * independent of the model: they encode what must be true for a recommendation to be acted on, so a fooled or mistaken
 * model still cannot cross them. (The engine and the pipeline add their own checks: legal transitions, confidence,
 * verbatim evidence, human-only decisions.)
 */
export type Direction = "INBOUND" | "OUTBOUND" | "INTERNAL";
export type Ok<R> = Extract<AnalysisOutcome<R>, { outcome: "OK" }>;

interface Cited {
  evidence: ReadonlyArray<{ messageId: string }>;
}

/** All of the evidence cites the one message being analyzed, and there is at least one citation. */
export const citesOnly = (out: Cited, subjectId: string): boolean => out.evidence.length > 0 && out.evidence.every((e) => e.messageId === subjectId);

/**
 * "Rule-verified": an acknowledgment or response must come from OUR side. A message from the outside (INBOUND) can never
 * be our acknowledgment or response, however it is worded, and the evidence must be that message itself.
 */
export const verifyReply = (out: Cited, subject: { id: string; direction: Direction }): boolean => subject.direction !== "INBOUND" && citesOnly(out, subject.id);

/** Track only when the recommendation and the result agree: a mismatch is treated as unreliable and not acted on. */
export const shouldTrack = (out: Ok<IntentResult>): boolean => out.recommendedAction === "TRACK" && out.result.actionable === true;

const firstName = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * Accept an AI-resolved owner only when every condition holds: the recommendation is ASSIGN_OWNER, the id is a real
 * candidate, the model did not need human approval (confidence is above the threshold), the evidence is the subject
 * message, and the quoted phrase actually contains that person's handle or first name. Otherwise returns null and a
 * human decides. (This does not stop a name that appears for another reason, so ownership stays reviewable.)
 */
export function acceptedOwner(out: Ok<OwnershipResult>, candidates: readonly TeamCandidate[], subjectId: string): string | null {
  if (out.recommendedAction !== "ASSIGN_OWNER" || out.result.ownerUserId === null || out.requiresHumanApproval) return null;
  const owner = candidates.find((c) => c.id === out.result.ownerUserId);
  if (!owner || !citesOnly(out, subjectId)) return null;
  const quoted = out.evidence.map((e) => e.quote.toLowerCase()).join(" ");
  const named = quoted.includes(owner.handle.toLowerCase()) || (firstName(owner.name).length >= 2 && quoted.includes(firstName(owner.name)));
  return named ? owner.id : null;
}

export type ReplyDecision = { kind: "RESPONDED" } | { kind: "ACKNOWLEDGED" } | { kind: "NONE" } | { kind: "CONTRADICTION" };

/**
 * Rule 5: acknowledgment is not a substantive response. A reply is RESPONDED only if it is substantive and not an
 * acknowledgment; ACKNOWLEDGED only if it is an acknowledgment and not substantive. If the two analyzers disagree with
 * each other (both say yes), nothing moves and a human looks, because claiming a response early would flatter the
 * response-time metric. Each analyzer's output must also pass rule verification (our side, citing the message itself).
 */
export function decideReply(
  state: ItemState,
  subject: { id: string; direction: Direction },
  substantive: Ok<SubstantiveResult> | null,
  ack: Ok<AcknowledgmentResult> | null,
): ReplyDecision {
  const isSub = substantive !== null && verifyReply(substantive, subject) && substantive.recommendedAction === "TRANSITION_RESPONDED" && substantive.result.isSubstantive;
  const isAck = ack !== null && verifyReply(ack, subject) && ack.recommendedAction === "TRANSITION_ACKNOWLEDGED" && ack.result.isAcknowledgment;
  if (isSub && isAck) return { kind: "CONTRADICTION" };
  if (isSub && (state === "RECEIVED" || state === "ACKNOWLEDGED" || state === "REOPENED")) return { kind: "RESPONDED" };
  if (isAck && (state === "RECEIVED" || state === "REOPENED")) return { kind: "ACKNOWLEDGED" };
  return { kind: "NONE" };
}

/** Next 00:05 UTC: when the daily LLM budget window rolls over. */
export function nextBudgetWindow(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
}
