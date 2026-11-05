import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("accepts a valid environment and defaults NODE_ENV", () => {
    expect(parseEnv(valid).NODE_ENV).toBe("development");
  });

  it("rejects missing variables and names the keys", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL, REDIS_URL/);
  });

  it("does not leak values in the error message", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "not-a-url-secret" })).not.toThrow(/secret/);
  });
});
