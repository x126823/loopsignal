import { canonicalJson, sha256 } from "@/lib/hash";
import { checkEvidence, forceApproval } from "./guard";
import { chooseNonce, systemPrompt, userPrompt, type PromptCandidate, type PromptMessage } from "./prompt";
import { redact } from "./redaction";
import { analyzerOutputSchema, type AnalyzerDefinition, type AnalyzerOutput } from "./schemas";
import type { LLMProvider } from "./types";

/**
 * The database-free heart of the guard pipeline: redact, hash, delimit, call, validate (one bounded retry), check
 * evidence, force human approval. The persistence-facing pipeline (cache, budget, AnalysisRun) wraps it, and golden-set
 * evaluation uses it directly, so both exercise exactly the same guards.
 */
export type FailureReason =
  | "SCHEMA_FAILED"
  | "EVIDENCE_NOT_VERBATIM"
  | "EVIDENCE_UNKNOWN_MESSAGE"
  | "MISSING_EVIDENCE"
  | "REFUSED"
  | "INPUT_TOO_LARGE"
  | "MESSAGE_NOT_FOUND";

export interface CoreMessage {
  id: string;
  direction: string;
  sentAt: Date;
  /** Original text. Redaction happens here, and evidence is checked against this original. */
  text: string;
}

export interface Prepared {
  promptMessages: PromptMessage[];
  candidates: PromptCandidate[];
  originals: ReadonlyMap<string, string>;
  inputHash: string;
  system: string;
  user: string;
}

const MAX_ATTEMPTS = 2; // one call plus one bounded retry on invalid output

export function prepare<R>(
  def: AnalyzerDefinition<R>, messages: CoreMessage[], candidates: PromptCandidate[], provider: Pick<LLMProvider, "name" | "model">, secret: Buffer,
): Prepared {
  const ordered = [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id.localeCompare(b.id));
  const people = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const originals = new Map(ordered.map((m) => [m.id, m.text]));
  const promptMessages: PromptMessage[] = ordered.map((m) => ({ messageId: m.id, direction: m.direction, sentAt: m.sentAt.toISOString(), text: redact(m.text).text }));
  // Identical input, prompt version, provider and model give identical results, so they share a cache entry.
  const inputHash = sha256(canonicalJson({ analyzer: def.name, promptVersion: def.promptVersion, provider: provider.name, model: provider.model, messages: promptMessages, candidates: people }));
  const nonce = chooseNonce(secret, inputHash, promptMessages, people);
  return {
    promptMessages, candidates: people, originals, inputHash,
    system: systemPrompt(def.instructions, def.promptVersion),
    user: userPrompt(promptMessages, nonce, people),
  };
}

export type ExecResult<R> =
  | { kind: "ok"; output: AnalyzerOutput<R>; tokensIn: number; tokensOut: number; attempts: number }
  | { kind: "failed"; reason: FailureReason; tokensIn: number; tokensOut: number; extra: Record<string, unknown> };

/** Call the provider and apply every output guard. Never throws for model misbehavior; provider errors propagate. */
export async function execute<R>(def: AnalyzerDefinition<R>, prepared: Prepared, provider: LLMProvider, confidenceThreshold: number): Promise<ExecResult<R>> {
  const envelope = analyzerOutputSchema(def.resultSchema);
  let tokensIn = 0;
  let tokensOut = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await provider.complete({
      analyzer: def.name, promptVersion: def.promptVersion, system: prepared.system, user: prepared.user, schema: envelope, maxOutputTokens: def.maxOutputTokens ?? 8_192,
    });
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;

    if (res.kind === "refusal") return { kind: "failed", reason: "REFUSED", tokensIn, tokensOut, extra: { category: res.category } };

    const parsed = res.kind === "output" ? envelope.safeParse(res.json) : null;
    if (!parsed?.success) {
      if (attempt < MAX_ATTEMPTS) continue;
      return { kind: "failed", reason: "SCHEMA_FAILED", tokensIn, tokensOut, extra: {} };
    }

    // Evidence must be verbatim from the ORIGINAL text of a message we supplied.
    const problem = checkEvidence(parsed.data, prepared.originals);
    if (problem) return { kind: "failed", reason: problem, tokensIn, tokensOut, extra: {} };

    // Human approval is forced where required, whatever the model said.
    const output = { ...parsed.data, requiresHumanApproval: forceApproval(parsed.data, confidenceThreshold) };
    return { kind: "ok", output, tokensIn, tokensOut, attempts: attempt };
  }
  return { kind: "failed", reason: "SCHEMA_FAILED", tokensIn, tokensOut, extra: {} }; // unreachable; satisfies the compiler
}
