import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_DATABASE_URL: "postgresql://a:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "x".repeat(32),
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("parseEnv", () => {
  it("accepts a valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AUTH_DEV_LOGIN).toBe("false");
    expect([env.LLM_PROVIDER, env.LLM_MODEL, env.LLM_EFFORT, env.LLM_DAILY_TOKEN_BUDGET]).toEqual(["fake", "claude-opus-5-5", "medium", 2_000_000]);
  });

  it("validates LLM settings", () => {
    expect(parseEnv({ ...valid, LLM_PROVIDER: "claude", LLM_DAILY_TOKEN_BUDGET: "500000" }).LLM_DAILY_TOKEN_BUDGET).toBe(500_000);
    expect(() => parseEnv({ ...valid, LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
    expect(() => parseEnv({ ...valid, LLM_DAILY_TOKEN_BUDGET: "-1" })).toThrow(/LLM_DAILY_TOKEN_BUDGET/);
    expect(() => parseEnv({ ...valid, LLM_EFFORT: "max" })).toThrow(/LLM_EFFORT/);
  });

  it("rejects missing variables and names the keys", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL, APP_DATABASE_URL, REDIS_URL, AUTH_SECRET, FIELD_ENCRYPTION_KEY/);
  });

  it("does not leak values in the error message", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "not-a-url-secret" })).not.toThrow(/secret/);
  });

  it("rejects a short AUTH_SECRET", () => {
    expect(() => parseEnv({ ...valid, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
  });

  it("rejects a FIELD_ENCRYPTION_KEY that is not 32 bytes", () => {
    expect(() => parseEnv({ ...valid, FIELD_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it("treats empty optional Google credentials as unset", () => {
    expect(parseEnv({ ...valid, AUTH_GOOGLE_ID: "" }).AUTH_GOOGLE_ID).toBeUndefined();
  });

  it("refuses dev login in production", () => {
    const prod = { ...valid, NODE_ENV: "production", AUTH_URL: "https://app.example.com" };
    expect(() => parseEnv({ ...prod, AUTH_DEV_LOGIN: "true" })).toThrow(/AUTH_DEV_LOGIN/);
    expect(parseEnv({ ...prod, AUTH_DEV_LOGIN: "false" }).NODE_ENV).toBe("production");
  });

  describe("Gmail settings", () => {
    const gmail = { GMAIL_ENABLED: "true", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };

    it("is off by default and needs nothing else", () => {
      const env = parseEnv(valid);
      expect([env.GMAIL_ENABLED, env.GMAIL_BACKFILL_DAYS, env.APP_BASE_URL]).toEqual(["false", 7, "http://localhost:3000"]);
      expect(env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    });

    it("needs the OAuth client when enabled, and names the key without its value", () => {
      expect(parseEnv({ ...valid, ...gmail }).GMAIL_ENABLED).toBe("true");
      expect(() => parseEnv({ ...valid, GMAIL_ENABLED: "true" })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
      expect(() => parseEnv({ ...valid, GMAIL_ENABLED: "true", GOOGLE_OAUTH_CLIENT_ID: "id" })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
      expect(() => parseEnv({ ...valid, ...gmail, GOOGLE_OAUTH_CLIENT_SECRET: "" })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
      expect(() => parseEnv({ ...valid, GMAIL_ENABLED: "yes" })).toThrow(/GMAIL_ENABLED/);
    });

    it("treats empty values from a copied .env.example as unset", () => {
      const env = parseEnv({ ...valid, GOOGLE_OAUTH_CLIENT_ID: "", GMAIL_PUBSUB_TOPIC: "", GMAIL_PUSH_AUDIENCE: "", GMAIL_PUSH_SERVICE_ACCOUNT: "", GOOGLE_TEST_BASE_URL: "" });
      expect([env.GOOGLE_OAUTH_CLIENT_ID, env.GMAIL_PUBSUB_TOPIC, env.GOOGLE_TEST_BASE_URL]).toEqual([undefined, undefined, undefined]);
    });

    it("requires verification settings together with a Pub/Sub topic, so push can never run unauthenticated", () => {
      const topic = "projects/p/topics/t";
      expect(() => parseEnv({ ...valid, ...gmail, GMAIL_PUBSUB_TOPIC: topic })).toThrow(/GMAIL_PUSH_AUDIENCE/);
      expect(() => parseEnv({ ...valid, ...gmail, GMAIL_PUBSUB_TOPIC: topic, GMAIL_PUSH_AUDIENCE: "https://a.test/push" })).toThrow(/GMAIL_PUSH_AUDIENCE/);
      expect(parseEnv({ ...valid, ...gmail, GMAIL_PUBSUB_TOPIC: topic, GMAIL_PUSH_AUDIENCE: "https://a.test/push", GMAIL_PUSH_SERVICE_ACCOUNT: "s@p.iam.gserviceaccount.com" }).GMAIL_PUBSUB_TOPIC).toBe(topic);
      expect(() => parseEnv({ ...valid, ...gmail, GMAIL_PUBSUB_TOPIC: "not-a-topic" })).toThrow(/GMAIL_PUBSUB_TOPIC/);
    });

    it("never allows the Google endpoint override in production, and bounds the backfill window", () => {
      expect(parseEnv({ ...valid, GOOGLE_TEST_BASE_URL: "http://localhost:4010" }).GOOGLE_TEST_BASE_URL).toBe("http://localhost:4010");
      expect(() => parseEnv({ ...valid, NODE_ENV: "production", GOOGLE_TEST_BASE_URL: "http://localhost:4010" })).toThrow(/GOOGLE_TEST_BASE_URL/);
      expect(() => parseEnv({ ...valid, GMAIL_BACKFILL_DAYS: "0" })).toThrow(/GMAIL_BACKFILL_DAYS/);
      expect(() => parseEnv({ ...valid, GMAIL_BACKFILL_DAYS: "365" })).toThrow(/GMAIL_BACKFILL_DAYS/);
    });
  });

  describe("Google Chat settings", () => {
    it("is off by default and needs nothing else", () => {
      const env = parseEnv(valid);
      expect([env.GOOGLE_CHAT_ENABLED, env.GOOGLE_CHAT_BACKFILL_DAYS, env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON]).toEqual(["false", 7, undefined]);
    });

    it("needs the app's key file when enabled, and names the key without its value", () => {
      expect(parseEnv({ ...valid, GOOGLE_CHAT_ENABLED: "true", GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: "{}" }).GOOGLE_CHAT_ENABLED).toBe("true");
      expect(() => parseEnv({ ...valid, GOOGLE_CHAT_ENABLED: "true" })).toThrow(/GOOGLE_CHAT_SERVICE_ACCOUNT_JSON/);
      expect(() => parseEnv({ ...valid, GOOGLE_CHAT_ENABLED: "true", GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: "" })).toThrow(/GOOGLE_CHAT_SERVICE_ACCOUNT_JSON/);
      expect(() => parseEnv({ ...valid, GOOGLE_CHAT_ENABLED: "yes" })).toThrow(/GOOGLE_CHAT_ENABLED/);
    });

    it("bounds the backfill window", () => {
      expect(() => parseEnv({ ...valid, GOOGLE_CHAT_BACKFILL_DAYS: "0" })).toThrow(/GOOGLE_CHAT_BACKFILL_DAYS/);
      expect(() => parseEnv({ ...valid, GOOGLE_CHAT_BACKFILL_DAYS: "365" })).toThrow(/GOOGLE_CHAT_BACKFILL_DAYS/);
      expect(parseEnv({ ...valid, GOOGLE_CHAT_BACKFILL_DAYS: "30" }).GOOGLE_CHAT_BACKFILL_DAYS).toBe(30);
    });
  });

  describe("database pool settings", () => {
    it("default to a pool of 20 and a 10 second wait for a connection", () => {
      const env = parseEnv(valid);
      expect([env.DB_POOL_MAX, env.DB_TX_MAX_WAIT_MS, env.MAINTENANCE_JOBS_ENABLED]).toEqual([20, 10_000, "true"]);
    });

    it("are bounded, so a typo cannot starve the database or fail every request instantly", () => {
      expect(parseEnv({ ...valid, DB_POOL_MAX: "50", DB_TX_MAX_WAIT_MS: "30000" })).toMatchObject({ DB_POOL_MAX: 50, DB_TX_MAX_WAIT_MS: 30_000 });
      for (const bad of [{ DB_POOL_MAX: "1" }, { DB_POOL_MAX: "500" }, { DB_POOL_MAX: "x" }, { DB_TX_MAX_WAIT_MS: "10" }, { DB_TX_MAX_WAIT_MS: "999999" }, { MAINTENANCE_JOBS_ENABLED: "off" }]) {
        expect(() => parseEnv({ ...valid, ...bad }), JSON.stringify(bad)).toThrow(/DB_POOL_MAX|DB_TX_MAX_WAIT_MS|MAINTENANCE_JOBS_ENABLED/);
      }
    });
  });

  describe("AUTH_URL", () => {
    const prod = { ...valid, NODE_ENV: "production" };
    it("is optional in development and treated as unset when empty", () => {
      expect(parseEnv(valid).AUTH_URL).toBeUndefined();
      expect(parseEnv({ ...valid, AUTH_URL: "" }).AUTH_URL).toBeUndefined();
    });

    it("is required in production, pinning the host Auth.js trusts", () => {
      expect(() => parseEnv(prod)).toThrow(/AUTH_URL/);
      expect(() => parseEnv({ ...prod, AUTH_URL: "" })).toThrow(/AUTH_URL/);
      expect(parseEnv({ ...prod, AUTH_URL: "https://app.example.com" }).AUTH_URL).toBe("https://app.example.com");
    });

    it("must be https in production, except for localhost", () => {
      expect(() => parseEnv({ ...prod, AUTH_URL: "http://app.example.com" })).toThrow(/AUTH_URL/);
      expect(() => parseEnv({ ...prod, AUTH_URL: "http://localhost.evil.example" })).toThrow(/AUTH_URL/);
      expect(() => parseEnv({ ...prod, AUTH_URL: "not a url" })).toThrow(/AUTH_URL/);
      expect(parseEnv({ ...prod, AUTH_URL: "http://localhost:3000" }).AUTH_URL).toBe("http://localhost:3000");
    });
  });
});
