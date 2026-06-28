import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const actual = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"), "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

/**
 * Constant-time comparison of the Meta webhook verification token
 * (`hub.verify_token`) against the configured value, avoiding the timing
 * side-channel of a plain `===` on a secret.
 */
export function verifyWebhookToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Decodes a 32-byte AES-256 key supplied as base64 or hex. Throws if the
 * decoded length is wrong so misconfiguration fails loudly at first use.
 */
function decodeKey(key: string): Buffer {
  const trimmed = key.trim();
  let buffer: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buffer = Buffer.from(trimmed, "hex");
  } else {
    buffer = Buffer.from(trimmed, "base64");
  }
  if (buffer.length !== 32) {
    throw new Error("Encryption key must decode to exactly 32 bytes (hex or base64)");
  }
  return buffer;
}

/**
 * AES-256-GCM encrypts a secret (e.g. a per-tenant WhatsApp access token) and
 * returns a self-describing string `v1:<iv>:<authTag>:<ciphertext>` (all base64),
 * safe to persist in a TEXT column.
 */
export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Reverses {@link encryptSecret}. Throws if the payload is malformed or tampered. */
export function decryptSecret(payload: string, key: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed encrypted secret");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const authTag = Buffer.from(parts[2]!, "base64");
  const ciphertext = Buffer.from(parts[3]!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(key), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function redactPII(input: string): string {
  return input
    .replace(/\+?[1-9]\d{6,14}/g, "[REDACTED_PHONE]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}
