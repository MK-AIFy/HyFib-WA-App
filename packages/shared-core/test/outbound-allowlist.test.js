import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  OutboundUrlBlockedError,
  createGuardedLookup,
  createOutboundFetch,
  isHardBlockedAddress,
  validateOutboundUrl
} from "../dist/index.js";

/**
 * The operator allowlist (OUTBOUND_WEBHOOK_ALLOWLIST) on top of the outbound-URL guard. Two independent knobs,
 * least privilege:
 *  - a HOST entry (exact, or "*.suffix" → hostSuffixes) lifts only the name checks (internal suffixes and
 *    single-label names) for that host;
 *  - an ADDRESS/CIDR entry permits only those addresses, as IP literals at save time and as resolved addresses
 *    at connect time.
 * An internal receiver hooks.corp -> 10.1.2.3 therefore needs both. Whatever is listed, the hard floor stays
 * blocked (link-local/metadata, unspecified, multicast, 240/4), and loopback opens only for an entry that lies
 * entirely inside 127.0.0.0/8 or is exactly ::1. No real DNS is used: every resolver is injected.
 */

function lookupAsync(lookup, hostname, options = {}) {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

/** Save time, then delivery time without a socket: the same two checks createOutboundFetch runs. */
async function decide(url, allowlist, answers) {
  const saved = validateOutboundUrl(url, { allowlist });
  if (!saved.ok) {
    return { save: "blocked", delivery: "blocked", remedy: saved.remedy, error: saved.error };
  }
  const host = saved.url.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
    return { save: "ok", delivery: "ok" }; // net.connect skips lookup for an IP literal
  }
  const calls = [];
  const lookup = createGuardedLookup({
    allowlist,
    resolve: async (name) => {
      calls.push(name);
      return answers;
    }
  });
  const { error } = await lookupAsync(lookup, host, { all: true });
  assert.equal(calls.length, 1, "exactly one resolution per connection");
  if (error) {
    assert.ok(error instanceof OutboundUrlBlockedError, String(error));
    return { save: "ok", delivery: "blocked", remedy: error.remedy, error: error.message };
  }
  return { save: "ok", delivery: "ok" };
}

// ─── Backward compatibility: no allowlist means today's behaviour exactly ───

const EMPTY = { hosts: [], hostSuffixes: [], cidrs: [] };
const COMPAT_URLS = [
  "https://hooks.example.com/x",
  "http://10.0.0.5/admin",
  "http://127.0.0.1:8080/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://hooks.corp/",
  "http://postgres:5432/",
  "http://localhost../",
  "file:///etc/passwd",
  "https://u:p@hooks.example.com/"
];

for (const url of COMPAT_URLS) {
  test(`an omitted or empty allowlist changes nothing: ${url}`, () => {
    const today = validateOutboundUrl(url);
    for (const policy of [undefined, {}, { allowlist: undefined }, { allowlist: EMPTY }, { allowlist: {} }]) {
      const result = validateOutboundUrl(url, policy);
      assert.equal(result.ok, today.ok, JSON.stringify(policy));
      assert.equal(result.error, today.error, JSON.stringify(policy));
    }
  });
}

test("an empty allowlist leaves the connect-time guard unchanged", async () => {
  for (const allowlist of [undefined, EMPTY]) {
    const lookup = createGuardedLookup({ allowlist, resolve: async () => [{ address: "10.1.2.3", family: 4 }] });
    const { error } = await lookupAsync(lookup, "hooks.example.com");
    assert.ok(error instanceof OutboundUrlBlockedError);
  }
});

// ─── The internal-receiver matrix: hostname-only vs CIDR-only vs both ───────

const RECEIVER = "http://hooks.corp:8443/hyfib?token=secret";
const RESOLVES_TO_RECEIVER = [{ address: "10.1.2.3", family: 4 }];

const MATRIX = [
  ["no allowlist", undefined, { save: "blocked", delivery: "blocked", remedy: "host" }],
  ["hostname only", { hosts: ["hooks.corp"] }, { save: "ok", delivery: "blocked", remedy: "address" }],
  ["CIDR only", { cidrs: ["10.1.2.0/24"] }, { save: "blocked", delivery: "blocked", remedy: "host" }],
  ["hostname + CIDR", { hosts: ["hooks.corp"], cidrs: ["10.1.2.0/24"] }, { save: "ok", delivery: "ok" }],
  ["hostname + /32", { hosts: ["hooks.corp"], cidrs: ["10.1.2.3/32"] }, { save: "ok", delivery: "ok" }],
  ["hostname + bare address", { hosts: ["hooks.corp"], cidrs: ["10.1.2.3"] }, { save: "ok", delivery: "ok" }],
  ["wildcard + CIDR", { hostSuffixes: ["corp"], cidrs: ["10.1.2.0/24"] }, { save: "ok", delivery: "ok" }],
  [
    "hostname + a CIDR that misses the address",
    { hosts: ["hooks.corp"], cidrs: ["10.1.3.0/24"] },
    { save: "ok", delivery: "blocked", remedy: "address" }
  ]
];

for (const [label, allowlist, expected] of MATRIX) {
  test(`hooks.corp -> 10.1.2.3 with ${label}: save ${expected.save}, delivery ${expected.delivery}`, async () => {
    const outcome = await decide(RECEIVER, allowlist, RESOLVES_TO_RECEIVER);
    assert.equal(outcome.save, expected.save, outcome.error);
    assert.equal(outcome.delivery, expected.delivery, outcome.error);
    assert.equal(outcome.remedy, expected.remedy);
    assert.doesNotMatch(outcome.error ?? "", /token|secret|hyfib/, "the path/query never appears in a reason");
  });
}

// ─── Host-name entries lift only the name checks ────────────────────────────

const HOST_CASES = [
  // [allowlist, url, ok]
  [{ hosts: ["hooks.corp"] }, "http://hooks.corp/x", true],
  [{ hosts: ["hooks.corp"] }, "http://HOOKS.Corp./x", true],
  [{ hosts: ["HOOKS.CORP."] }, "http://hooks.corp/x", true],
  [{ hosts: ["hooks.corp"] }, "http://other.corp/x", false],
  [{ hosts: ["hooks.corp"] }, "http://a.hooks.corp/x", false],
  [{ hosts: ["hooks.corp"] }, "http://hooks.corp../x", false],
  [{ hosts: ["receiver"] }, "http://receiver:8080/x", true],
  [{ hosts: ["receiver"] }, "http://postgres:5432/", false],
  [{ hosts: ["hooks.corp"] }, "http://10.1.2.3/x", false],
  [{ hosts: ["hooks.corp"] }, "http://[fd00::1]/x", false],
  [{ hosts: ["hooks.corp"] }, "file://hooks.corp/etc/passwd", false],
  [{ hosts: ["hooks.corp"] }, "http://user:pw@hooks.corp/", false],
  [{ hostSuffixes: ["corp"] }, "http://hooks.corp/", true],
  [{ hostSuffixes: ["corp"] }, "http://a.b.corp/", true],
  [{ hostSuffixes: ["corp"] }, "http://corp/", false],
  [{ hostSuffixes: ["corp"] }, "http://hooks.lan/", false],
  [{ hostSuffixes: ["corp"] }, "http://hookscorp/", false],
  [{ hosts: ["corp"], hostSuffixes: ["corp"] }, "http://corp/", true],
  [{ hostSuffixes: ["branch.lan"] }, "http://printer.branch.lan/", true],
  [{ hostSuffixes: ["branch.lan"] }, "http://branch.lan/", false],
  [{ hostSuffixes: ["branch.lan"] }, "http://printer.other.lan/", false],
  [{ hostSuffixes: ["internal"] }, "http://metadata.google.internal/computeMetadata/v1/", true]
];

for (const [allowlist, url, ok] of HOST_CASES) {
  test(`save time with ${JSON.stringify(allowlist)}: ${url} is ${ok ? "allowed" : "refused"}`, () => {
    const result = validateOutboundUrl(url, { allowlist });
    assert.equal(result.ok, ok, result.error);
  });
}

test("a host entry never permits the private address its name resolves to (the metadata name included)", async () => {
  const internal = await decide("http://metadata.google.internal/computeMetadata/v1/", { hostSuffixes: ["internal"] }, [
    { address: "169.254.169.254", family: 4 }
  ]);
  assert.deepEqual([internal.save, internal.delivery], ["ok", "blocked"]);
  assert.equal(internal.remedy, undefined, "metadata is the hard floor: nothing can allow it");

  const everything = await decide(
    "http://metadata/computeMetadata/v1/",
    { hosts: ["metadata"], cidrs: ["0.0.0.0/0"] },
    [{ address: "169.254.169.254", family: 4 }]
  );
  assert.deepEqual([everything.save, everything.delivery], ["ok", "blocked"]);
});

// ─── Address / CIDR entries permit only those addresses ─────────────────────

const ADDRESS_CASES = [
  // [cidrs, url, ok]
  [["10.1.2.0/24"], "http://10.1.2.3/", true],
  [["10.1.2.0/24"], "http://10.1.2.0/", true],
  [["10.1.2.0/24"], "http://10.1.2.255/", true],
  [["10.1.2.0/24"], "http://10.1.3.0/", false],
  [["10.1.2.0/24"], "http://10.1.1.255/", false],
  [["10.1.2.0/24"], "http://167838211/", true], // decimal spelling of 10.1.2.3: the same address
  [["10.1.2.0/24"], "http://[::ffff:10.1.2.3]/", false], // a v4 entry never matches an IPv6 spelling
  [["10.1.2.0/24"], "http://hooks.corp/", false], // an address entry never lifts a name check
  [["10.1.2.3"], "http://10.1.2.3:8443/", true],
  [["10.1.2.3"], "http://10.1.2.4/", false],
  [["192.168.0.0/16"], "http://192.168.77.1/", true],
  [["172.16.0.0/12"], "http://172.31.255.255/", true],
  [["100.64.0.0/10"], "http://100.64.0.1/", true],
  [["fd00:1::/64"], "http://[fd00:1::5]/", true],
  [["fd00:1::/64"], "http://[fd00:1:0:0:ffff::1]/", true],
  [["fd00:1::/64"], "http://[fd00:2::5]/", false],
  [["fd00::1"], "http://[fd00::1]:8080/", true],
  [["fd00::1"], "http://[fd00::2]/", false],
  [["::ffff:10.1.2.0/120"], "http://[::ffff:10.1.2.3]/", true],
  [["::ffff:10.1.2.0/120"], "http://10.1.2.3/", false]
];

for (const [cidrs, url, ok] of ADDRESS_CASES) {
  test(`save time with cidrs ${JSON.stringify(cidrs)}: ${url} is ${ok ? "allowed" : "refused"}`, () => {
    const result = validateOutboundUrl(url, { allowlist: { cidrs } });
    assert.equal(result.ok, ok, result.error);
    if (!ok && result.error?.match(/private|reserved/)) {
      assert.equal(result.remedy, "address");
    }
  });
}

test("connect time: an allowlisted CIDR admits a resolved address and hands only it to the socket", async () => {
  const lookup = createGuardedLookup({
    allowlist: { cidrs: ["10.1.2.0/24"] },
    resolve: async () => [{ address: "10.1.2.3", family: 4 }]
  });
  const single = await lookupAsync(lookup, "hooks.example.com");
  assert.equal(single.error, null);
  assert.equal(single.address, "10.1.2.3");
  const all = await lookupAsync(lookup, "hooks.example.com", { all: true });
  assert.deepEqual(all.address, [{ address: "10.1.2.3", family: 4 }]);
});

test("connect time: a mixed answer is still refused whole when any address is outside the allowlist", async () => {
  for (const answers of [
    [
      { address: "10.1.2.3", family: 4 },
      { address: "10.9.9.9", family: 4 }
    ],
    [
      { address: "10.1.2.3", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ]
  ]) {
    const lookup = createGuardedLookup({ allowlist: { cidrs: ["10.1.2.0/24"] }, resolve: async () => answers });
    const { error, address } = await lookupAsync(lookup, "mixed.example.com", { all: true });
    assert.ok(error instanceof OutboundUrlBlockedError);
    assert.equal(address, undefined);
  }
});

test("connect time: the refusal says whether an address entry could help (remedy) without naming the path", async () => {
  const privateLookup = createGuardedLookup({ resolve: async () => [{ address: "10.9.9.9", family: 4 }] });
  const privateResult = await lookupAsync(privateLookup, "hooks.example.com");
  assert.equal(privateResult.error.remedy, "address");
  assert.match(privateResult.error.message, /10\.9\.9\.9/);

  const floorLookup = createGuardedLookup({ resolve: async () => [{ address: "169.254.169.254", family: 4 }] });
  const floorResult = await lookupAsync(floorLookup, "hooks.example.com");
  assert.equal(floorResult.error.remedy, undefined);
});

// ─── The hard floor: never allowable, whatever is listed ────────────────────

const EVERYTHING = { hosts: ["metadata"], hostSuffixes: ["internal"], cidrs: ["0.0.0.0/0", "::/0"] };

const HARD_FLOOR = [
  ["169.254.169.254", "cloud metadata"],
  ["169.254.0.1", "169.254/16 lower"],
  ["169.254.255.255", "169.254/16 upper"],
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "0.0.0.0/8"],
  ["224.0.0.1", "multicast lower"],
  ["239.255.255.250", "multicast (SSDP)"],
  ["240.0.0.1", "240/4 reserved"],
  ["255.255.255.255", "limited broadcast"],
  ["::", "IPv6 unspecified"],
  ["fe80::1", "IPv6 link-local"],
  ["febf:ffff::1", "IPv6 link-local upper"],
  ["ff02::1", "IPv6 multicast"],
  ["ff05::1:3", "IPv6 site multicast"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ["::ffff:0.0.0.0", "IPv4-mapped unspecified"],
  ["::ffff:224.0.0.1", "IPv4-mapped multicast"],
  ["::169.254.169.254", "IPv4-compatible metadata"],
  ["::ffff:0:a9fe:a9fe", "IPv4-translated metadata"],
  ["64:ff9b::a9fe:a9fe", "NAT64 metadata"],
  ["64:ff9b:1::a9fe:a9fe", "local-use NAT64 metadata"],
  ["2002:a9fe:a9fe::1", "6to4 metadata"]
];

for (const [ip, label] of HARD_FLOOR) {
  test(`hard floor under a 0.0.0.0/0 + ::/0 allowlist: ${label} (${ip}) stays blocked at save and connect time`, async () => {
    assert.equal(isHardBlockedAddress(ip), true);
    const literal = ip.includes(":") ? `http://[${ip}]/latest/meta-data/` : `http://${ip}/latest/meta-data/`;
    const saved = validateOutboundUrl(literal, { allowlist: EVERYTHING });
    assert.equal(saved.ok, false, `${literal} was allowed`);
    assert.equal(saved.remedy, undefined, "the hard floor is never offered as allowlistable");

    const lookup = createGuardedLookup({
      allowlist: EVERYTHING,
      resolve: async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }]
    });
    const { error } = await lookupAsync(lookup, "metadata");
    assert.ok(error instanceof OutboundUrlBlockedError, `${ip} was handed to the socket`);
    assert.equal(error.remedy, undefined);
  });
}

test("hard floor bypass spellings of the metadata address stay blocked under 0.0.0.0/0", () => {
  for (const url of [
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://169.254.169.254./"
  ]) {
    assert.equal(validateOutboundUrl(url, { allowlist: EVERYTHING }).ok, false, url);
  }
});

const OPENED_BY_EVERYTHING = [
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "100.64.0.1",
  "198.18.0.1",
  "192.0.2.1",
  "fd00::1",
  "fec0::1",
  "2001:db8::1"
];

for (const ip of OPENED_BY_EVERYTHING) {
  test(`an operator-listed 0.0.0.0/0 + ::/0 does open non-floor private space: ${ip}`, () => {
    assert.equal(isHardBlockedAddress(ip), false);
    const literal = ip.includes(":") ? `http://[${ip}]/` : `http://${ip}/`;
    assert.equal(validateOutboundUrl(literal, { allowlist: EVERYTHING }).ok, true);
  });
}

// ─── IPv6 spellings of a private IPv4 address: only an explicit entry ───────
//
// ::ffff:10.0.0.1 connects to 10.0.0.1. A broad IPv6 range (::/0, meant to open IPv6) must not quietly open every
// private IPv4 host through its mapped / NAT64 / 6to4 spelling: only an entry lying inside that form's own prefix
// admits it — the same rule as loopback.

const TRANSITION_CASES = [
  // [cidrs, address, allowed]
  [["::/0"], "::ffff:10.0.0.1", false],
  [["::/64"], "::ffff:10.0.0.1", false],
  [["::ffff:0:0/96"], "::ffff:10.0.0.1", true],
  [["::ffff:10.0.0.0/104"], "::ffff:10.0.0.1", true],
  [["::ffff:10.0.0.0/104"], "::ffff:10.1.0.1", true],
  [["::ffff:10.0.0.0/104"], "::ffff:11.0.0.1", false],
  [["::/0"], "::10.0.0.1", false],
  [["::/96"], "::10.0.0.1", true],
  [["::/0"], "::ffff:0:a00:1", false],
  [["::ffff:0:0:0/96"], "::ffff:0:a00:1", true],
  [["::/0"], "64:ff9b::a00:1", false],
  [["64:ff9b::/96"], "64:ff9b::a00:1", true],
  [["64:ff9b::a00:0/104"], "64:ff9b::a00:1", true],
  [["64::/16"], "64:ff9b::a00:1", false],
  [["::/0"], "64:ff9b:1::a00:1", false],
  [["64:ff9b:1::/48"], "64:ff9b:1::a00:1", true],
  [["::/0"], "2002:a00:1::1", false],
  [["2002::/16"], "2002:a00:1::1", true],
  [["2002:a00::/24"], "2002:a00:1::1", true],
  [["2000::/3"], "2002:a00:1::1", false],
  [["0.0.0.0/0"], "::ffff:10.0.0.1", false]
];

for (const [cidrs, ip, allowed] of TRANSITION_CASES) {
  test(`transition form ${ip} with cidrs ${JSON.stringify(cidrs)} is ${allowed ? "allowed" : "refused"}`, async () => {
    const saved = validateOutboundUrl(`http://[${ip}]/`, { allowlist: { cidrs } });
    assert.equal(saved.ok, allowed, saved.error);
    if (!allowed) {
      assert.equal(saved.remedy, "address", "an explicit entry can still admit it");
    }
    const lookup = createGuardedLookup({ allowlist: { cidrs }, resolve: async () => [{ address: ip, family: 6 }] });
    const { error } = await lookupAsync(lookup, "receiver.example.com");
    assert.equal(error === null, allowed, String(error));
  });
}

// ─── Loopback: only when listed explicitly ──────────────────────────────────

const LOOPBACK_CASES = [
  // [cidrs, address, allowed]
  [["0.0.0.0/0", "::/0"], "127.0.0.1", false],
  [["0.0.0.0/0", "::/0"], "127.9.9.9", false],
  [["0.0.0.0/0", "::/0"], "::1", false],
  [["64.0.0.0/2"], "127.0.0.1", false],
  [["64.0.0.0/2"], "100.64.0.1", true],
  [["126.0.0.0/7"], "127.0.0.1", false],
  [["127.0.0.1/32"], "127.0.0.1", true],
  [["127.0.0.1"], "127.0.0.1", true],
  [["127.0.0.1"], "127.0.0.2", false],
  [["127.0.0.0/8"], "127.9.9.9", true],
  [["127.0.0.0/16"], "127.0.200.1", true],
  [["::1"], "::1", true],
  [["::1/128"], "::1", true],
  [["::/127"], "::1", false],
  [["::ffff:127.0.0.0/104"], "::ffff:127.0.0.1", false],
  [["127.0.0.0/8"], "::ffff:127.0.0.1", false],
  [["::/0"], "64:ff9b::7f00:1", false]
];

for (const [cidrs, ip, allowed] of LOOPBACK_CASES) {
  test(`loopback ${ip} with cidrs ${JSON.stringify(cidrs)} is ${allowed ? "allowed" : "refused"}`, async () => {
    assert.equal(isHardBlockedAddress(ip), false, "loopback is not the hard floor");
    const literal = ip.includes(":") ? `http://[${ip}]:8080/` : `http://${ip}:8080/`;
    assert.equal(validateOutboundUrl(literal, { allowlist: { cidrs } }).ok, allowed);
    const lookup = createGuardedLookup({
      allowlist: { cidrs },
      resolve: async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }]
    });
    const { error } = await lookupAsync(lookup, "receiver.example.com");
    assert.equal(error === null, allowed, String(error));
  });
}

// ─── isHardBlockedAddress: the floor classifier on its own ──────────────────

test("isHardBlockedAddress is false for allowable space and fails closed on junk", () => {
  for (const ip of ["8.8.8.8", "10.0.0.1", "127.0.0.1", "::1", "fd00::1", "2606:4700:4700::1111", "::ffff:10.0.0.1"]) {
    assert.equal(isHardBlockedAddress(ip), false, ip);
  }
  for (const junk of ["", "localhost", "999.1.1.1", "::gg", "[::1]"]) {
    assert.equal(isHardBlockedAddress(junk), true, JSON.stringify(junk));
  }
});

// ─── Invalid allowlists fail loud instead of silently granting or dropping ──

const INVALID_ALLOWLISTS = [
  { cidrs: ["10.1.2.3/24"] },
  { cidrs: ["10.1.2.0/33"] },
  { cidrs: ["hooks.corp"] },
  { cidrs: ["fd00::1/64"] },
  { cidrs: ["10.0.0.0/8/8"] },
  { cidrs: [""] },
  { hosts: [""] },
  { hosts: ["*.corp"] },
  { hosts: ["hooks corp"] },
  { hosts: ["a..b"] },
  { hostSuffixes: ["*.corp"] },
  { hostSuffixes: [""] },
  { hosts: [42] },
  // The same length limits @hyfib/config enforces, so the guard never accepts an entry the operator cannot set.
  { hosts: [`${"a".repeat(64)}.corp`] },
  { hosts: [Array.from({ length: 64 }, () => "abc").join(".")] }
];

for (const allowlist of INVALID_ALLOWLISTS) {
  test(`an invalid allowlist throws rather than being ignored: ${JSON.stringify(allowlist)}`, () => {
    assert.throws(() => validateOutboundUrl("https://hooks.example.com/", { allowlist }), /allowlist/);
    assert.throws(() => createGuardedLookup({ allowlist }), /allowlist/);
    assert.throws(() => createOutboundFetch({ allowlist }), /allowlist/);
  });
}

// ─── End to end through createOutboundFetch (loopback receiver, injected DNS) ─

async function startReceiver() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

test("createOutboundFetch delivers to an internal receiver only with both a host and an address entry", async () => {
  const receiver = await startReceiver();
  try {
    const calls = [];
    const resolve = async (hostname) => {
      calls.push(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const url = `http://receiver.corp:${receiver.port}/hooks?token=abc`;

    await assert.rejects(
      createOutboundFetch({ resolve, allowlist: { hosts: ["receiver.corp"] } })(url, { method: "POST", body: "1" }),
      (error) => error instanceof OutboundUrlBlockedError && error.remedy === "address"
    );
    await assert.rejects(
      createOutboundFetch({ resolve, allowlist: { cidrs: ["127.0.0.1/32"] } })(url, { method: "POST", body: "2" }),
      (error) => error instanceof OutboundUrlBlockedError && error.remedy === "host"
    );
    assert.equal(receiver.requests.length, 0, "neither single knob reaches the receiver");
    assert.deepEqual(calls, ["receiver.corp"], "the CIDR-only case is refused before any resolution");

    calls.length = 0;
    const both = createOutboundFetch({ resolve, allowlist: { hosts: ["receiver.corp"], cidrs: ["127.0.0.1/32"] } });
    const response = await both(url, { method: "POST", body: "3" });
    assert.deepEqual(response, { ok: true, status: 200 });
    assert.deepEqual(calls, ["receiver.corp"], "one resolution per connection: nothing left to rebind");
    assert.deepEqual(
      receiver.requests.map((r) => [r.url, r.body]),
      [["/hooks?token=abc", "3"]]
    );
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch with an allowlist still re-vets every request (DNS rebinding to metadata is refused)", async () => {
  const receiver = await startReceiver();
  try {
    const answers = ["127.0.0.1", "169.254.169.254", "10.1.2.3"];
    const fetchImpl = createOutboundFetch({
      resolve: async () => [{ address: answers.shift(), family: 4 }],
      allowlist: { hosts: ["receiver.corp"], cidrs: ["127.0.0.1/32", "0.0.0.0/0"] }
    });
    const url = `http://receiver.corp:${receiver.port}/hook`;
    assert.equal((await fetchImpl(url, { method: "POST", body: "1" })).ok, true);
    await assert.rejects(
      fetchImpl(url, { method: "POST", body: "2" }),
      (error) => error instanceof OutboundUrlBlockedError && error.remedy === undefined
    );
    assert.equal(receiver.requests.length, 1);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch connects to an allowlisted IP literal without consulting the resolver", async () => {
  const receiver = await startReceiver();
  try {
    const calls = [];
    const fetchImpl = createOutboundFetch({
      resolve: async (hostname) => {
        calls.push(hostname);
        return [];
      },
      allowlist: { cidrs: ["127.0.0.1"] }
    });
    const response = await fetchImpl(`http://127.0.0.1:${receiver.port}/hook`, { method: "POST", body: "{}" });
    assert.deepEqual(response, { ok: true, status: 200 });
    assert.deepEqual(calls, []);
    await assert.rejects(
      createOutboundFetch({ allowlist: { cidrs: ["0.0.0.0/0"] } })(`http://127.0.0.1:${receiver.port}/hook`, {}),
      (error) => error instanceof OutboundUrlBlockedError && error.remedy === "address"
    );
    assert.equal(receiver.requests.length, 1);
  } finally {
    await receiver.close();
  }
});

test("a validation failure reports its remedy: host for names, address for addresses, none otherwise", () => {
  assert.equal(validateOutboundUrl("http://hooks.corp/").remedy, "host");
  assert.equal(validateOutboundUrl("http://postgres:5432/").remedy, "host");
  assert.equal(validateOutboundUrl("http://10.0.0.1/").remedy, "address");
  assert.equal(validateOutboundUrl("http://127.0.0.1/").remedy, "address");
  assert.equal(validateOutboundUrl("http://[fd00::1]/").remedy, "address");
  for (const url of [
    "http://169.254.169.254/",
    "http://[fe80::1]/",
    "file:///etc/passwd",
    "https://u:p@hooks.example.com/",
    "http://localhost../",
    "not a url",
    ""
  ]) {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.remedy, undefined, url);
    assert.equal("remedy" in result, false, `${url}: no remedy key when nothing can be allowlisted`);
  }
});

test("IPv6 spellings of an IPv4 loopback address are never offered as allowlistable", async () => {
  for (const ip of ["::ffff:127.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1"]) {
    const saved = validateOutboundUrl(`http://[${ip}]/`, { allowlist: { cidrs: ["::/0"] } });
    assert.equal(saved.ok, false, ip);
    assert.equal(saved.remedy, undefined, ip);
    const lookup = createGuardedLookup({
      allowlist: { cidrs: ["::/0"] },
      resolve: async () => [{ address: ip, family: 6 }]
    });
    const { error } = await lookupAsync(lookup, "receiver.example.com");
    assert.ok(error instanceof OutboundUrlBlockedError, ip);
    assert.equal(error.remedy, undefined, ip);
  }
});

// ─── Cloud metadata outside link-local: the hard floor too ──────────────────
//
// IPv6 metadata endpoints are unique-local (fc00::/7), not link-local, and two IPv4 ones sit in CGNAT and
// 192.0.0.0/24 — all otherwise allowlistable space. Each must stay refused under every wide range an operator might
// list (and under an exact entry for itself), as a URL literal at save time and as a resolved address at connect
// time, alone or hidden in a mixed answer beside an address the allowlist does admit, and never with a remedy.

const METADATA_ENDPOINTS = [
  ["fd00:ec2::254", "AWS IMDS (IPv6)"],
  ["fd20:ce::254", "GCP metadata server (IPv6)"],
  ["fd00:c1::a9fe:a9fe", "Oracle OCI IMDS (IPv6)"],
  ["100.100.100.200", "Alibaba Cloud ECS metadata"],
  ["192.0.0.192", "Oracle Cloud Classic metadata"]
];

/** [cidrs, an address those cidrs DO admit: the positive control, and the other half of the mixed answer] */
const WIDE_ALLOWLISTS = [
  [["::/0"], "fd00:1::5"],
  [["fc00::/7"], "fd00:1::5"],
  [["fd00::/8"], "fd00:1::5"],
  [["0.0.0.0/0"], "10.1.2.3"],
  [["100.64.0.0/10"], "100.64.0.1"],
  [["192.0.0.0/24"], "192.0.0.1"],
  [["0.0.0.0/0", "::/0"], "10.1.2.3"]
];

const familyOf = (ip) => (ip.includes(":") ? 6 : 4);
const literalUrl = (ip) => (ip.includes(":") ? `http://[${ip}]/opc/v2/instance/` : `http://${ip}/latest/meta-data/`);

for (const [ip, label] of METADATA_ENDPOINTS) {
  for (const [cidrs, admitted] of [...WIDE_ALLOWLISTS, [[ip], "8.8.8.8"]]) {
    test(`metadata ${label} (${ip}) stays blocked under ${JSON.stringify(cidrs)}: save, connect and mixed answer`, async () => {
      assert.equal(isHardBlockedAddress(ip), true);
      const allowlist = { cidrs };

      const saved = validateOutboundUrl(literalUrl(ip), { allowlist });
      assert.equal(saved.ok, false, `${literalUrl(ip)} was allowed`);
      assert.equal("remedy" in saved, false, "never offered as allowlistable");

      // Positive control: the allowlist is live and does admit its companion address.
      const control = createGuardedLookup({
        allowlist,
        resolve: async () => [{ address: admitted, family: familyOf(admitted) }]
      });
      assert.equal((await lookupAsync(control, "receiver.example.com")).error, null, `${admitted} control`);

      for (const answers of [
        [{ address: ip, family: familyOf(ip) }],
        [
          { address: admitted, family: familyOf(admitted) },
          { address: ip, family: familyOf(ip) }
        ],
        [
          { address: ip, family: familyOf(ip) },
          { address: admitted, family: familyOf(admitted) }
        ]
      ]) {
        const lookup = createGuardedLookup({ allowlist, resolve: async () => answers });
        for (const options of [{}, { all: true }]) {
          const { error, address } = await lookupAsync(lookup, "receiver.example.com", options);
          assert.ok(error instanceof OutboundUrlBlockedError, `${JSON.stringify(answers)} was handed to the socket`);
          assert.equal(error.remedy, undefined, JSON.stringify(answers));
          assert.equal(address, undefined);
        }
      }
    });
  }
}

test("every spelling of a metadata address is the same hard-floor address", () => {
  for (const ip of [
    "FD00:EC2::254",
    "fd00:ec2:0:0:0:0:0:254",
    "fd00:0ec2::0254",
    "fd20:ce:0::254",
    "fd00:c1::169.254.169.254",
    "fd00:ec2::254%eth0",
    "::ffff:100.100.100.200",
    "64:ff9b::6464:64c8",
    "2002:6464:64c8::1",
    "::ffff:192.0.0.192",
    "64:ff9b::c000:c0"
  ]) {
    assert.equal(isHardBlockedAddress(ip), true, ip);
  }
  for (const url of ["http://[FD00:EC2::254]/", "http://[fd00:c1::169.254.169.254]/", "http://1684301000/"]) {
    const saved = validateOutboundUrl(url, { allowlist: EVERYTHING });
    assert.equal(saved.ok, false, url);
    assert.equal("remedy" in saved, false, url);
  }
});

test("neighbours of the metadata addresses are not the hard floor (the floor is exact /32 and /128 entries)", () => {
  for (const ip of [
    "fd00:ec2::253",
    "fd00:ec2::255",
    "fd20:ce::253",
    "fd00:c1::a9fe:a9ff",
    "100.100.100.201",
    "192.0.0.193"
  ]) {
    assert.equal(isHardBlockedAddress(ip), false, ip);
    assert.equal(validateOutboundUrl(literalUrl(ip), { allowlist: EVERYTHING }).ok, true, ip);
  }
});

// ─── Remedies: every one offered works; none is offered when nothing can ────
//
// The operator follows the hint literally: remedy "host" -> list the URL's host name; remedy "address" -> list
// exactly the addresses the refusal names. Following it must turn the refusal into a success. When no remedy is
// offered, even the widest allowlist that can be written (plus an exact entry for every address involved) must not.

/** The widest allowlist the guard accepts for these names and addresses: entries it would reject are left out. */
function widestAllowlist({ host, addresses = [] }) {
  const cidrs = ["0.0.0.0/0", "::/0", ...addresses];
  const allowlist = { hosts: [], hostSuffixes: [], cidrs };
  if (host) {
    try {
      validateOutboundUrl("https://hooks.example.com/", { allowlist: { hosts: [host] } });
      allowlist.hosts.push(host);
    } catch {
      // Not a host name an allowlist entry can spell, so it cannot be listed at all.
    }
  }
  return allowlist;
}

const SAVE_REMEDY_CORPUS = [
  // [url, expected remedy]
  ["http://hooks.corp/", "host"],
  ["http://postgres:5432/", "host"],
  ["http://localhost/", "host"],
  ["http://my_service/", "host"],
  ["http://HOOKS.Corp./", "host"],
  [`http://${"a".repeat(63)}.corp/`, "host"],
  ["http://10.0.0.1/", "address"],
  ["http://127.0.0.1/", "address"],
  ["http://[::1]/", "address"],
  ["http://[fd00::1]/", "address"],
  ["http://[::ffff:10.0.0.1]/", "address"],
  ["http://[64:ff9b:1::a00:1]/", "address"],
  ["http://[2001:db8::1]/", "address"],
  ["http://100.64.0.1/", "address"],
  ["http://192.0.0.1/", "address"],
  ["http://169.254.169.254/", undefined],
  ["http://[fe80::1]/", undefined],
  ["http://[::ffff:127.0.0.1]/", undefined],
  ["http://[fd00:ec2::254]/", undefined],
  ["http://100.100.100.200/", undefined],
  // Names no allowlist entry can spell (the config parser rejects them, so the app would not even start).
  ["http://a!b/", undefined],
  ["http://hooks~x.corp/", undefined],
  ["http://a,b.corp/", undefined],
  [`http://${"a".repeat(64)}.corp/`, undefined],
  [`http://${Array.from({ length: 64 }, () => "abc").join(".")}.corp/`, undefined],
  ["file:///etc/passwd", undefined],
  ["https://u:p@hooks.corp/", undefined],
  ["http://localhost../", undefined]
];

for (const [url, expected] of SAVE_REMEDY_CORPUS) {
  test(`save-time remedy for ${url.length > 70 ? `${url.slice(0, 70)}…` : url} is ${expected ?? "absent"} and ${expected ? "works" : "true"}`, () => {
    const refused = validateOutboundUrl(url);
    assert.equal(refused.ok, false, url);
    assert.equal(refused.remedy, expected);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    const hostname = parsed?.hostname ?? "";
    const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    if (expected === "host") {
      assert.equal(validateOutboundUrl(url, { allowlist: { hosts: [bare] } }).ok, true, "following the host remedy");
    } else if (expected === "address") {
      assert.equal(validateOutboundUrl(url, { allowlist: { cidrs: [bare] } }).ok, true, "following the address remedy");
    } else {
      assert.equal("remedy" in refused, false);
      const addresses = /^[\d.]+$/.test(bare) || bare.includes(":") ? [bare] : [];
      const widest = widestAllowlist({ host: addresses.length === 0 ? bare : undefined, addresses });
      assert.equal(validateOutboundUrl(url, { allowlist: widest }).ok, false, `${JSON.stringify(widest)} admitted it`);
    }
  });
}

const CONNECT_REMEDY_CORPUS = [
  // [answers, expected remedy]
  [["10.9.9.9"], "address"],
  [["127.0.0.1"], "address"],
  [["::1"], "address"],
  [["fd00::1", "10.0.0.1"], "address"],
  [["10.9.9.9", "10.9.9.8"], "address"],
  [["8.8.8.8", "10.9.9.9"], "address"],
  [["169.254.169.254"], undefined],
  [["10.9.9.9", "169.254.169.254"], undefined],
  [["169.254.169.254", "10.9.9.9"], undefined],
  [["10.9.9.9", "::ffff:127.0.0.1"], undefined],
  [["10.9.9.9", "fd00:ec2::254"], undefined],
  [["fd00::1", "fd00:c1::a9fe:a9fe"], undefined]
];

for (const [ips, expected] of CONNECT_REMEDY_CORPUS) {
  test(`connect-time remedy for an answer ${JSON.stringify(ips)} is ${expected ?? "absent"} and ${expected ? "works" : "true"}`, async () => {
    const answers = ips.map((address) => ({ address, family: familyOf(address) }));
    const resolve = async () => answers;
    const { error } = await lookupAsync(createGuardedLookup({ resolve }), "receiver.example.com", { all: true });
    assert.ok(error instanceof OutboundUrlBlockedError);
    assert.equal(error.remedy, expected, error.message);
    if (expected === "address") {
      // Exactly the addresses the refusal names — the operator's only information.
      const named = ips.filter((ip) => error.message.includes(`${ip},`) || error.message.includes(`${ip})`));
      assert.ok(named.length > 0, error.message);
      const followed = createGuardedLookup({ resolve, allowlist: { cidrs: named } });
      const retry = await lookupAsync(followed, "receiver.example.com", { all: true });
      assert.equal(retry.error, null, `listing ${JSON.stringify(named)} (from "${error.message}") did not help`);
    } else {
      const widest = createGuardedLookup({ resolve, allowlist: widestAllowlist({ addresses: ips }) });
      const retry = await lookupAsync(widest, "receiver.example.com", { all: true });
      assert.ok(retry.error instanceof OutboundUrlBlockedError, "the widest allowlist admitted it");
    }
  });
}

test("a connect-time refusal names every refused address, and only refused ones", async () => {
  const lookup = createGuardedLookup({
    resolve: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.9.9.9", family: 4 },
      { address: "10.9.9.8", family: 4 },
      { address: "10.9.9.9", family: 4 }
    ]
  });
  const { error } = await lookupAsync(lookup, "receiver.example.com", { all: true });
  assert.equal(error.message, "receiver.example.com resolves to blocked addresses (10.9.9.9, 10.9.9.8)");

  const single = createGuardedLookup({ resolve: async () => [{ address: "10.9.9.9", family: 4 }] });
  assert.equal(
    (await lookupAsync(single, "receiver.example.com")).error.message,
    "receiver.example.com resolves to a blocked address (10.9.9.9)",
    "the single-address message is unchanged"
  );

  const many = Array.from({ length: 12 }, (_, index) => ({ address: `10.0.0.${index + 1}`, family: 4 }));
  const flood = createGuardedLookup({ resolve: async () => many });
  const flooded = (await lookupAsync(flood, "receiver.example.com")).error;
  assert.match(flooded.message, /\(10\.0\.0\.1, .*10\.0\.0\.8 and 4 more\)$/, "a huge answer cannot flood the log");
  assert.equal(flooded.remedy, undefined, "addresses the refusal cannot name cannot be listed from it");
});
