import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "../../packages/shared-core/dist/index.js";
import * as config from "../../packages/config/dist/index.js";
import { auditRows, displayOrigin, parseRows, runAudit } from "../audit-status-callback-urls.mjs";
import { pathWithoutNode, runScript, SCRIPTS_DIR } from "./helpers.mjs";

/**
 * Pre-deploy, read-only audit of stored tenant webhook URLs (whatsapp_settings.status_callback_url) against the
 * outbound-URL guard and OUTBOUND_WEBHOOK_ALLOWLIST. The verdict logic is pure and runs here without a database or
 * DNS (resolvers are injected); the psql wrapper runs against the fake psql in fake-bin. Nothing printed may carry a
 * URL's path, query, fragment or credentials.
 */

const AUDITOR = fileURLToPath(new URL("../audit-status-callback-urls.mjs", import.meta.url));
const WRAPPER = join(SCRIPTS_DIR, "audit-status-callback-urls.sh");

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const T3 = "33333333-3333-3333-3333-333333333333";
const T4 = "44444444-4444-4444-4444-444444444444";

/** Anything in these URLs after the host must never be printed. */
const SECRET_BITS = /tok_SECRET|hunter2|s3cr3t-path|frag-secret|admin:/;

const hex = (url) => Buffer.from(url, "utf8").toString("hex");
const tsv = (rows) => rows.map(([tenant, url]) => `${tenant}\t${hex(url)}\n`).join("");

function resolverTo(map) {
  const calls = [];
  const resolve = async (hostname) => {
    calls.push(hostname);
    const answer = map[hostname];
    if (answer === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return [{ address: answer, family: answer.includes(":") ? 6 : 4 }];
  };
  return { calls, resolve };
}

function audit(rows, { allowlist = "", resolveHosts = false, resolve } = {}) {
  return runAudit({ input: tsv(rows), allowlistText: allowlist, resolveHosts, shared, config, resolve });
}

// ─── displayOrigin: the only part of a URL ever printed ─────────────────────

const ORIGINS = [
  ["https://hooks.example.com/s3cr3t-path?token=tok_SECRET#frag-secret", "https://hooks.example.com"],
  ["http://hooks.example.com:8443/x", "http://hooks.example.com:8443"],
  ["https://admin:hunter2@hooks.example.com/", "https://hooks.example.com"],
  ["  http://10.1.2.3:8080/tok_SECRET  ", "http://10.1.2.3:8080"],
  ["http://[fd00::1]:9000/tok_SECRET", "http://[fd00::1]:9000"],
  ["http://HOOKS.Corp./x", "http://hooks.corp."],
  ["file:///etc/s3cr3t-path", "file: (no host)"],
  ["javascript:alert('tok_SECRET')", "javascript: (no host)"],
  ["not a url tok_SECRET", "<not a valid URL>"],
  ["", "<not a valid URL>"]
];

for (const [raw, expected] of ORIGINS) {
  test(`displayOrigin prints scheme and host only: ${JSON.stringify(raw).slice(0, 50)}`, () => {
    assert.equal(displayOrigin(raw), expected);
  });
}

// ─── parseRows: tenant-id TAB hex(url), so a URL can never break a line ─────

test("parseRows decodes hex URLs, skips blank lines and tolerates CRLF", () => {
  const input = `${T1}\t${hex("https://a.example.com/x\ty\nz")}\r\n\n${T2}\t${hex("http://b.example.com")}\n`;
  assert.deepEqual(parseRows(input), [
    { tenantId: T1, url: "https://a.example.com/x\ty\nz" },
    { tenantId: T2, url: "http://b.example.com" }
  ]);
});

test("parseRows marks a line without a tab, or with a payload that is not hex, as unreadable without echoing it", () => {
  const rows = parseRows(`garbage-with-tok_SECRET\n${T1}\tnot-hex-tok_SECRET\n${T2}\tabc\n`);
  assert.deepEqual(rows, [
    { tenantId: "line 1", url: null },
    { tenantId: T1, url: null },
    { tenantId: T2, url: null }
  ]);
});

// ─── runAudit without DNS: the save-time rule (also re-checked on every delivery) ─

test("no stored URLs -> nothing to audit, exit 0", async () => {
  const result = await audit([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no status callback URLs stored/);
});

test("a public URL is ALLOWED and only its origin is printed", async () => {
  const result = await audit([[T1, "https://hooks.example.com/s3cr3t-path?token=tok_SECRET"]]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T1} +https://hooks\\.example\\.com$`, "m"));
  assert.doesNotMatch(result.stdout + result.stderr, SECRET_BITS);
});

test("internal receivers are BLOCKED-AT-SAVE without an allowlist, exit 1, each with the allowlist remedy", async () => {
  const result = await audit([
    [T1, "http://10.1.2.3:8080/s3cr3t-path?token=tok_SECRET"],
    [T2, "http://hooks.corp/s3cr3t-path"],
    [T3, "https://hooks.example.com/ok"]
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`^BLOCKED-AT-SAVE +${T1} +http://10\\.1\\.2\\.3:8080 .*private`, "m"));
  assert.match(result.stdout, new RegExp(`^BLOCKED-AT-SAVE +${T1} .*exact address to OUTBOUND_WEBHOOK_ALLOWLIST`, "m"));
  assert.match(result.stdout, new RegExp(`^BLOCKED-AT-SAVE +${T2} +http://hooks\\.corp .*internal name`, "m"));
  assert.match(result.stdout, new RegExp(`^BLOCKED-AT-SAVE +${T2} .*host name`, "m"));
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T3}`, "m"));
  assert.match(result.stdout, /3 configured: 1 allowed, 2 blocked at save, 0 blocked at delivery/);
  assert.doesNotMatch(result.stdout + result.stderr, SECRET_BITS);
});

test("the same receivers are ALLOWED when OUTBOUND_WEBHOOK_ALLOWLIST covers them (test before you set it)", async () => {
  const result = await audit(
    [
      [T1, "http://10.1.2.3:8080/s3cr3t-path"],
      [T2, "http://hooks.corp/s3cr3t-path"]
    ],
    { allowlist: "hooks.corp, 10.1.2.0/24" }
  );
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /allowlist: hooks\.corp, 10\.1\.2\.0\/24/);
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T1} +http://10\\.1\\.2\\.3:8080$`, "m"));
  assert.match(
    result.stdout,
    new RegExp(
      `^ALLOWED +${T2} +http://hooks\\.corp +host name allowlisted; its address is checked only with --resolve$`,
      "m"
    ),
    "a host entry lifts only the name check, so the report must not look like a complete pass"
  );
  assert.match(result.stdout, /NOTE: host names were not resolved/, "without --resolve the DNS rule is not applied");
});

test("--resolve drops the host-name caveat once the address has actually been vetted", async () => {
  const dns = resolverTo({ "hooks.corp": "10.1.2.3" });
  const result = await audit([[T2, "http://hooks.corp/s3cr3t-path"]], {
    allowlist: "hooks.corp, 10.1.2.0/24",
    resolveHosts: true,
    resolve: dns.resolve
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T2} +http://hooks\\.corp$`, "m"));
});

test("the hard floor is BLOCKED and reported as not allowlistable, even under 0.0.0.0/0", async () => {
  const result = await audit([[T1, "http://169.254.169.254/latest/meta-data/tok_SECRET"]], {
    allowlist: "0.0.0.0/0, ::/0"
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    new RegExp(`^BLOCKED-AT-SAVE +${T1} +http://169\\.254\\.169\\.254 .*cannot be allowlisted`, "m")
  );
});

test("scheme, credential and empty-label problems are BLOCKED and not allowlistable; nothing sensitive is printed", async () => {
  const result = await audit(
    [
      [T1, "file:///etc/s3cr3t-path"],
      [T2, "https://admin:hunter2@hooks.corp/x"],
      [T3, "http://hooks.corp../x"],
      [T4, "   "]
    ],
    { allowlist: "hooks.corp" }
  );
  assert.equal(result.code, 1);
  for (const tenant of [T1, T2, T3, T4]) {
    assert.match(result.stdout, new RegExp(`^BLOCKED-AT-SAVE +${tenant} .*cannot be allowlisted`, "m"), tenant);
  }
  assert.doesNotMatch(result.stdout + result.stderr, SECRET_BITS);
});

test("an invalid allowlist cannot be audited: exit 2 naming the entry, no verdicts printed", async () => {
  const result = await audit([[T1, "https://hooks.example.com/"]], { allowlist: "hooks.corp, 10.1.2.3/24" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /OUTBOUND_WEBHOOK_ALLOWLIST entry "10\.1\.2\.3\/24"/);
  assert.doesNotMatch(result.stdout, /ALLOWED|BLOCKED/);
});

test("an unreadable input line cannot be audited: exit 2, the line is never echoed", async () => {
  const result = await runAudit({
    input: `${T1}\t${hex("https://hooks.example.com/")}\ngarbage tok_SECRET\n`,
    allowlistText: "",
    resolveHosts: false,
    shared,
    config
  });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /UNREADABLE +line 2/);
  assert.doesNotMatch(result.stdout + result.stderr, SECRET_BITS);
});

// ─── runAudit --resolve: the connect-time rule, resolver injected ───────────

test("--resolve: an allowlisted host name whose address is not allowlisted is BLOCKED-AT-DELIVERY", async () => {
  const dns = resolverTo({ "hooks.corp": "10.1.2.3" });
  const result = await audit([[T1, "http://hooks.corp:8443/s3cr3t-path"]], {
    allowlist: "hooks.corp",
    resolveHosts: true,
    resolve: dns.resolve
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    new RegExp(`^BLOCKED-AT-DELIVERY +${T1} +http://hooks\\.corp:8443 .*10\\.1\\.2\\.3.*exact address`, "m")
  );
  assert.deepEqual(dns.calls, ["hooks.corp"]);
  assert.doesNotMatch(result.stdout, /NOTE: host names were not resolved/);
});

test("--resolve: host name AND address allowlisted -> ALLOWED, exit 0", async () => {
  const dns = resolverTo({ "hooks.corp": "10.1.2.3" });
  const result = await audit([[T1, "http://hooks.corp:8443/s3cr3t-path"]], {
    allowlist: "hooks.corp, 10.1.2.0/24",
    resolveHosts: true,
    resolve: dns.resolve
  });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T1}`, "m"));
});

test("--resolve: a public-looking name that resolves privately is caught; metadata is not allowlistable", async () => {
  const dns = resolverTo({ "cb.example.com": "10.9.9.9", "meta.example.com": "169.254.169.254" });
  const result = await audit(
    [
      [T1, "https://cb.example.com/x"],
      [T2, "https://meta.example.com/x"]
    ],
    { allowlist: "0.0.0.0/0", resolveHosts: true, resolve: dns.resolve }
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`^ALLOWED +${T1}`, "m"), "0.0.0.0/0 opens 10.9.9.9 (operator's choice)");
  assert.match(result.stdout, new RegExp(`^BLOCKED-AT-DELIVERY +${T2} .*cannot be allowlisted`, "m"));
});

test("--resolve: IP literals are judged by the save-time rule alone (no lookup, as net.connect does)", async () => {
  const dns = resolverTo({});
  const result = await audit([[T1, "http://10.1.2.3/x"]], {
    allowlist: "10.1.2.0/24",
    resolveHosts: true,
    resolve: dns.resolve
  });
  assert.equal(result.code, 0);
  assert.deepEqual(dns.calls, []);
});

test("--resolve: a name that does not resolve is UNRESOLVED (exit 3); a block still dominates (exit 1)", async () => {
  const onlyUnresolved = await audit([[T1, "https://gone.example.com/x"]], {
    resolveHosts: true,
    resolve: resolverTo({}).resolve
  });
  assert.equal(onlyUnresolved.code, 3);
  assert.match(onlyUnresolved.stdout, new RegExp(`^UNRESOLVED +${T1} +https://gone\\.example\\.com +ENOTFOUND`, "m"));

  const both = await audit(
    [
      [T1, "https://gone.example.com/x"],
      [T2, "http://10.0.0.1/x"]
    ],
    { resolveHosts: true, resolve: resolverTo({}).resolve }
  );
  assert.equal(both.code, 1);
});

test("auditRows returns structured verdicts (what the report is built from)", async () => {
  const allowlist = config.parseOutboundWebhookAllowlist("hooks.corp");
  const results = await auditRows(
    [
      { tenantId: T1, url: "http://hooks.corp/x?token=tok_SECRET" },
      { tenantId: T2, url: "http://10.0.0.1/" }
    ],
    { shared, allowlist, resolveHosts: false }
  );
  assert.deepEqual(results, [
    {
      tenantId: T1,
      origin: "http://hooks.corp",
      verdict: "allowed",
      note: "host name allowlisted; its address is checked only with --resolve"
    },
    {
      tenantId: T2,
      origin: "http://10.0.0.1",
      verdict: "blocked-at-save",
      reason: "URL must not point to a private, loopback, link-local or otherwise reserved address",
      remedy: "address"
    }
  ]);
});

// ─── The .mjs as a process (stdin in, report out) ───────────────────────────

function runCli(input, { allowlist, args = [] } = {}) {
  const { OUTBOUND_WEBHOOK_ALLOWLIST: _inherited, ...rest } = process.env;
  const env = allowlist === undefined ? rest : { ...rest, OUTBOUND_WEBHOOK_ALLOWLIST: allowlist };
  return spawnSync(process.execPath, [AUDITOR, ...args], { input, env, encoding: "utf8" });
}

test("CLI: rows on stdin, allowlist from the environment, exit code gates the deploy", () => {
  const input = tsv([[T1, "http://10.1.2.3/s3cr3t-path"]]);
  const blocked = runCli(input);
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /BLOCKED-AT-SAVE/);

  const allowed = runCli(input, { allowlist: "10.1.2.0/24" });
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.doesNotMatch(allowed.stdout + allowed.stderr + blocked.stdout, SECRET_BITS);
});

test("CLI: an unknown option is a usage error (exit 2)", () => {
  const result = runCli("", { args: ["--bogus"] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/i);
});

// ─── The psql wrapper (fake psql from fake-bin) ─────────────────────────────

function fixture(t, { rows = [], envFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "audit-callbacks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsFile = join(dir, "settings.tsv");
  writeFileSync(settingsFile, tsv(rows));
  const envPath = join(dir, "hyfib.env");
  if (envFile !== undefined) {
    writeFileSync(envPath, envFile);
  }
  const logPath = join(dir, "psql.log");
  return { settingsFile, envPath, logPath };
}

const out = (result) => result.stdout + result.stderr;

test("wrapper: a blocked stored URL fails the gate (exit 1) and prints the origin only", (t) => {
  const { settingsFile, envPath } = fixture(t, {
    rows: [
      [T1, "http://10.1.2.3/s3cr3t-path?token=tok_SECRET"],
      [T2, "https://hooks.example.com/x"]
    ]
  });
  const r = runScript(WRAPPER, ["testdb"], { env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath } });
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), new RegExp(`BLOCKED-AT-SAVE +${T1} +http://10\\.1\\.2\\.3 `));
  assert.match(out(r), new RegExp(`ALLOWED +${T2}`));
  assert.match(out(r), /docs\/runbooks\/outbound-webhook-allowlist\.md/);
  assert.doesNotMatch(out(r), SECRET_BITS);
});

test("wrapper: every psql call is read-only and the only statements are SELECTs", (t) => {
  const { settingsFile, envPath, logPath } = fixture(t, { rows: [[T1, "https://hooks.example.com/x"]] });
  const r = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath, FAKE_PSQL_LOG: logPath }
  });
  assert.equal(r.status, 0, out(r));
  const calls = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(calls.length, 2, calls.join("\n"));
  for (const call of calls) {
    const [pgoptions, argv] = call.split("|");
    assert.match(pgoptions, /default_transaction_read_only=on/, call);
    assert.match(argv, /-c SELECT |-tAc SELECT /, call);
    assert.doesNotMatch(argv, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i, call);
  }
  assert.match(calls[1], /FROM whatsapp_settings WHERE status_callback_url IS NOT NULL/);
});

test("wrapper: the allowlist is read from HYFIB_ENV_FILE when unset; an explicit (even empty) value wins", (t) => {
  const rows = [[T1, "http://hooks.corp/x"]];
  const { settingsFile, envPath } = fixture(t, { rows, envFile: 'OTHER=1\nOUTBOUND_WEBHOOK_ALLOWLIST="hooks.corp"\n' });

  const fromFile = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(fromFile.status, 0, out(fromFile));
  assert.match(out(fromFile), /allowlist: hooks\.corp/);

  const explicitEmpty = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath, OUTBOUND_WEBHOOK_ALLOWLIST: "" }
  });
  assert.equal(explicitEmpty.status, 1, out(explicitEmpty));
  assert.match(out(explicitEmpty), /BLOCKED-AT-SAVE/);
});

test("wrapper: an invalid allowlist cannot be audited (exit 2)", (t) => {
  const { settingsFile, envPath } = fixture(t, { rows: [[T1, "https://hooks.example.com/"]] });
  const r = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath, OUTBOUND_WEBHOOK_ALLOWLIST: "*corp" }
  });
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /OUTBOUND_WEBHOOK_ALLOWLIST entry "\*corp"/);
});

test("wrapper: a role subject to RLS cannot audit (exit 2) — never a false 'nothing stored'", (t) => {
  const { settingsFile, envPath } = fixture(t, { rows: [[T1, "http://10.0.0.1/"]] });
  const r = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath, FAKE_PSQL_BYPASS: "f" }
  });
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /row-level security/);
  assert.doesNotMatch(out(r), /ALLOWED|BLOCKED|no status callback URLs stored/);
});

test("wrapper: database unreachable -> exit 2", (t) => {
  const { settingsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath, FAKE_PSQL_FAIL: "1" }
  });
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /cannot query database 'testdb'/);
});

test("wrapper: node not available -> exit 2 before touching the database", (t) => {
  const { settingsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["testdb"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath },
    path: pathWithoutNode()
  });
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /needs node and built packages/);
});

test("wrapper: an unknown option is a usage error (exit 2)", (t) => {
  const { settingsFile, envPath } = fixture(t);
  const r = runScript(WRAPPER, ["--bogus"], {
    env: { FAKE_PSQL_SETTINGS_FILE: settingsFile, HYFIB_ENV_FILE: envPath }
  });
  assert.equal(r.status, 2, out(r));
  assert.match(out(r), /usage/i);
});
