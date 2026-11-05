import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Owner connection: migrations and test cleanup only. */
    DATABASE_URL: z.string().url(),
    /** Runtime connection: non-owner role, RLS always applies. */
    APP_DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    /** Namespaces BullMQ keys in Redis (tests use a unique prefix per run). */
    QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]+$/).default("loopsignal"),
    AUTH_SECRET: z.string().min(32),
    /** "fake" (default) never contacts a model. "claude" uses the Anthropic API; credentials are read by the SDK itself. */
    LLM_PROVIDER: z.enum(["fake", "claude"]).default("fake"),
    LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
    LLM_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
    /** Per-organization cap on LLM tokens (input + output) per UTC day. Overridable in Organization.settings.llm. */
    /** Worker throughput cap for analyze-message jobs (global, per worker process). */
    ANALYZE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
    LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(2_000_000),
    /** Base64 of 32 random bytes. Encrypts message bodies and raw payloads (see src/lib/crypto). */
    FIELD_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64"),
    AUTH_DEV_LOGIN: z.enum(["true", "false"]).default("false"),
    AUTH_GOOGLE_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    AUTH_GOOGLE_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_DEV_LOGIN === "true"), {
    path: ["AUTH_DEV_LOGIN"],
    message: "dev login must be disabled in production",
  });

export type Env = z.infer<typeof schema>;

/** Parse and validate environment variables. Throws a message listing invalid keys (never their values). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
