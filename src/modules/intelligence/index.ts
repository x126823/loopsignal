// Public API of the intelligence module. Other modules import only from here.
// Analyzers only RECOMMEND. Nothing in this module writes lifecycle state (rule 1); a lint rule forbids importing
// the lifecycle mutators here. Callers pass a validated recommendation to lifecycle.propose().
export { ClaudeProvider, type ClaudeClientLike, type ClaudeProviderOptions } from "./claude-provider";
export { FakeProvider, type FakeReply, type FakeResponder } from "./fake-provider";
export { checkEvidence, forceApproval, type GuardFailure } from "./guard";
export { runAnalyzer, type AnalysisOutcome, type AnalyzeRequest, type FailureReason, type PipelineDeps } from "./pipeline";
export { chooseNonce, delimiterNonce, systemPrompt, userPrompt, type PromptMessage } from "./prompt";
export { createProviderFromEnv } from "./provider-factory";
export { redact, type RedactionKind, type RedactionResult } from "./redaction";
export {
  analyzerOutputSchema, evidenceItemSchema, EVIDENCE_REQUIRED, MAX_QUOTE_LENGTH, RECOMMENDED_ACTIONS, recommendedActionSchema, transitionTarget,
  type AnalyzerDefinition, type AnalyzerOutput, type EvidenceItem, type RecommendedAction,
} from "./schemas";
export { ProviderError, type LLMProvider, type ProviderRequest, type ProviderResponse } from "./types";
