import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/index.js";

const baseEnv = { NODE_ENV: "test" };

test("loadConfig surfaces ORG_TENANT_ID and ORG_NAME when set", () => {
  const config = loadConfig({
    ...baseEnv,
    ORG_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    ORG_NAME: "Acme Corp"
  });
  assert.equal(config.orgTenantId, "11111111-1111-1111-1111-111111111111");
  assert.equal(config.orgName, "Acme Corp");
});

test("loadConfig defaults orgTenantId and orgName to empty string when unset", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.orgTenantId, "");
  assert.equal(config.orgName, "");
});

test("loadConfig does not throw when ORG_TENANT_ID/ORG_NAME are absent", () => {
  assert.doesNotThrow(() => loadConfig(baseEnv));
});

test("existing behavior is untouched: whatsappGraphVersion still defaults to v22.0", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.whatsappGraphVersion, "v22.0");
});
