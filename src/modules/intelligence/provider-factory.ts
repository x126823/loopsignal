import { getEnv } from "@/lib/env";
import { ClaudeProvider } from "./claude-provider";
import { FakeProvider } from "./fake-provider";
import type { LLMProvider } from "./types";

/** "fake" is the default and never contacts a model. "claude" is opt-in via LLM_PROVIDER. */
export function createProviderFromEnv(): LLMProvider {
  const env = getEnv();
  return env.LLM_PROVIDER === "claude" ? new ClaudeProvider({ model: env.LLM_MODEL, effort: env.LLM_EFFORT }) : new FakeProvider();
}
