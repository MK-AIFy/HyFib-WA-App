import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import dns from "node:dns";
import { setTimeout as delay } from "node:timers/promises";
import {
  OUTBOUND_URL_MAX_LENGTH,
  OutboundUrlBlockedError,
  createGuardedLookup,
  createOutboundFetch,
  isPrivateOrReservedAddress,
  validateOutboundUrl
} from "../dist/index.js";

/**
 * The outbound-URL guard behind tenant-configured webhooks (status_callback_url). Save-time validation is
 * synchronous and purely syntactic; the connect-time guard resolves the name once, vets every address and
 * hands only the vetted address to the socket, so a DNS answer that changes between check and connect
 * (rebinding) has nothing to exploit. No real DNS is used here: every resolver is injected.
 */

// ─── validateOutboundUrl: what a tenant admin may save ──────────────────────

const ALLOWED = [
  "https://hooks.example.com/hyfib",
  "http://cb.example.com:8080/x?y=1",
  "https://sub.domain.co.uk/path#frag",
  "https://93.184.216.34/h",
  "https://[2606:4700:4700::1111]/h",
  "  https://hooks.example.com/padded  ",
  // One trailing dot is the absolute (root-anchored) spelling of a public name and stays allowed.
  "https://hooks.example.com./fqdn"
];

for (const url of ALLOWED) {
  test(`validateOutboundUrl accepts a public URL: ${url.trim()}`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.url instanceof URL);
  });
}

const NOT_A_URL = [
  [undefined, "absent"],
  [null, "null"],
  [42, "a number"],
  [{ href: "https://example.com" }, "an object"],
  ["", "empty"],
  ["   ", "whitespace only"],
  ["not a url", "unparseable"],
  ["//example.com/x", "scheme-relative"],
  ["https://", "no host"],
  [`https://example.com/${"a".repeat(OUTBOUND_URL_MAX_LENGTH)}`, "overlong"]
];

for (const [input, label] of NOT_A_URL) {
  test(`validateOutboundUrl rejects ${label} input`, () => {
    const result = validateOutboundUrl(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
  });
}

const BAD_SCHEMES = [
  "ftp://example.com/",
  "file:///etc/passwd",
  "gopher://example.com:70/_x",
  "javascript:alert(1)",
  "data:text/plain,hi",
  "ws://example.com/socket",
  "dict://example.com:11211/stat"
];

for (const url of BAD_SCHEMES) {
  test(`validateOutboundUrl rejects a non-http(s) scheme: ${url}`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false);
    assert.match(result.error, /http or https/);
  });
}

const USERINFO = ["https://user:pass@example.com/", "https://user@example.com/", "http://127.0.0.1:80@example.com/"];

for (const url of USERINFO) {
  test(`validateOutboundUrl rejects embedded credentials: ${url}`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false);
    assert.match(result.error, /credentials/);
  });
}

/** Every IPv4 range the guard must refuse, with both edges where the edge is meaningful. */
const PRIVATE_V4_LITERALS = [
  ["0.0.0.0", "0.0.0.0/8 (this network)"],
  ["0.255.255.255", "0.0.0.0/8 upper edge"],
  ["10.0.0.1", "10/8"],
  ["10.255.255.255", "10/8 upper edge"],
  ["100.64.0.0", "100.64/10 (CGNAT) lower edge"],
  ["100.127.255.255", "100.64/10 upper edge"],
  ["127.0.0.1", "127/8 loopback"],
  ["127.255.255.254", "127/8 upper"],
  ["169.254.169.254", "169.254/16 cloud metadata"],
  ["169.254.0.1", "169.254/16 link-local"],
  ["172.16.0.0", "172.16/12 lower edge"],
  ["172.31.255.255", "172.16/12 upper edge"],
  ["192.0.0.1", "192.0.0/24 (IETF protocol assignments)"],
  ["192.0.0.170", "192.0.0/24 NAT64 discovery"],
  ["192.0.2.1", "192.0.2/24 TEST-NET-1"],
  ["192.168.0.1", "192.168/16"],
  ["192.168.255.255", "192.168/16 upper edge"],
  ["198.18.0.0", "198.18/15 benchmarking lower edge"],
  ["198.19.255.255", "198.18/15 upper edge"],
  ["198.51.100.7", "198.51.100/24 TEST-NET-2"],
  ["203.0.113.9", "203.0.113/24 TEST-NET-3"],
  ["224.0.0.1", "224/4 multicast"],
  ["239.255.255.250", "224/4 multicast (SSDP)"],
  ["240.0.0.1", "240/4 reserved"],
  ["255.255.255.255", "limited broadcast"]
];

for (const [ip, label] of PRIVATE_V4_LITERALS) {
  test(`validateOutboundUrl rejects an IPv4 literal in ${label}: ${ip}`, () => {
    const result = validateOutboundUrl(`http://${ip}/hook`);
    assert.equal(result.ok, false);
    assert.match(result.error, /private|reserved/);
  });
}

/**
 * Alternate spellings the WHATWG URL parser normalises to a dotted quad before any request is made — the
 * classic filter bypasses. Each must be refused exactly like its canonical form.
 */
const V4_BYPASS_FORMS = [
  ["http://2130706433/", "decimal 127.0.0.1"],
  ["http://0x7f000001/", "hex 127.0.0.1"],
  ["http://017700000001/", "octal 127.0.0.1"],
  ["http://0x7f.0.0.1/", "mixed hex octet"],
  ["http://0177.0.0.1/", "octal octet"],
  ["http://127.1/", "short form 127.1"],
  ["http://127.0.1/", "short form 127.0.1"],
  ["http://0/", "bare 0"],
  ["http://127.0.0.1./", "trailing dot"],
  ["http://0xa9fea9fe/latest/meta-data/", "hex 169.254.169.254"],
  ["http://2852039166/latest/meta-data/", "decimal 169.254.169.254"],
  ["http://0251.0376.0251.0376/", "octal 169.254.169.254"],
  ["http://１２７.０.０.１/", "full-width digits 127.0.0.1"],
  ["http://0xA.0.0.1/", "hex 10.0.0.1"],
  ["http://3232235777/", "decimal 192.168.1.1"]
];

for (const [url, label] of V4_BYPASS_FORMS) {
  test(`validateOutboundUrl rejects the ${label} bypass form`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false, `${url} was accepted`);
    assert.match(result.error, /private|reserved/);
  });
}

const PRIVATE_V6_LITERALS = [
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback, long form"],
  ["::", "unspecified"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback (dotted)"],
  ["::ffff:7f00:1", "IPv4-mapped loopback (hex)"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ["::ffff:8.8.8.8", "IPv4-mapped public (mapped form is never a legitimate target)"],
  ["::127.0.0.1", "IPv4-compatible (deprecated)"],
  ["fc00::1", "unique-local fc00::/7"],
  ["fd12:3456:789a::1", "unique-local fd00::/8"],
  ["fe80::1", "link-local fe80::/10"],
  ["febf:ffff::1", "link-local upper edge"],
  ["fec0::1", "site-local (deprecated)"],
  ["ff02::1", "multicast"],
  ["100::1", "discard-only 100::/64"],
  ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
  ["64:ff9b::a9fe:a9fe", "NAT64 of 169.254.169.254"],
  ["64:ff9b:1::1", "local-use NAT64 64:ff9b:1::/48"],
  ["2002:7f00:1::", "6to4 of 127.0.0.1"],
  ["2002:a9fe:a9fe::1", "6to4 of 169.254.169.254"],
  ["2001::1", "Teredo / IETF protocol assignments 2001::/23"],
  ["2001:db8::1", "documentation 2001:db8::/32"],
  ["3fff::1", "documentation 3fff::/20"]
];

for (const [ip, label] of PRIVATE_V6_LITERALS) {
  test(`validateOutboundUrl rejects an IPv6 literal (${label}): [${ip}]`, () => {
    const result = validateOutboundUrl(`http://[${ip}]:8080/hook`);
    assert.equal(result.ok, false, `[${ip}] was accepted`);
    assert.match(result.error, /private|reserved/);
  });
}

test("validateOutboundUrl rejects an IPv6 zone id (the URL parser refuses it)", () => {
  assert.equal(validateOutboundUrl("http://[fe80::1%25eth0]/").ok, false);
});

const INTERNAL_NAMES = [
  "http://localhost/",
  "http://LOCALHOST:8080/",
  "http://localhost./",
  "http://api.localhost/",
  "http://printer.local/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://metadata.google.internal./computeMetadata/v1/",
  "http://host.docker.internal:5432/",
  "http://foo.localdomain/",
  "http://router.home.arpa/",
  "http://postgres:5432/",
  "http://rabbitmq:15672/api/overview",
  "http://metadata/computeMetadata/v1/"
];

for (const url of INTERNAL_NAMES) {
  test(`validateOutboundUrl rejects an internal host name: ${url}`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false, `${url} was accepted`);
    assert.match(result.error, /internal/);
  });
}

/**
 * Only the root label may be empty, and only as the single trailing dot of an absolute name ("example.com.").
 * Stripping just that one dot used to leave "localhost." behind for "localhost..", which no internal-name
 * suffix matched, so the save-time check passed a name delivery then refused. Any other empty label is not a
 * DNS name at all, so it is refused outright rather than normalised (how a resolver treats "a..b" varies).
 */
const EMPTY_LABEL_HOSTS = [
  ["http://localhost../", "localhost with two trailing dots"],
  ["http://foo.localhost../", "a .localhost subdomain with two trailing dots"],
  ["http://metadata.google.internal../computeMetadata/v1/", "the GCE metadata name with two trailing dots"],
  ["http://127.0.0.1../", "a loopback quad with two trailing dots (the URL parser keeps it as a domain)"],
  ["http://a..b.com/", "an empty label in the middle"],
  ["http://localhost.../", "three trailing dots"],
  ["http://.example.com/", "a leading empty label"],
  ["http://../", "nothing but dots"]
];

for (const [url, label] of EMPTY_LABEL_HOSTS) {
  test(`validateOutboundUrl rejects a host with an empty label (${label}): ${url}`, () => {
    const result = validateOutboundUrl(url);
    assert.equal(result.ok, false, `${url} was accepted`);
    assert.match(result.error, /empty label/);
  });
}

// ─── isPrivateOrReservedAddress: the connect-time classifier ────────────────

const PUBLIC_ADDRESSES = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.0.1.0",
  "192.167.255.255",
  "192.169.0.0",
  "198.17.255.255",
  "198.20.0.0",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001:80b::200e",
  "64:ff9b::808:808",
  "2002:808:808::1"
];

for (const ip of PUBLIC_ADDRESSES) {
  test(`isPrivateOrReservedAddress treats ${ip} as public`, () => {
    assert.equal(isPrivateOrReservedAddress(ip), false);
  });
}

for (const [ip, label] of [...PRIVATE_V4_LITERALS, ...PRIVATE_V6_LITERALS]) {
  test(`isPrivateOrReservedAddress flags ${label}: ${ip}`, () => {
    assert.equal(isPrivateOrReservedAddress(ip), true);
  });
}

test("isPrivateOrReservedAddress strips an IPv6 zone id before classifying", () => {
  assert.equal(isPrivateOrReservedAddress("fe80::1%eth0"), true);
});

test("isPrivateOrReservedAddress fails closed on anything that is not an IP address", () => {
  for (const junk of ["", "localhost", "example.com", "999.1.1.1", "1.2.3", "01.2.3.4", "::gg", "1.2.3.4.5", "[::1]"]) {
    assert.equal(isPrivateOrReservedAddress(junk), true, `${JSON.stringify(junk)} was treated as public`);
  }
});

// ─── createGuardedLookup: the net.connect lookup hook ───────────────────────

function lookupAsync(lookup, hostname, options) {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

test("createGuardedLookup hands a public answer to the socket in both callback shapes", async () => {
  const lookup = createGuardedLookup({ resolve: async () => [{ address: "93.184.216.34", family: 4 }] });

  const single = await lookupAsync(lookup, "hooks.example.com", {});
  assert.equal(single.error, null);
  assert.equal(single.address, "93.184.216.34");
  assert.equal(single.family, 4);

  const all = await lookupAsync(lookup, "hooks.example.com", { all: true });
  assert.equal(all.error, null);
  assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);
});

test("createGuardedLookup refuses a name that resolves to a private address", async () => {
  const lookup = createGuardedLookup({ resolve: async () => [{ address: "169.254.169.254", family: 4 }] });
  const { error, address } = await lookupAsync(lookup, "rebind.example.com", {});
  assert.ok(error instanceof OutboundUrlBlockedError);
  assert.equal(error.code, "OUTBOUND_URL_BLOCKED");
  assert.equal(address, undefined);
});

test("createGuardedLookup refuses the whole answer when any address is private (mixed A records)", async () => {
  const lookup = createGuardedLookup({
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 }
    ]
  });
  const { error } = await lookupAsync(lookup, "mixed.example.com", { all: true });
  assert.ok(error instanceof OutboundUrlBlockedError);
});

test("createGuardedLookup refuses a private IPv6 answer", async () => {
  const lookup = createGuardedLookup({ resolve: async () => [{ address: "::1", family: 6 }] });
  const { error } = await lookupAsync(lookup, "v6.example.com", {});
  assert.ok(error instanceof OutboundUrlBlockedError);
});

test("createGuardedLookup reports an empty answer as ENOTFOUND and passes resolver errors through", async () => {
  const empty = createGuardedLookup({ resolve: async () => [] });
  const emptyResult = await lookupAsync(empty, "nothing.example.com", {});
  assert.equal(emptyResult.error.code, "ENOTFOUND");

  const failing = createGuardedLookup({
    resolve: async () => {
      throw Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" });
    }
  });
  const failingResult = await lookupAsync(failing, "slow.example.com", {});
  assert.equal(failingResult.error.code, "ETIMEOUT");
  assert.equal(failingResult.error instanceof OutboundUrlBlockedError, false);
});

// ─── createOutboundFetch: the request transport, against a real local server ─

/**
 * A loopback receiver that records every request. The guard would refuse 127.0.0.1, so the "allowed" cases
 * inject a classifier that admits loopback only and a resolver that maps the test host names to it — the
 * real node:http connection path still runs end to end.
 */
async function startReceiver(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

const LOOPBACK_ONLY = (ip) => ip !== "127.0.0.1";
const toLoopback = (calls) => async (hostname) => {
  calls.push(hostname);
  return [{ address: "127.0.0.1", family: 4 }];
};

test("createOutboundFetch refuses a host name that resolves to loopback and never connects", async () => {
  const receiver = await startReceiver((_req, res) => res.end("ok"));
  try {
    const calls = [];
    const fetchImpl = createOutboundFetch({ resolve: toLoopback(calls) });
    await assert.rejects(
      fetchImpl(`http://rebind.example.com:${receiver.port}/hook`, { method: "POST", body: "{}" }),
      (error) => error instanceof OutboundUrlBlockedError
    );
    assert.deepEqual(calls, ["rebind.example.com"]);
    assert.equal(receiver.requests.length, 0);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch refuses a private IP literal before any connection (net.connect skips lookup for IPs)", async () => {
  const receiver = await startReceiver((_req, res) => res.end("ok"));
  try {
    const calls = [];
    const fetchImpl = createOutboundFetch({ resolve: toLoopback(calls) });
    await assert.rejects(
      fetchImpl(`http://127.0.0.1:${receiver.port}/hook`, { method: "POST", body: "{}" }),
      (error) => error instanceof OutboundUrlBlockedError
    );
    await assert.rejects(
      fetchImpl(`http://2130706433:${receiver.port}/hook`, { method: "POST", body: "{}" }),
      (error) => error instanceof OutboundUrlBlockedError
    );
    assert.equal(calls.length, 0);
    assert.equal(receiver.requests.length, 0);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch refuses an empty-label host by policy, before any resolution — save and delivery agree", async () => {
  const receiver = await startReceiver((_req, res) => res.end("ok"));
  try {
    const calls = [];
    // Even a classifier that admits loopback must not get the chance: the policy check runs first.
    const fetchImpl = createOutboundFetch({ resolve: toLoopback(calls), isBlockedAddress: LOOPBACK_ONLY });
    for (const host of ["localhost..", "metadata.google.internal..", "a..b.com"]) {
      await assert.rejects(
        fetchImpl(`http://${host}:${receiver.port}/hook`, { method: "POST", body: "{}" }),
        (error) => error instanceof OutboundUrlBlockedError && /empty label/.test(error.message),
        host
      );
    }
    assert.deepEqual(calls, [], "no name was handed to the resolver");
    assert.equal(receiver.requests.length, 0);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch with no deps vets what the OS resolver returns (no network: dns.promises.lookup is stubbed)", async () => {
  const receiver = await startReceiver((_req, res) => res.end("ok"));
  const original = dns.promises.lookup;
  const calls = [];
  dns.promises.lookup = async (hostname, options) => {
    calls.push({ hostname, all: options?.all });
    return [{ address: "127.0.0.1", family: 4 }];
  };
  try {
    await assert.rejects(
      createOutboundFetch()(`http://127.0.0.1.nip.io:${receiver.port}/hook`, { method: "POST", body: "{}" }),
      (error) => error instanceof OutboundUrlBlockedError && /127\.0\.0\.1/.test(error.message)
    );
    assert.deepEqual(calls, [{ hostname: "127.0.0.1.nip.io", all: true }]);
    assert.equal(receiver.requests.length, 0);
  } finally {
    dns.promises.lookup = original;
    await receiver.close();
  }
});

test("createOutboundFetch applies the same guard on the https path", async () => {
  const calls = [];
  const fetchImpl = createOutboundFetch({
    resolve: async (hostname) => {
      calls.push(hostname);
      return [{ address: "10.1.2.3", family: 4 }];
    }
  });
  await assert.rejects(
    fetchImpl("https://internal-api.example.com/hook", { method: "POST", body: "{}" }),
    (error) => error instanceof OutboundUrlBlockedError
  );
  assert.deepEqual(calls, ["internal-api.example.com"]);
});

test("createOutboundFetch refuses non-http(s) schemes and embedded credentials", async () => {
  const fetchImpl = createOutboundFetch({ resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  await assert.rejects(fetchImpl("file:///etc/passwd", {}), (error) => error instanceof OutboundUrlBlockedError);
  await assert.rejects(
    fetchImpl("http://user:pw@hooks.example.com/", {}),
    (error) => error instanceof OutboundUrlBlockedError
  );
});

test("createOutboundFetch delivers to a vetted address with the caller's method, headers and exact body", async () => {
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 200;
    res.end("received");
  });
  try {
    const calls = [];
    const fetchImpl = createOutboundFetch({ resolve: toLoopback(calls), isBlockedAddress: LOOPBACK_ONLY });
    const body = JSON.stringify({ type: "message.status", data: { note: "héllo" } });
    const response = await fetchImpl(`http://receiver.example.com:${receiver.port}/hook?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hyfib-signature": "sha256=abc" },
      body,
      signal: AbortSignal.timeout(5_000)
    });

    assert.deepEqual(response, { ok: true, status: 200 });
    assert.deepEqual(calls, ["receiver.example.com"], "one resolution per connection — nothing left to rebind");
    assert.equal(receiver.requests.length, 1);
    const [received] = receiver.requests;
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/hook?x=1");
    assert.equal(received.headers.host, `receiver.example.com:${receiver.port}`);
    assert.equal(received.headers["content-type"], "application/json");
    assert.equal(received.headers["x-hyfib-signature"], "sha256=abc");
    assert.equal(received.headers["content-length"], String(Buffer.byteLength(body)));
    assert.equal(received.body, body);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch re-vets on every request: a later private answer is refused", async () => {
  const receiver = await startReceiver((_req, res) => res.end("ok"));
  try {
    const answers = ["127.0.0.1", "10.0.0.5"];
    const fetchImpl = createOutboundFetch({
      resolve: async () => [{ address: answers.shift(), family: 4 }],
      isBlockedAddress: LOOPBACK_ONLY
    });
    const url = `http://flip.example.com:${receiver.port}/hook`;
    assert.equal((await fetchImpl(url, { method: "POST", body: "1" })).ok, true);
    await assert.rejects(
      fetchImpl(url, { method: "POST", body: "2" }),
      (error) => error instanceof OutboundUrlBlockedError
    );
    assert.equal(receiver.requests.length, 1);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch never follows a redirect: the 3xx is returned and the target is never requested", async () => {
  const receiver = await startReceiver((req, res) => {
    if (req.url === "/hook") {
      res.statusCode = 302;
      res.setHeader("location", "/stolen");
      res.end();
      return;
    }
    res.end("should never be reached");
  });
  try {
    const fetchImpl = createOutboundFetch({ resolve: toLoopback([]), isBlockedAddress: LOOPBACK_ONLY });
    const response = await fetchImpl(`http://receiver.example.com:${receiver.port}/hook`, {
      method: "POST",
      body: "{}",
      redirect: "follow"
    });
    assert.deepEqual(response, { ok: false, status: 302 });
    assert.deepEqual(
      receiver.requests.map((r) => r.url),
      ["/hook"]
    );
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch reports a non-2xx status as not ok", async () => {
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 503;
    res.end("down");
  });
  try {
    const fetchImpl = createOutboundFetch({ resolve: toLoopback([]), isBlockedAddress: LOOPBACK_ONLY });
    const response = await fetchImpl(`http://receiver.example.com:${receiver.port}/hook`, { method: "POST" });
    assert.deepEqual(response, { ok: false, status: 503 });
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch honours the abort signal when the receiver never answers", async () => {
  const receiver = await startReceiver(() => {
    // Deliberately never respond.
  });
  try {
    const fetchImpl = createOutboundFetch({ resolve: toLoopback([]), isBlockedAddress: LOOPBACK_ONLY });
    const started = Date.now();
    await assert.rejects(
      fetchImpl(`http://receiver.example.com:${receiver.port}/hook`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(150)
      }),
      (error) => !(error instanceof OutboundUrlBlockedError)
    );
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await receiver.close();
  }
});

test("createOutboundFetch resolves on the status and closes the connection instead of draining a stalled body", async () => {
  let markClosed;
  const serverSocketClosed = new Promise((resolve) => (markClosed = resolve));
  const receiver = await startReceiver((req, res) => {
    req.socket.once("close", () => markClosed(Date.now()));
    // A slow receiver: the status line and headers promise a megabyte, a few bytes arrive, then nothing.
    res.writeHead(202, { "content-type": "text/plain", "content-length": String(1024 * 1024) });
    res.write("partial body, then silence");
  });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const caller = new AbortController();
  try {
    const fetchImpl = createOutboundFetch({ resolve: toLoopback([]), isBlockedAddress: LOOPBACK_ONLY });
    const started = Date.now();
    const response = await fetchImpl(`http://slow.example.com:${receiver.port}/hook`, {
      method: "POST",
      body: "{}",
      // The 5s backstop only turns a drain-until-end regression into a failure instead of a hang.
      signal: AbortSignal.any([caller.signal, AbortSignal.timeout(5_000)])
    });
    const resolvedAt = Date.now();
    assert.deepEqual(response, { ok: true, status: 202 });
    assert.ok(resolvedAt - started < 1_000, `resolved only after ${resolvedAt - started}ms`);

    // The per-request socket (agent:false) is torn down, so the receiver sees it close now — not when the
    // megabyte finally arrives or the delivery timeout fires.
    const closedAt = await Promise.race([serverSocketClosed, delay(2_000, undefined, { ref: false })]);
    assert.notEqual(closedAt, undefined, "the connection was still open 2s after the call resolved");
    assert.ok(closedAt - resolvedAt < 1_000, `connection closed ${closedAt - resolvedAt}ms after resolving`);

    // The caller's signal firing afterwards (its timeout, or a shutdown) must stay silent.
    caller.abort();
    await delay(50);
    assert.deepEqual(uncaught, [], "a late abort surfaced as an unhandled error");
  } finally {
    process.off("uncaughtException", onUncaught);
    await receiver.close();
  }
});
