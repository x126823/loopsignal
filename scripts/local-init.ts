// Create the configuration for running LoopSignal with REAL data on this machine (docs/runbooks/local-mac.md): one env file, in a private folder
// outside the repository, with fresh random passwords and keys. The values are never printed, so they stay out of terminal scrollback and chat.
//   npm run local:init [-- --dir <folder, default ~/.loopsignal>] [--pg-port 5433] [--redis-port 6380] [--app-port 3000]
// You then open the file in an editor and fill in the Google client (the only values it cannot generate).
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const port = (name: string, fallback: string): number => {
  const n = Number(arg(name, fallback));
  if (!Number.isInteger(n) || n < 1024 || n > 65535) { console.error(`--${name} must be a port between 1024 and 65535`); process.exit(1); }
  return n;
};
const dir = resolve(arg("dir", join(homedir(), ".loopsignal")));
const [pgPort, redisPort, appPort] = [port("pg-port", "5433"), port("redis-port", "6380"), port("app-port", "3000")];

const inRepo = !relative(process.cwd(), dir).startsWith("..") && !relative(process.cwd(), dir).startsWith("/");
if (inRepo) { console.error("Choose a folder outside the repository: it could be committed by accident."); process.exit(1); }
const file = join(dir, "real.env");
if (existsSync(file)) { console.error(`${file} already exists, so nothing was changed. (Delete it only if you mean to start over: its keys protect existing data.)`); process.exit(1); }

const token = (bytes: number) => randomBytes(bytes).toString("base64url"); // URL-safe: it goes straight into connection strings
const [ownerPw, appPw, redisPw] = [token(24), token(24), token(24)];
const names: string[] = [];
const line = (name: string, value: string, note?: string) => { names.push(name); return `${note ? `# ${note}\n` : ""}${name}=${value}`; };

const body = [
  `# LoopSignal, real-data configuration. Generated ${new Date().toISOString()}. Readable by you only. NEVER commit it, paste it anywhere, or share it.`,
  "# Fill in the four Google values below with a text editor (not by typing them into a terminal), then follow docs/runbooks/local-mac.md.",
  "",
  "# ---- the local database and queue (docker-compose.real.yml)",
  line("POSTGRES_USER", "loopsignal_owner"), line("POSTGRES_PASSWORD", ownerPw), line("APP_DB_PASSWORD", appPw), line("REDIS_PASSWORD", redisPw),
  line("REAL_PG_PORT", String(pgPort)), line("REAL_REDIS_PORT", String(redisPort)),
  "",
  "# ---- the application",
  line("DATABASE_URL", `postgresql://loopsignal_owner:${ownerPw}@127.0.0.1:${pgPort}/loopsignal?schema=public`, "the owner: used only to migrate and by operator tools"),
  line("APP_DATABASE_URL", `postgresql://loopsignal_app:${appPw}@127.0.0.1:${pgPort}/loopsignal?schema=public`, "what the running application uses"),
  line("REDIS_URL", `redis://:${redisPw}@127.0.0.1:${redisPort}`), line("QUEUE_PREFIX", "loopsignal-real"),
  line("AUTH_URL", `http://localhost:${appPort}`, "where you open the app"), line("AUTH_DEV_LOGIN", "false", "dev login is for synthetic data only and is refused in production"),
  line("AUTH_SECRET", token(32), "signs sessions"),
  line("FIELD_ENCRYPTION_KEY", randomBytes(32).toString("base64"), "encrypts message content and tokens. BACK THIS UP SEPARATELY FROM THE DATABASE: without it, stored content cannot be read"),
  line("SESSION_HOURS", "12"), line("LLM_PROVIDER", "fake", "'fake' = offline keyword rules, nothing is sent to a language model"),
  "",
  "# ---- Google (YOU fill these in; see docs/runbooks/local-mac.md)",
  line("AUTH_GOOGLE_ID", "", "the OAuth client id, used to sign in to LoopSignal"), line("AUTH_GOOGLE_SECRET", "", "its secret"),
  line("GMAIL_ENABLED", "true"),
  line("GOOGLE_OAUTH_CLIENT_ID", "", "the same client id, used to read your Gmail"), line("GOOGLE_OAUTH_CLIENT_SECRET", "", "the same secret"),
  line("GOOGLE_CHAT_ENABLED", "false"),
  "",
  "# ---- integrity and alerting",
  line("AUDIT_ANCHOR_KEY", randomBytes(32).toString("hex"), "signs audit anchors; keep it apart from the database if you can"),
  line("AUDIT_ANCHOR_FILE", join(dir, "anchors.jsonl"), "anchors are appended here (better: a folder on a separate, encrypted drive)"),
  line("ALERT_WEBHOOK_URL", "", "optional: a URL that pages you (see docs/runbooks/alerting.md)"), line("ALERT_WEBHOOK_SECRET", token(24)),
  "",
].join("\n");

mkdirSync(dir, { recursive: true, mode: 0o700 });
const fd = openSync(file, "wx", 0o600); // fails if it exists; readable by you only
try { writeSync(fd, body); } finally { closeSync(fd); }
console.log(JSON.stringify({ event: "local.init", file, names, ports: { postgres: pgPort, redis: redisPort, app: appPort } }));
console.log(`Next: open ${file} in a text editor and fill in the four Google values, then follow docs/runbooks/local-mac.md. Back up FIELD_ENCRYPTION_KEY separately from the database.`);
