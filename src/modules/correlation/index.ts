// Public API of the correlation module. Other modules import only from here.
export {
  confirmCandidate, findBestMatch, findPendingForThread, listAwaitingFollowUp, listCandidates, listSubjectCandidates, queueCandidate, rejectCandidate, runFollowUp, splitCandidate,
  type AwaitingFollowUp, type CandidateState, type CandidateView, type DecisionOutcome, type FollowUpDeps, type FollowUpOutcome, type Match, type Rationale, type Verdict,
} from "./service";
export { MAX_WINDOW_MS, scorePair, SHOW_THRESHOLD, type MessageFeatures, type Score, type Signal, type SignalName } from "./score";
