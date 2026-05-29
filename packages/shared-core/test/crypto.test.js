import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../dist/index.js";

const hexKey = randomBytes(32).toString("hex");
const base64Key = randomBytes(32).toString("base64");

test("encrypt/decrypt round-trips with a hex key", () => {
  const token = "EAAG-super-secret-access-token";
  const sealed = encryptSecret(token, hexKey);
  assert.ok(sealed.startsWith("v1:"));
  assert.notEqual(sealed, token);
  assert.equal(decryptSecret(sealed, hexKey), token);
});

test("encrypt/decrypt round-trips with a base64 key", () => {
  const token = "another-token-value";
  const sealed = encryptSecret(token, base64Key);
  assert.equal(decryptSecret(sealed, base64Key), token);
});

test("each encryption uses a fresh IV (ciphertexts differ)", () => {
  const a = encryptSecret("same", hexKey);
  const b = encryptSecret("same", hexKey);
  assert.notEqual(a, b);
});

test("decryption fails on a tampered payload", () => {
  const sealed = encryptSecret("secret", hexKey);
  const parts = sealed.split(":");
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from("zzzz").toString("base64")}`;
  assert.throws(() => decryptSecret(tampered, hexKey));
});

test("decryption fails with the wrong key", () => {
  const sealed = encryptSecret("secret", hexKey);
  assert.throws(() => decryptSecret(sealed, randomBytes(32).toString("hex")));
});

test("a key of the wrong length is rejected", () => {
  assert.throws(() => encryptSecret("secret", "tooshort"));
});
