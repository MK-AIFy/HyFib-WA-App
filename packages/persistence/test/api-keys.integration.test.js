import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  apiKeyRepository,
  hashApiKey,
  whatsappSettingsRepository,
  closePool
} from "../dist/index.js";

// Public API keys + webhook secret (roadmap Phase D). Requires migration 030.
const skip = !process.env.RUN_DB_TESTS;

test("api key lifecycle: create (hash-only storage) → auth lookup → revoke", { skip }, async () => {
  const tenant = await tenantRepository.create("ApiKey Tenant");
  const { key, record } = await apiKeyRepository.create(tenant.id, {
    name: "Zapier integration",
    roles: ["marketing_manager"]
  });

  assert.match(key, /^hyfib_[0-9a-f]{48}$/);
  assert.equal(record.keyPrefix, key.slice(0, 14));
  assert.deepEqual(record.roles, ["marketing_manager"]);
  assert.equal(record.revokedAt, undefined);

  const found = await apiKeyRepository.findActiveByHash(tenant.id, hashApiKey(key));
  assert.equal(found?.id, record.id, "presented key resolves by hash");
  assert.equal(await apiKeyRepository.findActiveByHash(tenant.id, hashApiKey("hyfib_wrong")), undefined);

  const listed = await apiKeyRepository.list(tenant.id);
  assert.equal(listed.length, 1);
  assert.equal("keyHash" in listed[0], false, "hash never leaves the repository");

  assert.equal(await apiKeyRepository.revoke(tenant.id, record.id), true);
  assert.equal(await apiKeyRepository.revoke(tenant.id, record.id), false, "second revoke is a no-op");
  assert.equal(
    await apiKeyRepository.findActiveByHash(tenant.id, hashApiKey(key)),
    undefined,
    "revoked keys stop authenticating"
  );
});

test("whatsapp settings round-trip the webhook callback url + secret", { skip }, async () => {
  const tenant = await tenantRepository.create("Webhook Settings Tenant");
  const saved = await whatsappSettingsRepository.upsert(tenant.id, {
    statusCallbackUrl: "https://example.com/hooks/hyfib",
    statusCallbackSecret: "whsec_123",
    graphVersion: "v21.0",
    retryMaxAttempts: 3,
    retryBaseDelayMs: 500
  });
  assert.equal(saved.statusCallbackUrl, "https://example.com/hooks/hyfib");
  assert.equal(saved.statusCallbackSecret, "whsec_123");

  const fetched = await whatsappSettingsRepository.getByTenant(tenant.id);
  assert.equal(fetched?.statusCallbackSecret, "whsec_123");
});

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
