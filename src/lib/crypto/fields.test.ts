import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptField, encryptField, parseFieldKey } from "./fields";

const key = randomBytes(32);
const aad = "org-1:Message.bodyText";

describe("field encryption", () => {
  it("round-trips unicode text", () => {
    const text = "Hello — 你好 🌍";
    expect(decryptField(encryptField(text, key, aad), key, aad)).toBe(text);
  });

  it("does not store plaintext and uses a fresh IV each time", () => {
    const a = encryptField("secret body", key, aad);
    const b = encryptField("secret body", key, aad);
    expect(Buffer.from(a).includes(Buffer.from("secret body"))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("rejects a different key, different context, tampering and bad format", () => {
    const blob = encryptField("x", key, aad);
    expect(() => decryptField(blob, randomBytes(32), aad)).toThrow("Field decryption failed");
    expect(() => decryptField(blob, key, "org-2:Message.bodyText")).toThrow("Field decryption failed");
    const tampered = Buffer.from(blob); // copy
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decryptField(tampered, key, aad)).toThrow("Field decryption failed");
    expect(() => decryptField(Buffer.from([9, 1, 2]), key, aad)).toThrow(/format/);
  });

  it("error messages never contain the plaintext or context", () => {
    const blob = encryptField("top secret", key, aad);
    try {
      decryptField(blob, randomBytes(32), aad);
    } catch (e) {
      expect(String(e)).not.toMatch(/top secret|org-1/);
    }
  });

  it("validates key length", () => {
    expect(parseFieldKey(key.toString("base64")).length).toBe(32);
    expect(() => parseFieldKey(Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });
});
