// Back up the real-data database to a NEW file (dump format), readable by you only. Put it on a separate, encrypted drive. It holds message
// ciphertext and metadata, and is useless without FIELD_ENCRYPTION_KEY, which you must back up SEPARATELY. See docs/runbooks/local-mac.md.
//   npm run real:backup -- --out /Volumes/YourDrive/loopsignal-2026-11-07.dump
import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (!out) { console.error("Usage: --out <path of a new file>"); process.exit(1); }
const rel = relative(process.cwd(), resolve(out));
if (!rel.startsWith("..") && !rel.startsWith("/")) { console.error("Choose a path outside the repository."); process.exit(1); }
const { POSTGRES_USER, POSTGRES_PASSWORD } = process.env;
if (!POSTGRES_USER || !POSTGRES_PASSWORD) { console.error("Run this through npm run real:backup, which loads your env file."); process.exit(1); }

let fd: number;
try { fd = openSync(out, "wx", 0o600); } catch { console.error(`Could not create ${out} (it may already exist; nothing was overwritten).`); process.exit(1); }
const child = spawn("docker", ["compose", "-f", "docker-compose.real.yml", "exec", "-T", "-e", `PGPASSWORD=${POSTGRES_PASSWORD}`, "postgres", "pg_dump", "-U", POSTGRES_USER, "-Fc", "loopsignal"], { stdio: ["ignore", fd, "pipe"], env: process.env });
let err = "";
child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
child.on("close", (code) => {
  closeSync(fd);
  const bytes = statSync(out).size;
  if (code !== 0 || bytes < 1_000) {
    rmSync(out, { force: true });
    console.error(`The backup failed${err ? `: ${err.trim().split("\n").slice(-2).join(" | ")}` : ""}. The partial file was removed.`);
    process.exit(1);
  }
  console.log(JSON.stringify({ event: "backup.done", file: out, bytes }));
  console.log("Keep FIELD_ENCRYPTION_KEY backed up separately: this file cannot be read without it. Test a restore (npm run real:drill).");
});
