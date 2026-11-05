import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-layer field encryption (AES-256-GCM) for message bodies, raw payloads and similar.
 *
 * Blob layout: version(1) | iv(12) | authTag(16) | ciphertext. The version byte allows key/format rotation.
 * `aad` binds a ciphertext to its context (for example `${organizationId}:Message.bodyText`), so a blob
 * copied to another row, column or tenant fails authentication instead of decrypting.
 *
 * Single key-encryption key for now; per-organization data keys (envelope encryption) can slot in behind
 * the same signatures by deriving `key` from the organization.
 */
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function parseFieldKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptField(plaintext: string, key: Buffer, aad: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Copy into a plain Uint8Array<ArrayBuffer>, the type Prisma accepts for Bytes columns.
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]));
}

export function decryptField(blob: Uint8Array, key: Buffer, aad: string): string {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LENGTH + TAG_LENGTH || buf[0] !== VERSION) throw new Error("Unsupported encrypted field format");
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(1 + IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
  } catch {
    // Never include blob or context in the message (rule 10).
    throw new Error("Field decryption failed");
  }
}
