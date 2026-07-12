import test from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, API_RATE_LIMITS } from "../dist/rate-limit.js";

const CAMPAIGN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CHANNEL_ID = "9b2f1c34-1a2b-4c5d-8e6f-7a8b9c0d1e2f";

// ─── Limits sanity ───────────────────────────────────────────────────────────

test("API_RATE_LIMITS: exact per-minute values", () => {
  assert.deepEqual(API_RATE_LIMITS, { read: 600, write: 120, expensive: 10 });
});

// ─── Exemptions ──────────────────────────────────────────────────────────────

test("classifyRoute: SSE stream is exempt regardless of method noise", () => {
  assert.equal(classifyRoute("GET", "/api/v1/events/stream"), "exempt");
});

test("classifyRoute: webhook prefix is exempt for GET (verification) and POST (ingest)", () => {
  assert.equal(classifyRoute("GET", "/api/v1/webhooks/meta/whatsapp"), "exempt");
  assert.equal(classifyRoute("POST", "/api/v1/webhooks/meta/whatsapp"), "exempt");
});

test("classifyRoute: /health and /metrics are exempt", () => {
  assert.equal(classifyRoute("GET", "/health"), "exempt");
  assert.equal(classifyRoute("GET", "/metrics"), "exempt");
});

test("classifyRoute: /r/ link-click redirects are exempt", () => {
  assert.equal(classifyRoute("GET", "/r/abc123"), "exempt");
});

test("classifyRoute: /auth/login and /auth/register are exempt (own 5/min limiter)", () => {
  assert.equal(classifyRoute("POST", "/auth/login"), "exempt");
  assert.equal(classifyRoute("POST", "/auth/register"), "exempt");
});

test("classifyRoute: /auth/me is exempt (handled before the general gate is reached)", () => {
  assert.equal(classifyRoute("GET", "/auth/me"), "exempt");
});

test("classifyRoute: unknown paths outside /api/ and /auth/ are exempt", () => {
  assert.equal(classifyRoute("GET", "/totally/unknown"), "exempt");
  assert.equal(classifyRoute("POST", "/"), "exempt");
});

// ─── Expensive ───────────────────────────────────────────────────────────────

test("classifyRoute: contacts import/export are expensive", () => {
  assert.equal(classifyRoute("POST", "/api/v1/contacts/import"), "expensive");
  assert.equal(classifyRoute("GET", "/api/v1/contacts/export"), "expensive");
});

test("classifyRoute: campaign run (UUID segment) is expensive", () => {
  assert.equal(classifyRoute("POST", `/api/v1/campaigns/${CAMPAIGN_ID}/run`), "expensive");
});

test("classifyRoute: campaign run with a non-UUID segment does not match the expensive pattern", () => {
  assert.notEqual(classifyRoute("POST", "/api/v1/campaigns/not-a-uuid/run"), "expensive");
});

test("classifyRoute: WhatsApp media upload (UUID segment) is expensive", () => {
  assert.equal(classifyRoute("POST", `/api/v1/channels/whatsapp/${CHANNEL_ID}/media`), "expensive");
});

test("classifyRoute: messages search is expensive (classified ahead of the route landing)", () => {
  assert.equal(classifyRoute("GET", "/api/v1/messages/search"), "expensive");
});

// ─── Write vs read by method ─────────────────────────────────────────────────

test("classifyRoute: mutating methods under /api/ are write", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(classifyRoute(method, "/api/v1/contacts"), "write", method);
  }
});

test("classifyRoute: GET/HEAD under /api/ are read", () => {
  assert.equal(classifyRoute("GET", "/api/v1/contacts"), "read");
  assert.equal(classifyRoute("HEAD", "/api/v1/contacts"), "read");
});

test("classifyRoute: /auth/logout (POST) is write", () => {
  assert.equal(classifyRoute("POST", "/auth/logout"), "write");
});

test("classifyRoute: method matching is case-insensitive", () => {
  assert.equal(classifyRoute("get", "/api/v1/contacts"), "read");
  assert.equal(classifyRoute("post", "/api/v1/contacts"), "write");
});
