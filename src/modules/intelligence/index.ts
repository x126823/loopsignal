// Public API of the intelligence module. Other modules import only from here.
// Analyzers only RECOMMEND. Nothing in this module writes lifecycle state (rule 1); a lint rule forbids importing
// the lifecycle mutators here. Callers pass a validated recommendation to lifecycle.propose().
export { ClaudeProvider, type ClaudeClientLike, type ClaudeProviderOptions } from "./claude-provider";
export { FakeProvider, type FakeReply, type FakeResponder } from "./fake-provider";
export { checkEvidence, forceApproval, type GuardFailure } from "./guard";
export { attachRunsToItem, listItemAnalysis, runAnalyzer, type ItemAnalysisView, type AnalysisOutcome, type AnalyzeRequest, type FailureReason, type PipelineDeps } from "./pipeline";
export { chooseNonce, delimiterNonce, systemPrompt, userPrompt, validateFacts, type PromptFacts, type PromptMessage } from "./prompt";
export { createProviderFromEnv } from "./provider-factory";
export { redact, type RedactionKind, type RedactionResult } from "./redaction";
export {
  analyzerOutputSchema, evidenceItemSchema, EVIDENCE_REQUIRED, MAX_QUOTE_LENGTH, RECOMMENDED_ACTIONS, recommendedActionSchema, transitionTarget,
  type AnalyzerDefinition, type AnalyzerOutput, type EvidenceItem, type RecommendedAction,
} from "./schemas";
export { ProviderError, type LLMProvider, type ProviderRequest, type ProviderResponse } from "./types";
export { ANALYZERS, acknowledgmentDetector, correlationAnalyzer, intentClassifier, ownershipResolver, progressAnalyzer, resolutionAnalyzer, slaRiskAnalyzer, substantiveResponseAnalyzer, type AnalyzerName, type AcknowledgmentResult, type CorrelationResult, type IntentResult, type OwnershipResult, type ProgressResult, type ResolutionResult, type SlaRiskResult, type SubstantiveResult } from "./analyzers";
export { recommendThreshold, type Calibration, type Sample } from "./calibration";
export { execute, prepare, type CoreMessage, type ExecResult, type Prepared } from "./core";
export { HeuristicProvider } from "./heuristic-provider";
export { GOLDEN_SETS, runGolden, toBaseline, type AnalyzerMetrics, type Baseline, type CaseRow, type GoldenReport } from "./golden/harness";
