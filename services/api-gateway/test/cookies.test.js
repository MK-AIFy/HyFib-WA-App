import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookieValue,
  csrfViolation
} from "../dist/cookies.js";

// ─── parseCookies ───────────────────────────────────────────────────────────

test("parseCookies: undefined header returns empty object", () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test("parseCookies: empty header returns empty object", () => {
  assert.deepEqual(parseCookies(""), {});
});

test("parseCookies: single pair", () => {
  assert.deepEqual(parseCookies("hf_session=abc123"), { hf_session: "abc123" });
});

test("parseCookies: multiple pairs", () => {
  assert.deepEqual(parseCookies("a=1; b=2; hf_session=tok"), { a: "1", b: "2", hf_session: "tok" });
});

test("parseCookies: '=' inside a value is preserved", () => {
  assert.deepEqual(parseCookies("a=b=c=d"), { a: "b=c=d" });
});

test("parseCookies: tolerates missing/extra spaces after ';'", () => {
  assert.deepEqual(parseCookies("a=1;b=2;   c=3"), { a: "1", b: "2", c: "3" });
});

test("parseCookies: skips malformed pairs (no '=', empty name)", () => {
  assert.deepEqual(parseCookies("a=1; bogus; =noname; b=2"), { a: "1", b: "2" });
});

test("parseCookies: decodes URI-encoded values, falls back to raw on bad encoding", () => {
  assert.deepEqual(parseCookies("greeting=hello%20world"), { greeting: "hello world" });
  // '%' followed by non-hex is not a valid percent-encoding; decodeURIComponent
  // throws, so parseCookies must fall back to the raw value rather than throw.
  assert.deepEqual(parseCookies("bad=100%"), { bad: "100%" });
});

// ─── serializeSessionCookie / clearSessionCookieValue ──────────────────────

test("serializeSessionCookie: exact attribute string without secure", () => {
  assert.equal(
    serializeSessionCookie("tok-123", { secure: false, maxAgeSeconds: 2592000 }),
    `${SESSION_COOKIE}=tok-123; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`
  );
});

test("serializeSessionCookie: exact attribute string with secure", () => {
  assert.equal(
    serializeSessionCookie("tok-123", { secure: true, maxAgeSeconds: 2592000 }),
    `${SESSION_COOKIE}=tok-123; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure`
  );
});

test("clearSessionCookieValue: empty value and Max-Age=0, without secure", () => {
  assert.equal(clearSessionCookieValue(false), `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
});

test("clearSessionCookieValue: empty value and Max-Age=0, with secure", () => {
  assert.equal(
    clearSessionCookieValue(true),
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`
  );
});

// ─── csrfViolation matrix ───────────────────────────────────────────────────

const cookieHeader = (token = "tok") => `${SESSION_COOKIE}=${token}`;

test("csrfViolation: GET with cookie, no custom header -> false (safe method)", () => {
  assert.equal(csrfViolation("GET", "/api/v1/contacts", { cookie: cookieHeader() }), false);
});

test("csrfViolation: POST with bearer -> false (bearer bypass)", () => {
  assert.equal(csrfViolation("POST", "/api/v1/contacts", { authorization: "Bearer abc.def.ghi" }), false);
});

test("csrfViolation: POST with bearer AND cookie -> false (bearer still bypasses)", () => {
  assert.equal(
    csrfViolation("POST", "/api/v1/contacts", {
      authorization: "Bearer abc.def.ghi",
      cookie: cookieHeader()
    }),
    false
  );
});

test("csrfViolation: POST with cookie, no custom header -> TRUE", () => {
  assert.equal(csrfViolation("POST", "/api/v1/contacts", { cookie: cookieHeader() }), true);
});

test("csrfViolation: POST with cookie AND x-requested-with -> false", () => {
  assert.equal(
    csrfViolation("POST", "/api/v1/contacts", {
      cookie: cookieHeader(),
      "x-requested-with": "XMLHttpRequest"
    }),
    false
  );
});

test("csrfViolation: POST with no cookie and no header -> false (nothing to protect)", () => {
  assert.equal(csrfViolation("POST", "/api/v1/contacts", {}), false);
});

test("csrfViolation: exempt paths bypass even with cookie+mutating+no header", () => {
  const exemptCases = [
    ["POST", "/auth/login"],
    ["POST", "/api/v1/webhooks/meta/whatsapp"],
    ["POST", "/auth/register"]
  ];
  for (const [method, path] of exemptCases) {
    assert.equal(csrfViolation(method, path, { cookie: cookieHeader() }), false, `${method} ${path} must be exempt`);
  }
});

test("csrfViolation: /auth/logout is NOT exempt -> TRUE with cookie, no header", () => {
  assert.equal(csrfViolation("POST", "/auth/logout", { cookie: cookieHeader() }), true);
});

test("csrfViolation: PUT/PATCH/DELETE are also mutating methods", () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(csrfViolation(method, "/api/v1/contacts/123", { cookie: cookieHeader() }), true, method);
  }
});
