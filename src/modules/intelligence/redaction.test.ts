import { describe, expect, it } from "vitest";
import { redact } from "./redaction";

describe("redact", () => {
  it("removes private key blocks, JWTs and provider API keys", () => {
    const text = [
      "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\nabc\n-----END RSA PRIVATE KEY-----\nthanks",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "aws AKIAIOSFODNN7EXAMPLE and sk-ant-api03-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const r = redact(text);
    expect(r.text).not.toMatch(/MIIEvQ|dozjgNry|AKIAIOSFODNN7|sk-ant-api03|ghp_abc/);
    expect(r.redactions).toMatchObject({ PRIVATE_KEY: 1, JWT: 1, API_KEY: 3 });
    expect(r.text).toContain("thanks");
  });

  it("removes bearer tokens and keeps the label of password-style assignments", () => {
    const r = redact("Authorization: Bearer abcdef0123456789abcdef and password: hunter2 api_key=abc123def456");
    expect(r.text).not.toMatch(/abcdef0123456789abcdef|hunter2|abc123def456/);
    expect(r.text).toContain("password: [REDACTED:CREDENTIAL]");
    expect(r.text).toContain("api_key=[REDACTED:CREDENTIAL]");
  });

  it("removes Luhn-valid card numbers in common formats, but not other long numbers", () => {
    const r = redact("card 4111 1111 1111 1111, also 4111-1111-1111-1111 and 4111111111111111");
    expect(r.text).not.toMatch(/4111/);
    expect(r.redactions.CARD_NUMBER).toBe(3);
    const keep = redact("order 4111 1111 1111 1112 and ticket 1234567890123");
    expect(keep.text).toBe("order 4111 1111 1111 1112 and ticket 1234567890123"); // fails Luhn: not a card
    expect(keep.redactions).toEqual({});
  });

  it("removes Luhn-valid Canadian SINs and US SSNs", () => {
    const r = redact("SIN 046 454 286 and SSN 123-45-6789");
    expect(r.text).not.toMatch(/046 454 286|123-45-6789/);
    expect(r.redactions).toMatchObject({ SIN: 1, SSN: 1 });
    expect(redact("ref 123 456 780").text).toBe("ref 123 456 780"); // nine digits but not Luhn-valid
  });

  it("leaves ordinary business text alone", () => {
    const ordinary = "Invoice 1042 is due 2026-10-05. Call 1-800-555-0199 or write to support@example.com about order #98765.";
    expect(redact(ordinary)).toEqual({ text: ordinary, redactions: {} });
  });

  it("is idempotent and reports counts, never the values", () => {
    const once = redact("password: hunter2 card 4111 1111 1111 1111");
    expect(redact(once.text).text).toBe(once.text);
    expect(JSON.stringify(once.redactions)).not.toMatch(/hunter2|4111/);
  });
});
