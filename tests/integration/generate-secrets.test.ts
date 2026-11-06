import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const dir = mkdtempSync(join(tmpdir(), "loopsignal-secrets-"));
// A broken generator must not leave secrets behind in the repository: check, then clean up either way.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const stray of ["secrets.env", "docs/secrets.env"]) rmSync(stray, { force: true });
});

const run = async (args: string[]) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/generate-secrets.ts", ...args], { encoding: "utf8" });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    return { code: (e as { code: number }).code, out: String((e as { stdout: string }).stdout ?? ""), err: String((e as { stderr: string }).stderr ?? "") };
  }
};
const values = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("ops:generate-secrets", () => {
  it("writes the four secrets to a new file only its owner can read, and prints their names but never their values", async () => {
    const file = join(dir, "first.env");
    const r = await run(["--out", file]);
    expect(r.code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const v = values(file);
    expect(Object.keys(v).sort()).toEqual(["ALERT_WEBHOOK_SECRET", "AUDIT_ANCHOR_KEY", "AUTH_SECRET", "FIELD_ENCRYPTION_KEY"]);
    for (const value of Object.values(v)) expect(r.out + r.err).not.toContain(value);
    expect(JSON.parse(r.out.split("\n")[0]!)).toMatchObject({ event: "secrets.generated", file, names: ["AUTH_SECRET", "FIELD_ENCRYPTION_KEY", "AUDIT_ANCHOR_KEY", "ALERT_WEBHOOK_SECRET"] });
    expect(r.out).toContain("back up FIELD_ENCRYPTION_KEY separately"); // the reminder about the field key
    expect(readFileSync(file, "utf8")).toContain("BACK THIS UP SEPARATELY FROM THE DATABASE");
  }, 60_000);

  it("produces values the application accepts in production, including the published-default checks", async () => {
    const file = join(dir, "valid.env");
    await run(["--out", file]);
    const v = values(file);
    const env = parseEnv({
      NODE_ENV: "production", DATABASE_URL: "postgresql://owner:Zk9-real@db.internal:5432/app", APP_DATABASE_URL: "postgresql://loopsignal_app:Qp3-real@db.internal:5432/app", REDIS_URL: "redis://localhost:6379",
      AUTH_URL: "https://app.example.com", AUTH_SECRET: v["AUTH_SECRET"]!, FIELD_ENCRYPTION_KEY: v["FIELD_ENCRYPTION_KEY"]!, AUDIT_ANCHOR_KEY: v["AUDIT_ANCHOR_KEY"]!, ALERT_WEBHOOK_SECRET: v["ALERT_WEBHOOK_SECRET"]!,
    });
    expect(env.NODE_ENV).toBe("production");
    expect(Buffer.from(v["FIELD_ENCRYPTION_KEY"]!, "base64")).toHaveLength(32);
  }, 60_000);

  it("generates different secrets every time, and never the published development ones", async () => {
    const a = join(dir, "a.env");
    const b = join(dir, "b.env");
    await run(["--out", a]);
    await run(["--out", b]);
    const [va, vb] = [values(a), values(b)];
    for (const k of Object.keys(va)) expect(va[k], k).not.toBe(vb[k]);
    expect(va["FIELD_ENCRYPTION_KEY"]).not.toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
  }, 120_000);

  it("never overwrites an existing file", async () => {
    const file = join(dir, "exists.env");
    writeFileSync(file, "precious");
    const r = await run(["--out", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe("precious");
  }, 60_000);

  it("refuses a path inside the repository (it could be committed), and needs --out", async () => {
    expect((await run(["--out", "secrets.env"])).err).toContain("outside the repository");
    expect((await run(["--out", "./docs/secrets.env"])).code).toBe(1);
    expect(existsSync("secrets.env") || existsSync("docs/secrets.env")).toBe(false); // nothing was written inside the repository
    expect((await run([])).code).toBe(1);
    expect((await run(["--out"])).code).toBe(1);
  }, 120_000);
});
