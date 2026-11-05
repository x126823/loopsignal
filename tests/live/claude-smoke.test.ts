import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeProvider } from "@/modules/intelligence";

/**
 * OPT-IN live smoke test against the real Anthropic API. Skipped unless LIVE_LLM=1, so CI and `npm test` never contact
 * a model or spend money. Synthetic text only (CLAUDE.md rule 7). It checks that a real call works end to end through
 * our provider (structured output parses, usage is reported); it makes no assertion about the model's judgment.
 *
 *   LIVE_LLM=1 ANTHROPIC_API_KEY=... npx vitest run tests/live
 *
 * Credentials are read by the SDK itself; this repository never stores or validates them.
 */
describe.skipIf(process.env["LIVE_LLM"] !== "1")("ClaudeProvider (live)", () => {
  it("returns schema-valid structured output and reports usage", async () => {
    const provider = new ClaudeProvider({ model: process.env["LLM_MODEL"] ?? "claude-opus-5-5", effort: "low" });
    const schema = z.object({ isGreeting: z.boolean() });
    const res = await provider.complete({
      analyzer: "live_smoke", promptVersion: "v1", system: "Answer with JSON only. Say whether the text is a greeting.",
      user: "<untrusted>Hello there, synthetic friend!</untrusted>", schema, maxOutputTokens: 2048,
    });
    expect(res.kind).toBe("output");
    if (res.kind !== "output") return;
    expect(schema.safeParse(res.json).success).toBe(true);
    expect(res.tokensIn).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
  }, 120_000);
});
