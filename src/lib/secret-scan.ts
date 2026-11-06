/**
 * A small secret scanner for the repository (SECURITY.md: "secret scanning in CI"). No dependency: it looks for the shapes of the
 * credentials this project could plausibly leak (Google, Anthropic, cloud and source-host tokens, private keys). It is pure so it can be
 * tested; scripts/secret-scan.ts runs it over the files git tracks. A finding names the file, line and kind, never the value.
 */
export interface Finding { path: string; line: number; kind: string }

const RULES: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\\n\s]{100,}/ },
  { kind: "Google OAuth client secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Google access token", pattern: /\bya29\.[0-9A-Za-z_-]{30,}/ },
  { kind: "Google refresh token", pattern: /\b1\/\/0[0-9A-Za-z_-]{40,}/ },
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { kind: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { kind: "service account key file", pattern: /"private_key"\s*:\s*"-----BEGIN [A-Z ]*PRIVATE KEY-----\\n[A-Za-z0-9+/=\\]{100,}/ },
];

/**
 * Documented example credentials that appear in tests of the log redactor (AWS's own published example key, and obvious alphabets). A match
 * counts as a finding unless it contains one of these exact literals, so a real key pasted next to them is still caught.
 */
const KNOWN_FAKES = ["AKIAIOSFODNN7EXAMPLE", "sk-ant-api03-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "MIIEvQIBADANBgkq\nabc\n"];

/** Paths that must never be committed, whatever they contain. */
export const FORBIDDEN_PATHS: RegExp[] = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.pem$/, /\.p12$/, /(^|\/)id_rsa$/, /service-account.*\.json$/i];

export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    for (const m of text.matchAll(new RegExp(rule.pattern.source, flags))) {
      if (KNOWN_FAKES.some((fake) => m[0].includes(fake))) continue;
      findings.push({ path, line: text.slice(0, m.index ?? 0).split("\n").length, kind: rule.kind });
    }
  }
  return findings;
}

export function scanPaths(paths: string[]): Finding[] {
  return paths.filter((p) => FORBIDDEN_PATHS.some((re) => re.test(p))).map((path) => ({ path, line: 0, kind: "file that must not be committed" }));
}
