import { z } from "zod";
import type { ItemState } from "../../../generated/prisma/enums";

/**
 * Common analyzer output. Every analyzer returns this envelope around its own `result`. All of it is validated with
 * Zod after the model answers; nothing the model says is trusted before that (rule 6).
 */
export const RECOMMENDED_ACTIONS = [
  "NONE",
  "TRACK",
  "NOT_ACTIONABLE",
  "NEEDS_REVIEW",
  "ASSIGN_OWNER",
  "LINK_CANDIDATE",
  "TRANSITION_ACKNOWLEDGED",
  "TRANSITION_RESPONDED",
  "TRANSITION_IN_PROGRESS",
  "TRANSITION_RESOLUTION_PROPOSED",
  "TRANSITION_RESOLUTION_CONFIRMED",
  "TRANSITION_CLOSED",
  "TRANSITION_REOPENED",
] as const;
export const recommendedActionSchema = z.enum(RECOMMENDED_ACTIONS);
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

/** The lifecycle state a TRANSITION_* recommendation targets, or null for other actions. */
export function transitionTarget(action: RecommendedAction): ItemState | null {
  return action.startsWith("TRANSITION_") ? (action.slice("TRANSITION_".length) as ItemState) : null;
}

/** Actions that must carry at least one verbatim evidence quote. */
export const EVIDENCE_REQUIRED: ReadonlySet<RecommendedAction> = new Set(
  RECOMMENDED_ACTIONS.filter((a) => a !== "NONE" && a !== "NOT_ACTIONABLE" && a !== "NEEDS_REVIEW"),
);

export const MAX_QUOTE_LENGTH = 500;

export const evidenceItemSchema = z.object({ messageId: z.string().uuid(), quote: z.string().min(1).max(MAX_QUOTE_LENGTH) }).strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export function analyzerOutputSchema<R>(result: z.ZodType<R>) {
  return z
    .object({
      result,
      confidence: z.number().min(0).max(1),
      evidence: z.array(evidenceItemSchema).max(5),
      recommendedAction: recommendedActionSchema,
      requiresHumanApproval: z.boolean(),
    })
    .strict();
}
export type AnalyzerOutput<R> = z.infer<ReturnType<typeof analyzerOutputSchema<R>>>;

export interface AnalyzerDefinition<R> {
  /** Stable analyzer name, stored on every AnalysisRun. */
  name: string;
  /** Bump on ANY prompt or schema change: it is part of the cache key and recorded on every run. */
  promptVersion: string;
  /** Analyzer-specific instructions. Never contains message content. */
  instructions: string;
  resultSchema: z.ZodType<R>;
  maxOutputTokens?: number;
  /** Advisory analyzers only produce hints for people and never drive a decision, so a failed run is recorded but does not queue a review task. */
  advisory?: boolean;
}
