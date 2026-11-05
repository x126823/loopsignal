import { HUMAN_DECISION_STATES } from "@/modules/lifecycle";
import { EVIDENCE_REQUIRED, transitionTarget, type AnalyzerOutput } from "./schemas";

export type GuardFailure = "EVIDENCE_NOT_VERBATIM" | "EVIDENCE_UNKNOWN_MESSAGE" | "MISSING_EVIDENCE";

/**
 * Evidence guard (rule 6). Every quote must be a verbatim substring of the ORIGINAL text of the message it cites,
 * and that message must be one the analyzer was actually given. Actions that assert something about the world must
 * cite at least one quote. Returns the first failure, or null when the output is sound.
 */
export function checkEvidence(output: AnalyzerOutput<unknown>, originals: ReadonlyMap<string, string>): GuardFailure | null {
  if (EVIDENCE_REQUIRED.has(output.recommendedAction) && output.evidence.length === 0) return "MISSING_EVIDENCE";
  for (const { messageId, quote } of output.evidence) {
    const text = originals.get(messageId);
    if (text === undefined) return "EVIDENCE_UNKNOWN_MESSAGE";
    if (!text.includes(quote)) return "EVIDENCE_NOT_VERBATIM";
  }
  return null;
}

/**
 * The model's `requiresHumanApproval` is advisory. The final value is forced true for anything that touches a human
 * decision (confirm, close, reopen), for low-confidence results, and for anything the model itself flagged. The
 * lifecycle engine independently refuses to apply human-only transitions, so this is defense in depth.
 */
export function forceApproval(output: AnalyzerOutput<unknown>, confidenceThreshold: number): boolean {
  const target = transitionTarget(output.recommendedAction);
  if (target && HUMAN_DECISION_STATES.has(target)) return true;
  if (output.confidence < confidenceThreshold) return true;
  return output.requiresHumanApproval;
}
