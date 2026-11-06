// Scan the files git tracks for credentials. Exits 1 and prints file:line and the kind (never the value) on a finding. Used by CI.
//   npm run scan:secrets
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanPaths, scanText, type Finding } from "../src/lib/secret-scan";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
const findings: Finding[] = scanPaths(files);
for (const path of files) {
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip|lock)$/i.test(path) || path === "package-lock.json") continue;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { continue; }
  findings.push(...scanText(path, text));
}
for (const f of findings) console.error(`${f.path}:${f.line}  ${f.kind}`);
console.log(JSON.stringify({ event: "secret-scan.done", files: files.length, findings: findings.length }));
process.exit(findings.length > 0 ? 1 : 0);
