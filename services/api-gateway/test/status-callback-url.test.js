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

// ─── Operator allowlist (OUTBOUND_WEBHOOK_ALLOWLIST) ────────────────────────
//
// The route passes config.outboundWebhookAllowlist — the same allowlist the worker applies at delivery time — so a
// receiver the operator listed can be saved, and the save-time and delivery-time decisions agree.

const ALLOWLIST = Object.freeze({ hosts: ["hooks.corp"], hostSuffixes: ["branch.lan"], cidrs: ["10.1.2.0/24"] });

test("with an operator allowlist, a listed internal host or address is accepted and stored as supplied", () => {
  for (const url of ["http://hooks.corp:8443/hyfib?x=1", "https://printer.branch.lan/cb", "http://10.1.2.3/hyfib"]) {
    assert.deepEqual(parseStatusCallbackUrl(`  ${url} `, ALLOWLIST), { ok: true, value: url }, url);
    assert.equal(parseStatusCallbackUrl(url).ok, false, `${url} must still be refused without the allowlist`);
  }
});

const STILL_REJECTED = [
  ["http://other.corp/", ALLOWLIST, /internal/],
  ["http://a.hooks.corp/", ALLOWLIST, /internal/],
  ["http://branch.lan/", ALLOWLIST, /internal/],
  ["http://10.1.3.1/", ALLOWLIST, /private|reserved/],
  ["http://[::ffff:10.1.2.3]/", ALLOWLIST, /private|reserved/],
  ["http://169.254.169.254/latest/meta-data/", { cidrs: ["0.0.0.0/0", "::/0"] }, /private|reserved/],
  ["http://[fe80::1]/", { cidrs: ["0.0.0.0/0", "::/0"] }, /private|reserved/],
  ["http://127.0.0.1:15672/", { cidrs: ["0.0.0.0/0", "::/0"] }, /private|reserved/],
  // Cloud metadata outside link-local (the hard floor): IPv6 endpoints are unique-local, not link-local, so every
  // range an operator might list to open fc00::/7 — or CGNAT / 192.0.0.0/24 for the IPv4 ones — must still refuse.
  ...[
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[fd20:ce::254]/computeMetadata/v1/",
    "http://[fd00:c1::a9fe:a9fe]/opc/v2/instance/",
    "http://100.100.100.200/latest/meta-data/",
    "http://192.0.0.192/latest/"
  ].flatMap((url) =>
    [
      ["::/0"],
      ["fc00::/7"],
      ["fd00::/8"],
      ["0.0.0.0/0"],
      ["0.0.0.0/0", "::/0"],
      ["100.64.0.0/10", "192.0.0.0/24"],
      [new URL(url).hostname.replace(/^\[|\]$/g, "")]
    ].map((cidrs) => [url, { cidrs }, /private|reserved/])
  ),
  ["file:///etc/passwd", { hosts: ["hooks.corp"] }, /http or https/],
  ["https://admin:hunter2@hooks.corp/", { hosts: ["hooks.corp"] }, /credentials/]
];

for (const [url, allowlist, reason] of STILL_REJECTED) {
  test(`with allowlist ${JSON.stringify(allowlist)}, ${url} is still rejected without revealing the allowlist`, () => {
    const result = parseStatusCallbackUrl(url, allowlist);
    assert.equal(result.ok, false);
    assert.match(result.error, /^Invalid statusCallbackUrl: /);
    assert.match(result.error, reason);
    assert.doesNotMatch(result.error, /hunter2|OUTBOUND_WEBHOOK_ALLOWLIST|10\.1\.2\.0|branch\.lan|0\.0\.0\.0\/0/);
    for (const entry of allowlist.cidrs ?? []) {
      assert.equal(result.error.includes(entry), false, `the error reveals the allowlist entry ${entry}`);
    }
  });
}

test("an empty allowlist is today's behaviour exactly", () => {
  const empty = { hosts: [], hostSuffixes: [], cidrs: [] };
  for (const url of ["https://hooks.example.com/x", "http://hooks.corp/", "http://10.1.2.3/", undefined, "  "]) {
    assert.deepEqual(parseStatusCallbackUrl(url, empty), parseStatusCallbackUrl(url), String(url));
  }
});
