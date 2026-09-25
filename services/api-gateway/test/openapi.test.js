import test from "node:test";
import assert from "node:assert/strict";
import { openApiSpec } from "../dist/openapi.js";

// Structural invariants keeping the hand-maintained spec honest.

test("spec metadata and security scheme are present", () => {
  assert.equal(openApiSpec.openapi, "3.1.0");
  assert.ok(openApiSpec.info.title.length > 0);
  assert.ok(openApiSpec.components.securitySchemes.bearerAuth);
});

test("every operation has at least one 2xx response and a summary", () => {
  for (const [path, methods] of Object.entries(openApiSpec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary?.length > 0, `${method.toUpperCase()} ${path} needs a summary`);
      const codes = Object.keys(op.responses ?? {});
      assert.ok(
        codes.some((code) => code.startsWith("2")),
        `${method.toUpperCase()} ${path} needs a 2xx response (has: ${codes.join(",")})`
      );
    }
  }
});

test("every path parameter placeholder is declared", () => {
  for (const [path, methods] of Object.entries(openApiSpec.paths)) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (placeholders.length === 0) continue;
    for (const [method, op] of Object.entries(methods)) {
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      for (const name of placeholders) {
        assert.ok(declared.includes(name), `${method.toUpperCase()} ${path} must declare path param "${name}"`);
      }
    }
  }
});

test("all $ref targets resolve to declared schemas", () => {
  const declared = new Set(Object.keys(openApiSpec.components.schemas).map((n) => `#/components/schemas/${n}`));
  const refs = [...JSON.stringify(openApiSpec).matchAll(/"\$ref":"([^"]+)"/g)];
  assert.ok(refs.length > 0, "expected at least one $ref in the spec");
  for (const [, target] of refs) {
    assert.ok(declared.has(target), `unresolved $ref ${target}`);
  }
});

test("an auth store that cannot be reached is documented as 503 with Retry-After, apart from a refused 401", () => {
  const login = openApiSpec.paths["/auth/login"].post.responses;
  assert.ok(login["401"], "login documents the refusal");
  assert.ok(login["503"], "login documents the outage");
  assert.match(login["503"].description, /auth_unavailable/);
  assert.ok(login["503"].headers["Retry-After"], "the 503 carries a Retry-After");
  assert.match(openApiSpec.info.description, /503 `auth_unavailable`/, "every authenticated endpoint can answer it");
  assert.match(openApiSpec.info.description, /Retry-After/);
});

test("the core public surface is documented", () => {
  for (const path of [
    "/auth/login",
    "/api/v1/contacts",
    "/api/v1/templates",
    "/api/v1/segments",
    "/api/v1/campaigns",
    "/api/v1/campaigns/{campaignId}/run",
    "/api/v1/conversations",
    "/api/v1/conversations/{conversationId}/messages",
    "/api/v1/analytics"
  ]) {
    assert.ok(path in openApiSpec.paths, `${path} missing from the spec`);
  }
});
