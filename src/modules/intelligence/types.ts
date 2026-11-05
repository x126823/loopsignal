import type { z } from "zod";

/**
 * Provider contract. A provider turns one prompt into unvalidated JSON plus usage. It is NOT trusted: the guard
 * pipeline validates everything it returns. Providers have no tools, no side effects and no network access beyond
 * their own model endpoint (analyzers can only recommend).
 */
export interface ProviderRequest {
  analyzer: string;
  promptVersion: string;
  /** Versioned instructions. Contains no message content. */
  system: string;
  /** Redacted, delimited, untrusted message content. */
  user: string;
  /** Output schema, used by providers that can constrain decoding. The pipeline validates regardless. */
  schema: z.ZodType<unknown>;
  maxOutputTokens: number;
}

export type ProviderResponse =
  | { kind: "output"; json: unknown; tokensIn: number; tokensOut: number; model: string }
  /** The model's safety classifiers declined. Never retried on another model; routed to human review. */
  | { kind: "refusal"; category: string | null; tokensIn: number; tokensOut: number; model: string }
  /** Output was cut off at the token limit, so it cannot be a complete answer. */
  | { kind: "truncated"; tokensIn: number; tokensOut: number; model: string };

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** A provider failure that is not an answer. `retryable` tells the job queue whether trying again can help. */
export class ProviderError extends Error {
  constructor(readonly retryable: boolean, readonly code: string) {
    super(`LLM provider error: ${code}`); // never include request or response content
    this.name = "ProviderError";
  }
}
