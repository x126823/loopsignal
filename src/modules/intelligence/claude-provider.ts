import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ProviderError, type LLMProvider, type ProviderRequest, type ProviderResponse } from "./types";

/** The slice of the SDK client we use, so tests can inject a stub and never touch the network. */
export interface ClaudeClientLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface ClaudeProviderOptions {
  model: string;
  effort: "low" | "medium" | "high";
  /** Injected for tests. Defaults to a real client, which reads its own credentials (never read or stored here). */
  client?: ClaudeClientLike;
}

/**
 * Claude via the official SDK, Messages API, structured outputs only: no tools, no prefill, no server tools, no
 * fallback model. Message content goes only to the configured model. A refusal is returned as a refusal (the
 * pipeline routes it to human review), never retried elsewhere. Request and response content is never logged.
 */
export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  readonly model: string;
  private readonly client: ClaudeClientLike;
  private readonly effort: ClaudeProviderOptions["effort"];

  constructor(opts: ClaudeProviderOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.client = opts.client ?? new Anthropic();
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: this.effort, format: zodOutputFormat(req.schema) },
      });
    } catch (e) {
      throw classify(e);
    }

    const u = message.usage;
    const tokensIn = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const tokensOut = u.output_tokens;

    if (message.stop_reason === "refusal") {
      const category = (message as { stop_details?: { category?: string | null } }).stop_details?.category ?? null;
      return { kind: "refusal", category, tokensIn, tokensOut, model: this.model };
    }
    if (message.stop_reason === "max_tokens") return { kind: "truncated", tokensIn, tokensOut, model: this.model };

    const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (text === undefined) return { kind: "output", json: undefined, tokensIn, tokensOut, model: this.model };
    try {
      return { kind: "output", json: JSON.parse(text), tokensIn, tokensOut, model: this.model };
    } catch {
      return { kind: "output", json: undefined, tokensIn, tokensOut, model: this.model }; // the pipeline rejects it as invalid
    }
  }
}

/** Map SDK errors to a retryability decision. Messages are dropped: they can echo request content (rule 10). */
function classify(e: unknown): ProviderError {
  if (e instanceof Anthropic.RateLimitError) return new ProviderError(true, "RATE_LIMITED");
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(true, "CONNECTION");
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError(false, "AUTH");
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError(false, "BAD_REQUEST");
  }
  if (e instanceof Anthropic.APIError) return new ProviderError((e.status ?? 500) >= 500 || e.status === 408 || e.status === 409, `HTTP_${e.status ?? "UNKNOWN"}`);
  return new ProviderError(true, "UNKNOWN");
}
