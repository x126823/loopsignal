import { getEnv } from "@/lib/env";

/**
 * Validates the environment at server start so a misconfigured deployment FAILS TO START, naming the invalid settings (never their
 * values), instead of starting and answering every request with a 500. Throwing is not enough: Next.js logs an error thrown during
 * startup and keeps serving, so the process exits explicitly. Kept apart from instrumentation.ts because it uses Node APIs.
 */
export function validateEnvironmentOrExit(): void {
  try {
    getEnv();
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Invalid environment configuration");
    process.exit(1);
  }
}
