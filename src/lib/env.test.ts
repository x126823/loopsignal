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
    expect(() => parseEnv({ ...valid, NODE_ENV: "production", AUTH_DEV_LOGIN: "true" })).toThrow(/AUTH_DEV_LOGIN/);
    expect(parseEnv({ ...valid, NODE_ENV: "production", AUTH_DEV_LOGIN: "false" }).NODE_ENV).toBe("production");
  });
});
