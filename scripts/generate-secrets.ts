// Generate the secrets a deployment needs, into a NEW file only you can read. The values are never printed, so they do not end up in a
// terminal scrollback, a CI log or a chat. Move them into your secret manager, then delete the file. See docs/runbooks/first-deployment.md.
//   npm run ops:generate-secrets -- --out <path OUTSIDE this repository>
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";

const i = process.argv.indexOf("--out");
const target = i >= 0 ? process.argv[i + 1] : undefined;
if (!target) {
  console.error("Usage: --out <path of a new file, outside this repository>");
  process.exit(1);
}
const rel = relative(process.cwd(), resolve(target));
if (!rel.startsWith("..") && !rel.startsWith("/")) {
  console.error("Choose a path outside the repository: a file inside it could be committed by accident.");
  process.exit(1);
}

const secrets: Array<[name: string, value: string, note: string]> = [
  ["AUTH_SECRET", randomBytes(32).toString("base64"), "signs sessions. Rotating it signs everyone out"],
  ["FIELD_ENCRYPTION_KEY", randomBytes(32).toString("base64"), "encrypts message content, tokens and claim codes. BACK THIS UP SEPARATELY FROM THE DATABASE: without it, stored content cannot be read"],
  ["AUDIT_ANCHOR_KEY", randomBytes(32).toString("hex"), "signs audit anchors. Keep it APART from the database"],
  ["ALERT_WEBHOOK_SECRET", randomBytes(24).toString("hex"), "signs alerts so the receiver can verify them. Configure the same value on the receiver"],
];
const body = [
  `# Generated ${new Date().toISOString()}. Move these into your secret manager, then DELETE this file. Never commit it or paste it anywhere.`,
  ...secrets.flatMap(([name, value, note]) => [`# ${note}`, `${name}=${value}`]),
  "",
].join("\n");

try {
  const fd = openSync(target, "wx", 0o600); // fails if the path exists; readable by the current user only
  try { writeSync(fd, body); } finally { closeSync(fd); }
} catch (e) {
  console.error(`Could not create ${target}: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "it already exists (nothing was overwritten)" : (e as Error).message}`);
  process.exit(1);
}
console.log(JSON.stringify({ event: "secrets.generated", file: target, names: secrets.map(([n]) => n) }));
console.log("The values are in that file only. Store them, back up FIELD_ENCRYPTION_KEY separately from the database, then delete the file.");
