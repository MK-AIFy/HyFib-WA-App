#!/usr/bin/env node
// READ-ONLY pre-deploy audit: would each tenant's stored webhook URL (whatsapp_settings.status_callback_url) still be
// delivered to under the outbound-URL guard and the operator allowlist (OUTBOUND_WEBHOOK_ALLOWLIST)?
//
// Input : one `<tenant-id>\t<hex of status_callback_url>` per line on stdin — hex, so no URL can break a line.
//         audit-status-callback-urls.sh produces it with psql; use that wrapper against a database.
// Allow : OUTBOUND_WEBHOOK_ALLOWLIST from the environment, parsed by the application's own parser (packages/config),
//         so an operator can try a value here before setting it for the app.
// --resolve  also apply the connect-time rule: resolve each host name ONCE with the OS resolver and vet every
//         address exactly as the worker's transport does (packages/shared-core createGuardedLookup). Run it on the
//         app host so names resolve as the app sees them.
// Output: per tenant, the verdict and scheme://host[:port] only — never the path, query, fragment, credentials or
//         signing secret — plus what an operator could allowlist, if anything.
// Exit  : 0 every stored URL allowed (or none stored); 1 at least one would be blocked; 2 could not audit (invalid
//         allowlist, packages not built, unreadable input, usage); 3 nothing blocked but a host name did not resolve.
//
// It never writes anywhere: it reads stdin and the environment, and prints.
import process from "node:process";
import { isIP } from "node:net";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_BLOCKED = 1;
export const EXIT_CANNOT_AUDIT = 2;
export const EXIT_UNRESOLVED = 3;

const USAGE =
  "usage: audit-status-callback-urls.mjs [--resolve] < rows\n" +
  "  rows: <tenant-id>\\t<hex(status_callback_url)> per line (see audit-status-callback-urls.sh)\n" +
  "  OUTBOUND_WEBHOOK_ALLOWLIST in the environment is the allowlist to test\n";

const RUNBOOK = "docs/runbooks/outbound-webhook-allowlist.md";
const HOST_ONLY_NOTE = "host name allowlisted; its address is checked only with --resolve";

/** scheme://host[:port] — the only part of a stored URL this script ever prints. */
export function displayOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return "<not a valid URL>";
  }
  return url.host === "" ? `${url.protocol} (no host)` : `${url.protocol}//${url.host}`;
}

/** Parses `<tenant-id>\t<hex>` lines. An undecodable line becomes { url: null } and is never echoed. */
export function parseRows(input) {
  const rows = [];
  String(input)
    .split("\n")
    .forEach((rawLine, index) => {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim() === "") {
        return;
      }
      const tab = line.indexOf("\t");
      if (tab === -1) {
        rows.push({ tenantId: `line ${index + 1}`, url: null });
        return;
      }
      const payload = line.slice(tab + 1).trim();
      const url = /^(?:[0-9a-fA-F]{2})*$/.test(payload) ? Buffer.from(payload, "hex").toString("utf8") : null;
      rows.push({ tenantId: line.slice(0, tab), url });
    });
  return rows;
}

/** What an operator could do about a block: which allowlist entry kind, or that nothing can help. */
export function remedyHint(remedy) {
  if (remedy === "host") {
    return "an operator may add its host name to OUTBOUND_WEBHOOK_ALLOWLIST (its address must be allowlisted too)";
  }
  if (remedy === "address") {
    // The exact address, not a range: entries match only their own address family (see customerWebhookBlockHint).
    return "an operator may add this exact address to OUTBOUND_WEBHOOK_ALLOWLIST, as written (a /32 or /128 entry)";
  }
  return "cannot be allowlisted: the tenant must change the URL";
}

function withRemedy(result, remedy) {
  return remedy === undefined ? result : { ...result, remedy };
}

function isIpLiteralHost(hostname) {
  return hostname.startsWith("[") || isIP(hostname) !== 0;
}

/** The connect-time rule for one host name, through the application's own guarded lookup. */
function checkResolution(hostname, { shared, allowlist, resolve }) {
  const lookup = shared.createGuardedLookup(resolve ? { allowlist, resolve } : { allowlist });
  return new Promise((settle) => {
    lookup(hostname, { all: true }, (error) => settle(error ?? null));
  });
}

/**
 * The verdict per row, without I/O beyond the injected resolver:
 *  - allowed: passes the save-time rule (and, with resolveHosts, the connect-time rule);
 *  - blocked-at-save: the settings PUT would reject it, and the worker refuses every delivery (it re-checks the
 *    same rule);
 *  - blocked-at-delivery: saved fine, but the name resolves to an address the guard refuses (resolveHosts only);
 *  - unresolved: the name did not resolve here (resolveHosts only);
 *  - unreadable: the input line could not be decoded.
 */
export async function auditRows(rows, { shared, allowlist, resolveHosts, resolve }) {
  const results = [];
  for (const { tenantId, url } of rows) {
    if (url === null) {
      results.push({ tenantId, origin: "-", verdict: "unreadable", reason: "input line could not be decoded" });
      continue;
    }
    const origin = displayOrigin(url);
    const saved = shared.validateOutboundUrl(url, { allowlist });
    if (!saved.ok) {
      results.push(withRemedy({ tenantId, origin, verdict: "blocked-at-save", reason: saved.error }, saved.remedy));
      continue;
    }
    // net.connect never looks up an IP literal: the save-time rule above is the whole decision for it.
    if (isIpLiteralHost(saved.url.hostname)) {
      results.push({ tenantId, origin, verdict: "allowed" });
      continue;
    }
    if (!resolveHosts) {
      // A host entry lifts only the name check; without DNS the address it needs is unverified, so say so.
      const withoutAllowlist = shared.validateOutboundUrl(url);
      const nameAllowlisted = !withoutAllowlist.ok && withoutAllowlist.remedy === "host";
      results.push(
        nameAllowlisted
          ? { tenantId, origin, verdict: "allowed", note: HOST_ONLY_NOTE }
          : { tenantId, origin, verdict: "allowed" }
      );
      continue;
    }
    const error = await checkResolution(saved.url.hostname, { shared, allowlist, resolve });
    if (error === null) {
      results.push({ tenantId, origin, verdict: "allowed" });
    } else if (error.code === "OUTBOUND_URL_BLOCKED") {
      // The guard's message names the host and the refused address only — never the path.
      results.push(
        withRemedy({ tenantId, origin, verdict: "blocked-at-delivery", reason: error.message }, error.remedy)
      );
    } else {
      const code = typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "lookup failed";
      results.push({ tenantId, origin, verdict: "unresolved", reason: code });
    }
  }
  return results;
}

function describeAllowlist(allowlist) {
  const entries = [...allowlist.hosts, ...allowlist.hostSuffixes.map((suffix) => `*.${suffix}`), ...allowlist.cidrs];
  return entries.length === 0 ? "(none)" : entries.join(", ");
}

const LABELS = {
  allowed: "ALLOWED",
  "blocked-at-save": "BLOCKED-AT-SAVE",
  "blocked-at-delivery": "BLOCKED-AT-DELIVERY",
  unresolved: "UNRESOLVED",
  unreadable: "UNREADABLE"
};

export function formatReport(results, { allowlist, resolveHosts }) {
  const lines = [
    `status_callback_url audit - allowlist: ${describeAllowlist(allowlist)}; DNS: ${resolveHosts ? "resolved (--resolve)" : "not resolved"}`
  ];
  if (results.length === 0) {
    lines.push("no status callback URLs stored - nothing to audit");
    return lines;
  }
  for (const result of results) {
    const head = `${LABELS[result.verdict].padEnd(19)} ${result.tenantId}  ${result.origin}`;
    if (result.verdict === "allowed") {
      lines.push(result.note ? `${head}  ${result.note}` : head);
    } else if (result.verdict.startsWith("blocked")) {
      lines.push(`${head}  ${result.reason} - ${remedyHint(result.remedy)}`);
    } else {
      lines.push(`${head}  ${result.reason}`);
    }
  }
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const extras = [
    ...(resolveHosts ? [`${count("unresolved")} unresolved`] : []),
    ...(count("unreadable") > 0 ? [`${count("unreadable")} unreadable`] : [])
  ];
  lines.push(
    `summary: ${results.length} configured: ${count("allowed")} allowed, ${count("blocked-at-save")} blocked at save, ` +
      `${count("blocked-at-delivery")} blocked at delivery${extras.map((extra) => `, ${extra}`).join("")}`
  );
  if (!resolveHosts) {
    lines.push(
      "NOTE: host names were not resolved; a name that resolves to a private address is only caught with --resolve " +
        "(run it on the app host)"
    );
  }
  if (count("blocked-at-save") + count("blocked-at-delivery") > 0) {
    lines.push(`Blocked URLs stop receiving webhooks once the guard is deployed; see ${RUNBOOK}`);
  }
  return lines;
}

export function exitCodeFor(results) {
  if (results.some((result) => result.verdict === "unreadable")) {
    return EXIT_CANNOT_AUDIT;
  }
  if (results.some((result) => result.verdict.startsWith("blocked"))) {
    return EXIT_BLOCKED;
  }
  if (results.some((result) => result.verdict === "unresolved")) {
    return EXIT_UNRESOLVED;
  }
  return EXIT_OK;
}

/** The whole audit without process I/O: returns what to print and the exit code. */
export async function runAudit({ input, allowlistText, resolveHosts, shared, config, resolve }) {
  let allowlist;
  try {
    allowlist = config.parseOutboundWebhookAllowlist(allowlistText);
  } catch (error) {
    // The parser names the offending entry: that is the operator's own configuration, safe to show them.
    return {
      code: EXIT_CANNOT_AUDIT,
      stdout: "",
      stderr: `ERROR: ${error instanceof Error ? error.message : error}\n`
    };
  }
  const results = await auditRows(parseRows(input), { shared, allowlist, resolveHosts, resolve });
  return {
    code: exitCodeFor(results),
    stdout: `${formatReport(results, { allowlist, resolveHosts }).join("\n")}\n`,
    stderr: ""
  };
}

async function loadPackages() {
  const shared = await import(new URL("../packages/shared-core/dist/index.js", import.meta.url).href);
  const config = await import(new URL("../packages/config/dist/index.js", import.meta.url).href);
  return { shared, config };
}

async function main(argv) {
  let resolveHosts = false;
  for (const arg of argv) {
    if (arg === "--resolve") {
      resolveHosts = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return EXIT_OK;
    } else {
      process.stderr.write(`ERROR: unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
      return EXIT_CANNOT_AUDIT;
    }
  }
  if (process.stdin.isTTY) {
    process.stderr.write(`ERROR: expected rows on stdin\n${USAGE}`);
    return EXIT_CANNOT_AUDIT;
  }
  let packages;
  try {
    packages = await loadPackages();
  } catch {
    process.stderr.write("ERROR: packages/shared-core and packages/config are not built - run `pnpm build` first\n");
    return EXIT_CANNOT_AUDIT;
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const { code, stdout, stderr } = await runAudit({
    input: Buffer.concat(chunks).toString("utf8"),
    allowlistText: process.env.OUTBOUND_WEBHOOK_ALLOWLIST ?? "",
    resolveHosts,
    ...packages
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return code;
}

const isMain = process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
