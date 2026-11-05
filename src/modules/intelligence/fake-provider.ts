import { ProviderError, type LLMProvider, type ProviderRequest, type ProviderResponse } from "./types";

export type FakeReply =
  | { kind: "output"; json: unknown }
  | { kind: "refusal"; category?: string }
  | { kind: "truncated" }
  | { kind: "error"; error: ProviderError };

export type FakeResponder = (req: ProviderRequest, callNumber: number) => FakeReply | Promise<FakeReply>;

const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic provider for tests and local development. It records every request, and a responder decides each
 * reply, so tests can script good answers, malformed ones, refusals, and a *compromised* model that obeys whatever
 * the untrusted content told it to do. Defaults to refusing to answer: analyzers register their own golden-set
 * responders (Sprint 6).
 */
export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly responder: FakeResponder = () => ({ kind: "error", error: new ProviderError(false, "FAKE_NOT_CONFIGURED") }),
    readonly model = "fake-1",
  ) {}

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const reply = await this.responder(req, this.calls.length);
    const tokensIn = tokens(req.system) + tokens(req.user);
    if (reply.kind === "error") throw reply.error;
    if (reply.kind === "refusal") return { kind: "refusal", category: reply.category ?? null, tokensIn, tokensOut: 0, model: this.model };
    if (reply.kind === "truncated") return { kind: "truncated", tokensIn, tokensOut: req.maxOutputTokens, model: this.model };
    return { kind: "output", json: reply.json, tokensIn, tokensOut: tokens(JSON.stringify(reply.json) ?? ""), model: this.model };
  }
}
