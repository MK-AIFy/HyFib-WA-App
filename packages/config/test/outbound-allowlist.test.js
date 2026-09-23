import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseOutboundWebhookAllowlist } from "../dist/index.js";

/**
 * OUTBOUND_WEBHOOK_ALLOWLIST: the operator-only exceptions to the outbound-URL guard for tenant webhooks
 * (status_callback_url) whose receiver legitimately lives on a private network. It is read from the
 * environment only — never from a tenant setting — and parsed once at config load. Anything that is not a
 * clean host name, "*.suffix", IP address or CIDR throws at startup naming the entry: a typo must never
 * silently widen or drop the allowlist.
 */

const baseEnv = { NODE_ENV: "test" };
const EMPTY = { hosts: [], hostSuffixes: [], cidrs: [] };

test("unset, empty, blank or comma-only means no allowlist (today's behaviour exactly)", () => {
  for (const value of [undefined, "", "   ", ",", " , ,, "]) {
    assert.deepEqual(parseOutboundWebhookAllowlist(value), EMPTY, JSON.stringify(value));
  }
  assert.deepEqual(loadConfig(baseEnv).outboundWebhookAllowlist, EMPTY);
});

test("loadConfig reads OUTBOUND_WEBHOOK_ALLOWLIST into the parsed, serialisable form", () => {
  const config = loadConfig({ ...baseEnv, OUTBOUND_WEBHOOK_ALLOWLIST: "hooks.corp, *.lan.example, 10.1.2.0/24" });
  const expected = { hosts: ["hooks.corp"], hostSuffixes: ["lan.example"], cidrs: ["10.1.2.0/24"] };
  assert.deepEqual(config.outboundWebhookAllowlist, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(config.outboundWebhookAllowlist)), expected);
});

const HOSTS = [
  ["hooks.corp", "hooks.corp"],
  ["HOOKS.Corp", "hooks.corp"],
  ["hooks.corp.", "hooks.corp"],
  ["receiver", "receiver"],
  ["my_service.internal", "my_service.internal"],
  ["xn--hks-qqa.corp", "xn--hks-qqa.corp"],
  ["a-b.c-d.example", "a-b.c-d.example"]
];

for (const [entry, host] of HOSTS) {
  test(`a host-name entry is an exact name, case-insensitive, one trailing dot tolerated: ${entry}`, () => {
    assert.deepEqual(parseOutboundWebhookAllowlist(entry), { hosts: [host], hostSuffixes: [], cidrs: [] });
  });
}

test('"*.suffix" is any subdomain of the suffix but NOT the bare suffix unless that is listed too', () => {
  assert.deepEqual(parseOutboundWebhookAllowlist("*.corp.example"), {
    hosts: [],
    hostSuffixes: ["corp.example"],
    cidrs: []
  });
  assert.deepEqual(parseOutboundWebhookAllowlist("*.CORP., corp"), {
    hosts: ["corp"],
    hostSuffixes: ["corp"],
    cidrs: []
  });
});

const ADDRESSES = [
  ["10.1.2.3", "10.1.2.3/32"],
  ["10.1.2.0/24", "10.1.2.0/24"],
  ["192.168.0.0/16", "192.168.0.0/16"],
  ["127.0.0.1", "127.0.0.1/32"],
  ["0.0.0.0/0", "0.0.0.0/0"],
  ["fd00::1", "fd00::1/128"],
  ["FD00:0:0::/64", "fd00::/64"],
  ["fd12:3456:789a:0000::/48", "fd12:3456:789a::/48"],
  ["::1", "::1/128"],
  ["::/0", "::/0"],
  ["::ffff:10.0.0.0/104", "::ffff:a00:0/104"]
];

for (const [entry, cidr] of ADDRESSES) {
  test(`an address or CIDR entry is stored canonically: ${entry} -> ${cidr}`, () => {
    assert.deepEqual(parseOutboundWebhookAllowlist(entry), { hosts: [], hostSuffixes: [], cidrs: [cidr] });
  });
}

test("whitespace around entries is ignored, entries keep their order and exact duplicates collapse", () => {
  assert.deepEqual(
    parseOutboundWebhookAllowlist("  hooks.corp ,\t10.1.2.0/24 , HOOKS.corp., *.lan ,*.LAN, 10.1.2.0/24, billing  "),
    { hosts: ["hooks.corp", "billing"], hostSuffixes: ["lan"], cidrs: ["10.1.2.0/24"] }
  );
});

test("the parsed allowlist is immutable (the guard compiles it once and caches the result)", () => {
  const parsed = parseOutboundWebhookAllowlist("hooks.corp,*.lan,10.0.0.0/8");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.hosts));
  assert.ok(Object.isFrozen(parsed.hostSuffixes));
  assert.ok(Object.isFrozen(parsed.cidrs));
});

const INVALID = [
  ["10.1.2.3/24", /host bits/],
  ["fd00::1/64", /host bits/],
  ["10.1.2.0/33", /prefix/],
  ["fd00::/129", /prefix/],
  ["10.1.2.0/", /prefix/],
  ["10.1.2.0/abc", /prefix/],
  ["10.1.2.0/024", /prefix/],
  ["10.0.0.0/8/8", /CIDR/],
  ["/24", /CIDR/],
  ["10.1.2", /IPv4/],
  ["999.1.1.1", /IPv4/],
  ["01.2.3.4", /IPv4/],
  ["hooks.0x7f", /IPv4/],
  ["fe80::1%eth0", /zone/],
  ["[fd00::1]", /bracket/],
  ["hooks.corp:8443", /port|scheme|host name/],
  ["https://hooks.corp", /port|scheme|host name/],
  ["hooks.corp/path", /CIDR|host name/],
  ["*", /wildcard/],
  ["*.", /wildcard/],
  ["*corp", /wildcard/],
  ["*.*.corp", /wildcard/],
  ["hooks.*.corp", /wildcard/],
  ["a..b", /empty label/],
  ["hooks.corp..", /empty label/],
  [".hooks.corp", /empty label/],
  ["hooks corp", /host name/],
  ["hööks.corp", /punycode/],
  [`${"a".repeat(64)}.corp`, /63/],
  [`${"a.".repeat(127)}corp`, /253/]
];

for (const [entry, reason] of INVALID) {
  test(`an invalid entry throws at parse time naming the entry: ${JSON.stringify(entry).slice(0, 40)}`, () => {
    assert.throws(
      () => parseOutboundWebhookAllowlist(`hooks.corp, ${entry}, 10.1.2.0/24`),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("OUTBOUND_WEBHOOK_ALLOWLIST"), error.message);
        assert.ok(error.message.includes(`"${entry}"`), `the message must name the entry: ${error.message}`);
        assert.match(error.message, reason);
        return true;
      }
    );
  });
}

test("loadConfig refuses to start on an invalid entry (fail loud at startup, not at first delivery)", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, OUTBOUND_WEBHOOK_ALLOWLIST: "hooks.corp,10.1.2.3/24" }),
    /OUTBOUND_WEBHOOK_ALLOWLIST entry "10\.1\.2\.3\/24"/
  );
});

test("the allowlist is operator config only: no other setting or default feeds it", () => {
  const config = loadConfig({ ...baseEnv, ALLOWED_WEBHOOK_CIDRS: "10.0.0.0/8", PLATFORM_BASE_URL: "http://10.0.0.1" });
  assert.deepEqual(config.outboundWebhookAllowlist, EMPTY);
});
