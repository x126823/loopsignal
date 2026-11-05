/**
 * Redaction pass applied to message text BEFORE it is sent to any provider (SECURITY.md data minimization).
 * It removes obvious secrets and sensitive identifiers; it is a safety net, not a guarantee. Evidence quotes are
 * checked against the ORIGINAL text, so a quote that spans a redaction is rejected rather than trusted.
 */
export type RedactionKind = "PRIVATE_KEY" | "JWT" | "API_KEY" | "BEARER_TOKEN" | "CREDENTIAL" | "CARD_NUMBER" | "SIN" | "SSN";

export interface RedactionResult {
  text: string;
  /** Count per kind. Never the redacted values themselves. */
  redactions: Partial<Record<RedactionKind, number>>;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const placeholder = (k: RedactionKind) => `[REDACTED:${k}]`;

export function redact(input: string): RedactionResult {
  const redactions: RedactionResult["redactions"] = {};
  const bump = (k: RedactionKind) => { redactions[k] = (redactions[k] ?? 0) + 1; };
  const apply = (text: string, re: RegExp, kind: RedactionKind, replace?: (m: string, ...g: string[]) => string, guard?: (m: string) => boolean) =>
    text.replace(re, (m: string, ...g: string[]) => {
      if (guard && !guard(m)) return m;
      bump(kind);
      return replace ? replace(m, ...g) : placeholder(kind);
    });

  let t = input;
  t = apply(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE_KEY");
  t = apply(t, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "JWT");
  t = apply(t, /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, "API_KEY");
  t = apply(t, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "BEARER_TOKEN");
  // "password: hunter2", "api_key=abc": keep the label, drop the value.
  t = apply(t, /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(\s*[:=]\s*)(?!\[REDACTED)\S+/gi, "CREDENTIAL", (_m, label = "", sep = "") => `${label}${sep}${placeholder("CREDENTIAL")}`);
  t = apply(t, /\b\d{3}-\d{2}-\d{4}\b/g, "SSN");
  // Canadian SIN: nine digits, Luhn-valid, in 3-3-3 groups.
  t = apply(t, /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g, "SIN", undefined, (m) => luhn(m.replace(/\D/g, "")));
  // Payment card numbers: 13 to 19 digits, optional spaces or dashes, Luhn-valid.
  t = apply(t, /\b(?:\d[ -]?){12,18}\d\b/g, "CARD_NUMBER", undefined, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d);
  });
  return { text: t, redactions };
}
