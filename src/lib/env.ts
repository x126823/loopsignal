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

    /** Gmail integration. OFF by default; nothing contacts Google, and no Gmail route, job or schedule exists, while it is off. */
    GMAIL_ENABLED: z.enum(["true", "false"]).default("false"),
    /** The OAuth client of the Google Cloud project. Never logged; required when GMAIL_ENABLED=true. */
    GOOGLE_OAUTH_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Public origin of this app, used to build the OAuth redirect URI (<origin>/api/gmail/callback). */
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    /** Pub/Sub topic that Gmail publishes mailbox changes to (projects/<p>/topics/<t>). Unset: polling only, no watch. */
    GMAIL_PUBSUB_TOPIC: z.preprocess(emptyToUndefined, z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/).optional()),
    /** What the push endpoint requires of Pub/Sub's signed token: audience, and the service account that signs it. */
    GMAIL_PUSH_AUDIENCE: z.preprocess(emptyToUndefined, z.string().optional()),
    GMAIL_PUSH_SERVICE_ACCOUNT: z.preprocess(emptyToUndefined, z.string().email().optional()),
    /** How far back the first sync (and a resync after a history gap) reads. */
    GMAIL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Google Chat integration. OFF by default; with it off no Chat route, scan or adapter does anything. */
    GOOGLE_CHAT_ENABLED: z.enum(["true", "false"]).default("false"),
    /**
     * The key file (JSON) of the ONE service account that is the product's Chat app. It acts as the app, never as a person, and is a
     * product-wide secret (not per customer). Never logged; validated when first used so a bad value never echoes into an error.
     */
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: z.preprocess(emptyToUndefined, z.string().optional()),
    /** How far back the first read of a newly bound space goes. */
    GOOGLE_CHAT_BACKFILL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** TESTS ONLY: point every Google endpoint (auth, token, revoke, Gmail API, signing keys) at a fake server. Refused in production. */
    GOOGLE_TEST_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_DEV_LOGIN === "true"), {
    path: ["AUTH_DEV_LOGIN"],
    message: "dev login must be disabled in production",
  })
  .refine((e) => !(e.GMAIL_ENABLED === "true" && (!e.GOOGLE_OAUTH_CLIENT_ID || !e.GOOGLE_OAUTH_CLIENT_SECRET)), {
    path: ["GOOGLE_OAUTH_CLIENT_ID"],
    message: "Gmail needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET",
  })
  .refine((e) => !(e.GOOGLE_CHAT_ENABLED === "true" && !e.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON), {
    path: ["GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"],
    message: "Google Chat needs GOOGLE_CHAT_SERVICE_ACCOUNT_JSON",
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.GOOGLE_TEST_BASE_URL), {
    path: ["GOOGLE_TEST_BASE_URL"],
    message: "the Google test endpoint override is not allowed in production",
  })
  .refine((e) => !(e.GMAIL_PUBSUB_TOPIC && (!e.GMAIL_PUSH_AUDIENCE || !e.GMAIL_PUSH_SERVICE_ACCOUNT)), {
    path: ["GMAIL_PUSH_AUDIENCE"],
    message: "a Pub/Sub topic needs GMAIL_PUSH_AUDIENCE and GMAIL_PUSH_SERVICE_ACCOUNT, so push requests can be verified",
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
