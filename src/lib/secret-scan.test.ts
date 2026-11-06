import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanPaths, scanText } from "./secret-scan";

// The "secrets" below are assembled at run time so that this file itself contains none of them.
const j = (...p: string[]) => p.join("");
const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7".repeat(3);

describe("secret scanner", () => {
  it.each([
    ["private key", `${j("-----BEGIN ", "PRIVATE KEY-----")}\n${body}\n${j("-----END ", "PRIVATE KEY-----")}`],
    ["Google OAuth client secret", `client_secret = ${j("GOC", "SPX-")}${"a1B2c3D4e5".repeat(3)}`],
    ["Google API key", `key=${j("AI", "za")}${"Sy0123456789abcdefghijklmnopqrstuvw".slice(0, 35)}`],
    ["Google access token", `Bearer ${j("ya", "29.")}${"a0Af_B-cd".repeat(5)}`],
    ["Google refresh token", `${j("1/", "/0")}${"gAbC_dEf-12".repeat(5)}`],
    ["Anthropic API key", `ANTHROPIC_API_KEY=${j("sk-", "ant-")}api03-${"xY12".repeat(10)}`],
    ["AWS access key id", `${j("AK", "IA")}ABCDEFGHIJKLMNOP`],
    ["GitHub token", `${j("gh", "p_")}${"aB3dE6gH9j".repeat(4)}`],
    ["Slack token", `${j("xo", "xb-")}${"1234567890-abcdefgh".repeat(2)}`],
    ["service account key file", `{"private_key": "${j("-----BEGIN ", "PRIVATE KEY-----")}\\n${body.replace(/\n/g, "")}\\n"}`],
  ])("finds a %s, reporting where and what but never the value", (kind, text) => {
    const found = scanText("a/b.ts", `line one\n${text}\n`);
    expect(found.map((f) => f.kind)).toContain(kind);
    expect(found.find((f) => f.kind === kind)).toEqual({ path: "a/b.ts", line: 2, kind });
    expect(JSON.stringify(found)).not.toContain(body.slice(0, 20));
  });

  it("does not flag ordinary text, placeholders or the shapes themselves described in prose", () => {
    for (const text of [
      "FIELD_ENCRYPTION_KEY=\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\"", "GOOGLE_OAUTH_CLIENT_SECRET=\"\"", "AUTH_SECRET=\"dev-only-secret-change-me-0123456789abcdef\"",
      "the key file has client_email and private_key", "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", "sk-short", "/(AKIA)[0-9A-Z]{16}/", "a ghp_ token", "Bearer abc",
    ]) expect(scanText("x", text), text).toEqual([]);
  });

  it("accepts the documented example keys used to test the redactor, but not a real-looking key beside them", () => {
    expect(scanText("redaction.test.ts", "aws AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual([]);
    expect(scanText("x.ts", `aws AKIAIOSFODNN7EXAMPLE but also ${j("AK", "IA")}REALKEYREALKEY12`).map((f) => f.kind)).toEqual(["AWS access key id"]);
  });

  it("flags files that must never be committed, but not the example env file", () => {
    expect(scanPaths([".env", "apps/x/.env.local", "keys/server.pem", "id_rsa", "config/service-account-prod.json", ".env.example", "src/env.ts", "README.md"]).map((f) => f.path))
      .toEqual([".env", "apps/x/.env.local", "keys/server.pem", "id_rsa", "config/service-account-prod.json"]);
  });

  it("the repository itself contains none (the same check CI runs)", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    expect(scanPaths(files)).toEqual([]);
    const hits = files.filter((p) => !/\.(png|jpg|ico|woff2?|lock)$/.test(p) && p !== "package-lock.json").flatMap((p) => {
      try { return scanText(p, readFileSync(p, "utf8")); } catch { return []; }
    });
    expect(hits).toEqual([]);
  });
});
