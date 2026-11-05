import { getEnv } from "@/lib/env";
import { ClaudeProvider } from "./claude-provider";
import { HeuristicProvider } from "./heuristic-provider";
import type { LLMProvider } from "./types";

/** "fake" is the default: a rule-based heuristic that never contacts a model. "claude" is opt-in via LLM_PROVIDER. */
export function createProviderFromEnv(): LLMProvider {
  const env = getEnv();
  return env.LLM_PROVIDER === "claude" ? new ClaudeProvider({ model: env.LLM_MODEL, effort: env.LLM_EFFORT }) : new HeuristicProvider();
}
