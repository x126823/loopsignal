import { z } from "zod";
import type { AnalyzerDefinition } from "./schemas";

/**
 * Analyzers 1-4. Each is only a definition: a name, a prompt version, instructions, and a result schema. The guard
 * pipeline does everything else. BUMP promptVersion on ANY change to instructions or schema (it is part of the cache
 * key and recorded on every AnalysisRun), and re-run the golden sets (`npm run golden`) before relying on the change.
 *
 * Instructions never contain message content. Examples below are invented sentences, not real data.
 */

export const intentResultSchema = z
  .object({
    actionable: z.boolean(),
    kind: z.enum(["request", "question", "incident", "complaint", "follow_up", "other"]),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  })
  .strict();
export type IntentResult = z.infer<typeof intentResultSchema>;

export const intentClassifier: AnalyzerDefinition<IntentResult> = {
  name: "intent_classifier",
  promptVersion: "1",
  resultSchema: intentResultSchema,
  instructions: `Decide whether the LAST message needs action from our team and should be tracked until it is formally closed.

Actionable: someone asks for something, reports a problem, asks a question that needs an answer, or follows up on an open matter, and the message came to us (direction INBOUND).
Not actionable: newsletters and marketing, automatic replies and out-of-office notices, receipts and notifications, a pure thank-you or sign-off, an FYI that asks for nothing, spam, and anything our own team sent (direction OUTBOUND or INTERNAL). A message sent by our own team is never actionable here.

Also classify kind (request, question, incident, complaint, follow_up, or other) and priority. Use URGENT only for outages, safety issues, or an explicit time-critical demand; HIGH when someone is blocked or money is at stake; LOW for non-time-sensitive requests; otherwise NORMAL.

Set recommendedAction to TRACK when actionable, NOT_ACTIONABLE when not, and NEEDS_REVIEW when you cannot tell. For TRACK, cite the exact sentence that makes the message actionable. Keep result.actionable consistent with recommendedAction.`,
};

export const ownershipResultSchema = z.object({ ownerUserId: z.string().uuid().nullable() }).strict();
export type OwnershipResult = z.infer<typeof ownershipResultSchema>;

export const ownershipResolver: AnalyzerDefinition<OwnershipResult> = {
  name: "ownership_resolver",
  promptVersion: "1",
  resultSchema: ownershipResultSchema,
  instructions: `Decide whether the LAST message explicitly names or addresses exactly one of the listed candidates (our team members) as the person who should handle it. Valid signals are a direct mention ("@name"), a direct address ("Name, could you take this?"), or an explicit hand-off ("I have asked Name to look at this").

Do not infer ownership from the topic, seniority, workload, or guesswork. If the message names no candidate, or names more than one, or it is unclear who is meant, set ownerUserId to null. Use the candidate ids exactly as given in the candidate list; never invent an id.

Set recommendedAction to ASSIGN_OWNER only when ownerUserId is set, citing the exact phrase that names that person. Otherwise set it to NONE with no evidence. Messages from our own team that merely sign off with a name do not count as naming an owner.`,
};

export const acknowledgmentResultSchema = z.object({ isAcknowledgment: z.boolean() }).strict();
export type AcknowledgmentResult = z.infer<typeof acknowledgmentResultSchema>;

export const acknowledgmentDetector: AnalyzerDefinition<AcknowledgmentResult> = {
  name: "acknowledgment_detector",
  promptVersion: "1",
  resultSchema: acknowledgmentResultSchema,
  instructions: `Decide whether the LAST message, which our team sent in reply to an earlier request in the thread, is ONLY an acknowledgment.

An acknowledgment confirms we received the request or are looking into it and nothing more: no answer, result, diagnosis, status detail, concrete next step, requested information, or resolution. Examples of acknowledgment-only: "Thanks, we have received this and will look into it." "Got it, we are on it." "We will get back to you shortly."

NOT acknowledgment-only: anything that answers the request, reports a result or cause, gives a concrete date or next step, attaches something, asks for specific information needed to proceed, or offers a workaround. A message that acknowledges AND also does any of these is not acknowledgment-only. A message from the customer is never our acknowledgment.

Set recommendedAction to TRANSITION_ACKNOWLEDGED only when the last message is acknowledgment-only, citing the exact phrase that acknowledges. Otherwise set it to NONE.`,
};

export const substantiveResultSchema = z.object({ isSubstantive: z.boolean() }).strict();
export type SubstantiveResult = z.infer<typeof substantiveResultSchema>;

export const substantiveResponseAnalyzer: AnalyzerDefinition<SubstantiveResult> = {
  name: "substantive_response",
  promptVersion: "1",
  resultSchema: substantiveResultSchema,
  instructions: `Decide whether the LAST message, which our team sent in reply to an earlier request in the thread, is a SUBSTANTIVE response.

Substantive: it engages with the content of the request, giving an answer, a result, a diagnosis, a workaround, a concrete next step with a date or an owner, or a specific question or piece of information needed to proceed.
NOT substantive: pleasantries, a confirmation of receipt, "looking into it", "we will get back to you", generic reassurance, or an apology without content. Receipt confirmations alone are acknowledgments, not responses.

A message from the customer is never our response. Set recommendedAction to TRANSITION_RESPONDED only when the last message is substantive, citing the exact phrase that shows the substance. Otherwise set it to NONE.`,
};

export const ANALYZERS = {
  intent_classifier: intentClassifier,
  ownership_resolver: ownershipResolver,
  acknowledgment_detector: acknowledgmentDetector,
  substantive_response: substantiveResponseAnalyzer,
} as const;
export type AnalyzerName = keyof typeof ANALYZERS;
