import test from "node:test";
import assert from "node:assert/strict";
import { parseStatusCallbackUrl } from "../dist/validation.js";

/**
 * Save-time validation of PUT /api/v1/channels/whatsapp/settings → statusCallbackUrl (SSRF). The pure helper
 * the route calls is tested here; whatsapp-settings-route.test.js pins that the route runs it before any
 * repository write. The worker re-checks every delivery, including each resolved address; this is the early,
 * explicit 400 an admin sees when saving a URL that points inside the network.
 */

test("absent, null or blank still means 'no callback' (clears the stored URL, as before)", () => {
  for (const value of [undefined, null, "", "   ", "\t\n"]) {
    assert.deepEqual(parseStatusCallbackUrl(value), { ok: true, value: undefined }, JSON.stringify(value));
  }
});

test("a public http(s) URL is accepted and stored trimmed but otherwise exactly as supplied", () => {
  assert.deepEqual(parseStatusCallbackUrl("  https://hooks.example.com/hyfib  "), {
    ok: true,
    value: "https://hooks.example.com/hyfib"
  });
  // Stored as supplied, not re-serialised (no trailing slash added to a bare origin).
  assert.deepEqual(parseStatusCallbackUrl("https://hooks.example.com"), {
    ok: true,
    value: "https://hooks.example.com"
  });
  // Plain http stays allowed for now: requiring https is tracked separately and would break existing tenants.
  assert.deepEqual(parseStatusCallbackUrl("http://cb.example.com:8080/x?y=1"), {
    ok: true,
    value: "http://cb.example.com:8080/x?y=1"
  });
});

test("a non-string value is a 400, not a TypeError from .trim()", () => {
  for (const value of [42, true, {}, ["https://hooks.example.com"]]) {
    const result = parseStatusCallbackUrl(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.error, "statusCallbackUrl must be a string");
  }
});

const REJECTED = [
  ["http://169.254.169.254/latest/meta-data/", /private|reserved/],
  ["http://2852039166/latest/meta-data/", /private|reserved/],
  ["http://127.0.0.1:15672/api/overview", /private|reserved/],
  ["http://0x7f.1/", /private|reserved/],
  ["http://[::1]:8080/", /private|reserved/],
  ["http://[::ffff:10.0.0.1]/", /private|reserved/],
  ["http://10.0.0.5/admin", /private|reserved/],
  ["http://172.20.0.3:5432/", /private|reserved/],
  ["http://192.168.1.1/", /private|reserved/],
  ["http://100.64.0.1/", /private|reserved/],
  ["http://localhost:8080/internal/v1/whatsapp/send", /internal/],
  ["http://metadata.google.internal/computeMetadata/v1/", /internal/],
  ["http://rabbitmq:15672/", /internal/],
  ["http://postgres:5432/", /internal/],
  ["file:///etc/passwd", /http or https/],
  ["gopher://example.com:70/_x", /http or https/],
  ["ftp://example.com/", /http or https/],
  ["https://admin:hunter2@hooks.example.com/", /credentials/],
  ["not a url", /valid absolute URL/],
  [`https://hooks.example.com/${"a".repeat(2100)}`, /at most 2048/]
];

for (const [url, reason] of REJECTED) {
  test(`rejects ${url.length > 60 ? `${url.slice(0, 60)}…` : url} with a clear error`, () => {
    const result = parseStatusCallbackUrl(url);
    assert.equal(result.ok, false);
    assert.match(result.error, /^Invalid statusCallbackUrl: /);
    assert.match(result.error, reason);
    assert.doesNotMatch(result.error, /hunter2/, "credentials must not be echoed back");
  });
}
