import { createHmac, timingSafeEqual } from "node:crypto";

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

export function redactPII(input: string): string {
  return input
    .replace(/\+?[1-9]\d{6,14}/g, "[REDACTED_PHONE]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}
