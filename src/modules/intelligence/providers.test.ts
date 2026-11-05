import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeProvider, type ClaudeClientLike } from "./claude-provider";
import { FakeProvider } from "./fake-provider";
import { ProviderError, type ProviderRequest } from "./types";

const req: ProviderRequest = {
  analyzer: "a", promptVersion: "v1", system: "SYSTEM RULES", user: "UNTRUSTED CONTENT", schema: z.object({ ok: z.boolean() }), maxOutputTokens: 1234,
};
const msg = (over: Partial<Anthropic.Message>): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: '{"ok":true}', citations: null }],
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
} as Anthropic.Message);

function stub(reply: (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>) {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClientLike = { messages: { create: async (p) => { seen.push(p); return reply(p); } } };
  return { client, seen };
}

describe("ClaudeProvider request shape", () => {
  it("sends structured outputs only: one user message, system prompt separate, and no tools, prefill, forced choice or sampling", async () => {
    const { client, seen } = stub(() => msg({}));
    await new ClaudeProvider({ model: "claude-opus-5-5", effort: "medium", client }).complete(req);
    const p = seen[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(1234);
    expect(p.system).toBe("SYSTEM RULES");
    expect(p.messages).toEqual([{ role: "user", content: "UNTRUSTED CONTENT" }]); // content only in the user turn, no assistant prefill
    expect(p.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    for (const forbidden of ["tools", "tool_choice", "temperature", "top_p", "top_k", "thinking", "stream"]) expect(p, forbidden).not.toHaveProperty(forbidden);
  });
});

describe("ClaudeProvider responses", () => {
  const run = (m: Anthropic.Message) => new ClaudeProvider({ model: "claude-opus-5-5", effort: "low", client: stub(() => m).client }).complete(req);

  it("parses the JSON text and totals usage including cache tokens", async () => {
    const r = await run(msg({ usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 5 } as Anthropic.Usage }));
    expect(r).toEqual({ kind: "output", json: { ok: true }, tokensIn: 135, tokensOut: 20, model: "claude-opus-5-5" });
  });
  it("reports a refusal with its category, and never treats it as output", async () => {
    const r = await run(msg({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" }, content: [] } as unknown as Anthropic.Message));
    expect(r).toMatchObject({ kind: "refusal", category: "cyber" });
  });
  it("reports truncation when the output hit the token limit", async () => {
    expect(await run(msg({ stop_reason: "max_tokens" }))).toMatchObject({ kind: "truncated" });
  });
  it("returns undefined JSON, for the pipeline to reject, when the text is not JSON or missing", async () => {
    expect(await run(msg({ content: [{ type: "text", text: "Sure! Here you go: {oops", citations: null }] }))).toMatchObject({ kind: "output", json: undefined });
    expect(await run(msg({ content: [] }))).toMatchObject({ kind: "output", json: undefined });
  });
});

describe("ClaudeProvider errors", () => {
  const fail = (err: unknown) => new ClaudeProvider({ model: "m", effort: "low", client: stub(() => { throw err; }).client }).complete(req).catch((e: unknown) => e);
  const api = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "SECRET-BODY-TEXT echoed" } }, "SECRET-BODY-TEXT echoed", new Headers());

  it("marks rate limits, connection problems and 5xx as retryable, and auth and bad requests as permanent", async () => {
    expect(await fail(api(429))).toMatchObject({ retryable: true, code: "RATE_LIMITED" });
    expect(await fail(api(500))).toMatchObject({ retryable: true, code: "HTTP_500" });
    expect(await fail(api(529))).toMatchObject({ retryable: true });
    expect(await fail(new Anthropic.APIConnectionError({ message: "offline" }))).toMatchObject({ retryable: true, code: "CONNECTION" });
    expect(await fail(api(401))).toMatchObject({ retryable: false, code: "AUTH" });
    expect(await fail(api(403))).toMatchObject({ retryable: false, code: "AUTH" });
    expect(await fail(api(400))).toMatchObject({ retryable: false, code: "BAD_REQUEST" });
    expect(await fail(api(404))).toMatchObject({ retryable: false, code: "BAD_REQUEST" });
  });
  it("never carries the SDK error text, which can echo request content (rule 10)", async () => {
    const e = (await fail(api(400))) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(JSON.stringify([e.message, e.code, e.stack?.split("\n")[0]])).not.toContain("SECRET-BODY-TEXT");
  });
  it("treats an unknown failure as retryable", async () => {
    expect(await fail(new Error("weird"))).toMatchObject({ retryable: true, code: "UNKNOWN" });
  });
});

describe("FakeProvider", () => {
  it("records every request and is deterministic", async () => {
    const f = new FakeProvider(() => ({ kind: "output", json: { ok: true } }));
    const a = await f.complete(req);
    const b = await f.complete(req);
    expect(f.calls).toHaveLength(2);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: "output", json: { ok: true }, model: "fake-1" });
  });
  it("can script refusals, truncation and errors", async () => {
    expect(await new FakeProvider(() => ({ kind: "refusal", category: "bio" })).complete(req)).toMatchObject({ kind: "refusal", category: "bio" });
    expect(await new FakeProvider(() => ({ kind: "truncated" })).complete(req)).toMatchObject({ kind: "truncated", tokensOut: 1234 });
    await expect(new FakeProvider(() => ({ kind: "error", error: new ProviderError(true, "X") })).complete(req)).rejects.toMatchObject({ retryable: true, code: "X" });
  });
  it("does not answer until configured", async () => {
    await expect(new FakeProvider().complete(req)).rejects.toMatchObject({ code: "FAKE_NOT_CONFIGURED", retryable: false });
  });
});
