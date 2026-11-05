import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_DATABASE_URL: "postgresql://a:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "x".repeat(32),
};

describe("parseEnv", () => {
  it("accepts a valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AUTH_DEV_LOGIN).toBe("false");
  });

  it("rejects missing variables and names the keys", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL, APP_DATABASE_URL, REDIS_URL, AUTH_SECRET/);
  });

  it("does not leak values in the error message", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "not-a-url-secret" })).not.toThrow(/secret/);
  });

  it("rejects a short AUTH_SECRET", () => {
    expect(() => parseEnv({ ...valid, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
  });

  it("treats empty optional Google credentials as unset", () => {
    expect(parseEnv({ ...valid, AUTH_GOOGLE_ID: "" }).AUTH_GOOGLE_ID).toBeUndefined();
  });

  it("refuses dev login in production", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production", AUTH_DEV_LOGIN: "true" })).toThrow(/AUTH_DEV_LOGIN/);
    expect(parseEnv({ ...valid, NODE_ENV: "production", AUTH_DEV_LOGIN: "false" }).NODE_ENV).toBe("production");
  });
});
