import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanHistoryLog, scanPaths, scanText } from "./secret-scan";

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

  describe("history", () => {
    const secret = `${j("GOC", "SPX-")}${"a1B2c3D4e5".repeat(3)}`;
    const log = [
      "@@COMMIT 1111111111111111", "diff --git a/src/config.ts b/src/config.ts", "--- a/src/config.ts", "+++ b/src/config.ts", "@@ -0,0 +1,2 @@", `+const secret = "${secret}";`, "+const ok = 1;",
      "@@COMMIT 2222222222222222", "diff --git a/src/config.ts b/src/config.ts", "--- a/src/config.ts", "+++ b/src/config.ts", "@@ -1,2 +0,0 @@", `-const secret = "${secret}";`, "-const ok = 1;",
      "@@COMMIT 3333333333333333", "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", " context only", "+nothing to see here",
    ].join("\n");

    it("finds a secret that was added and later removed, naming the commit and file but not the value", () => {
      const found = scanHistoryLog(log);
      expect(found).toEqual([{ path: "src/config.ts", line: 1, kind: "Google OAuth client secret", commit: "111111111111" }]);
      expect(JSON.stringify(found)).not.toContain("a1B2c3D4e5");
    });

    it("looks only at added lines, so removing a secret is not reported as adding one", () => {
      expect(scanHistoryLog(log).map((f) => f.commit)).toEqual(["111111111111"]); // not 2222: that commit only removed it
    });

    it("finds a key block spread over several added lines, and ignores the documented example keys", () => {
      const key = [j("-----BEGIN ", "PRIVATE KEY-----"), ...body.match(/.{1,60}/g)!, j("-----END ", "PRIVATE KEY-----")].map((l) => `+${l}`).join("\n");
      const l2 = `@@COMMIT abcdefabcdef1234\ndiff --git a/k.txt b/k.txt\n--- /dev/null\n+++ b/k.txt\n@@ -0,0 +1,9 @@\n${key}\n`;
      expect(scanHistoryLog(l2).map((f) => f.kind)).toEqual(["private key"]);
      expect(scanHistoryLog("@@COMMIT 9999999999999999\ndiff --git a/t.ts b/t.ts\n+++ b/t.ts\n+aws AKIAIOSFODNN7EXAMPLE\n")).toEqual([]);
    });

    it("an empty or malformed log yields nothing rather than failing", () => {
      expect(scanHistoryLog("")).toEqual([]);
      expect(scanHistoryLog("not a log at all")).toEqual([]);
    });

    it("the repository's own history contains none (the same check CI runs)", () => {
      const history = execFileSync("git", ["log", "--all", "-p", "-U0", "--no-color", "--format=@@COMMIT %H"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
      expect(scanHistoryLog(history)).toEqual([]);
      const named = execFileSync("git", ["log", "--all", "--name-only", "--format="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
      expect(scanPaths([...new Set(named)])).toEqual([]);
    }, 60_000);
  });
});
