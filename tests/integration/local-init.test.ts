import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { redisConnection } from "@/lib/queue";

const root = mkdtempSync(join(tmpdir(), "loopsignal-local-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const s of ["local-env", "docs/local-env"]) rmSync(s, { recursive: true, force: true }); });

const run = async (args: string[]) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/local-init.ts", ...args], { encoding: "utf8" });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    return { code: (e as { code: number }).code, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
  }
};
const parse = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("npm run local:init", () => {
  it("writes one env file in a private folder, readable only by you, and prints names and ports but never a value", async () => {
    const dir = join(root, "a");
    const r = await run(["--dir", dir]);
    expect(r.code).toBe(0);
    const file = join(dir, "real.env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const v = parse(file);
    const secretNames = ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "REDIS_PASSWORD", "AUTH_SECRET", "FIELD_ENCRYPTION_KEY", "AUDIT_ANCHOR_KEY", "ALERT_WEBHOOK_SECRET"];
    for (const n of secretNames) {
      expect(v[n]!.length, n).toBeGreaterThanOrEqual(16);
      expect(r.out + r.err, n).not.toContain(v[n]!);
    }
    expect(r.out).not.toMatch(/postgresql:\/\/|redis:\/\//); // not even the connection strings, which contain passwords
    expect(JSON.parse(r.out.split("\n")[0]!)).toMatchObject({ event: "local.init", file, ports: { postgres: 5433, redis: 6380, app: 3000 } });
  }, 60_000);

  it("produces a configuration the application accepts in production once the Google values are filled in, and not before", async () => {
    const dir = join(root, "b");
    await run(["--dir", dir]);
    const v = parse(join(dir, "real.env"));
    const withGoogle = { ...v, AUTH_GOOGLE_ID: "client-id.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "client-secret", GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret" };
    const env = parseEnv({ ...withGoogle, NODE_ENV: "production" });
    expect(env).toMatchObject({ NODE_ENV: "production", AUTH_DEV_LOGIN: "false", GMAIL_ENABLED: "true", GOOGLE_CHAT_ENABLED: "false", LLM_PROVIDER: "fake", AUTH_URL: "http://localhost:3000" });
    expect(Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64")).toHaveLength(32);
    // Gmail is on, so production will not start until the client is filled in: a missing value fails loudly rather than half-working.
    expect(() => parseEnv({ ...v, NODE_ENV: "production" })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  }, 60_000);

  it("writes working connection strings for the local ports, with the owner and the application as different roles", async () => {
    const dir = join(root, "c");
    await run(["--dir", dir, "--pg-port", "5544", "--redis-port", "6391", "--app-port", "3055"]);
    const v = parse(join(dir, "real.env"));
    const owner = new URL(v["DATABASE_URL"]!);
    const app = new URL(v["APP_DATABASE_URL"]!);
    expect([owner.hostname, owner.port, app.hostname, app.port]).toEqual(["127.0.0.1", "5544", "127.0.0.1", "5544"]);
    expect(owner.username).toBe("loopsignal_owner");
    expect(app.username).toBe("loopsignal_app");
    expect(decodeURIComponent(owner.password)).toBe(v["POSTGRES_PASSWORD"]);
    expect(decodeURIComponent(app.password)).toBe(v["APP_DB_PASSWORD"]);
    expect(owner.password).not.toBe(app.password);
    expect(redisConnection(v["REDIS_URL"]!)).toMatchObject({ host: "127.0.0.1", port: 6391, password: v["REDIS_PASSWORD"] });
    expect(v["AUTH_URL"]).toBe("http://localhost:3055");
    expect(v["REAL_PG_PORT"]).toBe("5544");
  }, 60_000);

  it("never uses a published development value, and every run is different", async () => {
    const [a, b] = [join(root, "d"), join(root, "e")];
    await run(["--dir", a]);
    await run(["--dir", b]);
    const [va, vb] = [parse(join(a, "real.env")), parse(join(b, "real.env"))];
    for (const n of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "REDIS_PASSWORD", "AUTH_SECRET", "FIELD_ENCRYPTION_KEY", "AUDIT_ANCHOR_KEY"]) expect(va[n], n).not.toBe(vb[n]);
    const text = readFileSync(join(a, "real.env"), "utf8");
    expect(text).not.toContain("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    expect(text).not.toMatch(/dev-only-secret|ci-only-secret|:loopsignal@|:loopsignal_app@/);
  }, 120_000);

  it("never overwrites an existing file: its keys protect existing data", async () => {
    const dir = join(root, "f");
    await run(["--dir", dir]);
    const before = readFileSync(join(dir, "real.env"), "utf8");
    const again = await run(["--dir", dir]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
    expect(readFileSync(join(dir, "real.env"), "utf8")).toBe(before);
  }, 120_000);

  it("refuses a folder inside the repository, and a nonsense port, and leaves nothing behind", async () => {
    expect((await run(["--dir", "local-env"])).err).toContain("outside the repository");
    expect((await run(["--dir", "./docs/local-env"])).code).toBe(1);
    expect((await run(["--dir", join(root, "g"), "--pg-port", "80"])).err).toContain("--pg-port");
    expect((await run(["--dir", join(root, "g"), "--redis-port", "abc"])).code).toBe(1);
    expect((await run(["--dir", join(root, "g"), "--app-port", "99999"])).code).toBe(1);
    expect(() => statSync("local-env")).toThrow();
    expect(() => statSync("docs/local-env")).toThrow();
  }, 180_000);
});
