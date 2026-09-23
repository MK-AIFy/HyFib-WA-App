import { isIP } from "node:net";

/**
 * OUTBOUND_WEBHOOK_ALLOWLIST — the operator's exceptions to the outbound-URL
 * guard (@hyfib/shared-core outbound-url) for tenant webhooks whose receiver
 * legitimately lives on a private network. Environment only: it is never a
 * tenant setting and never returned by any API.
 *
 * Comma-separated entries, whitespace around each ignored:
 *  - a HOST NAME ("hooks.corp"): exact, case-insensitive, one trailing dot
 *    tolerated. Lifts only the name checks (internal suffixes, single-label
 *    names) for that host.
 *  - "*.SUFFIX" ("*.corp.example"): any subdomain of the suffix, never the
 *    bare suffix itself (list that separately).
 *  - an IP ADDRESS or CIDR ("10.1.2.3", "10.1.2.0/24", "fd00::/64"): permits
 *    those addresses, as literals and as resolved addresses. The guard keeps
 *    its hard floor (link-local/metadata, unspecified, multicast, 240/4)
 *    whatever is listed.
 *
 * Every entry is validated here, at config load, and anything malformed throws
 * naming the entry: a typo must never silently widen or drop the allowlist.
 */
export interface OutboundWebhookAllowlist {
  /** Exact host names: lower-case, no trailing dot. */
  readonly hosts: readonly string[];
  /** "*.corp.example" entries, stored as "corp.example": any subdomain, not the bare suffix. */
  readonly hostSuffixes: readonly string[];
  /** Canonical "address/prefix" strings; a bare address is stored as /32 (IPv4) or /128 (IPv6). */
  readonly cidrs: readonly string[];
}

const VARIABLE = "OUTBOUND_WEBHOOK_ALLOWLIST";
const LABEL = /^[a-z0-9_-]+$/;
/** A final label the WHATWG URL parser would read as (part of) an IPv4 address. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|\d+)$/;

class AllowlistEntryError extends Error {
  constructor(entry: string, why: string) {
    super(`Invalid ${VARIABLE} entry "${entry}": ${why}`);
    this.name = "AllowlistEntryError";
  }
}

export function parseOutboundWebhookAllowlist(value: string | undefined): OutboundWebhookAllowlist {
  const hosts = new Set<string>();
  const hostSuffixes = new Set<string>();
  const cidrs = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") {
      continue;
    }
    const parsed = parseEntry(entry);
    const target = parsed.kind === "host" ? hosts : parsed.kind === "suffix" ? hostSuffixes : cidrs;
    target.add(parsed.value);
  }
  return Object.freeze({
    hosts: Object.freeze([...hosts]),
    hostSuffixes: Object.freeze([...hostSuffixes]),
    cidrs: Object.freeze([...cidrs])
  });
}

type ParsedEntry = { kind: "host" | "suffix" | "cidr"; value: string };

function parseEntry(entry: string): ParsedEntry {
  if (entry.includes("://")) {
    throw new AllowlistEntryError(entry, "list a bare host name, not a URL (no scheme, port or path)");
  }
  if (entry.includes("[") || entry.includes("]")) {
    throw new AllowlistEntryError(entry, "write an IPv6 address without brackets");
  }
  if (entry.includes("%")) {
    throw new AllowlistEntryError(entry, "an IPv6 zone id (%...) is not allowed");
  }
  if (entry.includes("/")) {
    return { kind: "cidr", value: parseCidr(entry) };
  }
  if (isIP(entry) !== 0) {
    return { kind: "cidr", value: `${canonicalAddress(entry)}/${isIP(entry) === 4 ? 32 : 128}` };
  }
  if (entry.includes(":")) {
    throw new AllowlistEntryError(
      entry,
      "not a valid IP address, and a host name cannot contain ':' (no scheme or port)"
    );
  }
  if (entry.includes("*")) {
    if (!entry.startsWith("*.") || entry.slice(2).includes("*") || entry.length === 2) {
      throw new AllowlistEntryError(entry, 'a wildcard is only allowed as a leading "*." followed by a domain suffix');
    }
    return { kind: "suffix", value: parseHostName(entry, entry.slice(2)) };
  }
  return { kind: "host", value: parseHostName(entry, entry) };
}

/** Validates a host name the way the URL parser will present it: ASCII, lower-case, no trailing dot. */
function parseHostName(entry: string, name: string): string {
  if (/[^\x21-\x7e]/.test(name)) {
    throw new AllowlistEntryError(
      entry,
      /\s/.test(name)
        ? "not a valid host name (it contains whitespace)"
        : "use the ASCII (punycode, xn--) form of an internationalised host name"
    );
  }
  const host = name.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.includes("")) {
    throw new AllowlistEntryError(entry, "a host name must not contain an empty label");
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      throw new AllowlistEntryError(entry, "not a valid host name (letters, digits, '-' and '_' only)");
    }
    if (label.length > 63) {
      throw new AllowlistEntryError(entry, "a host-name label must be at most 63 characters");
    }
  }
  if (host.length > 253) {
    throw new AllowlistEntryError(entry, "a host name must be at most 253 characters");
  }
  if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) {
    throw new AllowlistEntryError(
      entry,
      "the last label is numeric, so the URL parser would read it as an IPv4 address, but it is not a valid dotted-quad IPv4 address"
    );
  }
  return host;
}

function parseCidr(entry: string): string {
  const parts = entry.split("/");
  const [address = "", prefixText = ""] = parts;
  const version = isIP(address);
  if (parts.length !== 2 || version === 0) {
    throw new AllowlistEntryError(entry, "not a valid CIDR (expected an IP address, '/', and a prefix length)");
  }
  const bits = version === 4 ? 32 : 128;
  if (!/^(?:0|[1-9]\d{0,2})$/.test(prefixText) || Number(prefixText) > bits) {
    throw new AllowlistEntryError(entry, `the prefix length must be a whole number from 0 to ${bits}`);
  }
  const prefix = Number(prefixText);
  const value = addressToBigInt(address, version);
  const hostMask = (1n << BigInt(bits - prefix)) - 1n;
  if ((value & hostMask) !== 0n) {
    const network = bigIntToAddress(value & ~hostMask, version);
    throw new AllowlistEntryError(entry, `host bits are set below the prefix (did you mean ${network}/${prefix}?)`);
  }
  return `${canonicalAddress(address)}/${prefix}`;
}

/** Lower-case, compressed IPv6 (the URL parser's serialisation); IPv4 is already canonical once isIP accepts it. */
function canonicalAddress(address: string): string {
  if (isIP(address) === 4) {
    return address;
  }
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function addressToBigInt(address: string, version: number): bigint {
  if (version === 4) {
    return address.split(".").reduce((value, octet) => (value << 8n) + BigInt(Number(octet)), 0n);
  }
  const [head = "", tail] = canonicalAddress(address).split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = new Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  const groups = tail === undefined ? headGroups : [...headGroups, ...zeros, ...tailGroups];
  return groups.reduce((value, group) => (value << 16n) + BigInt(parseInt(group, 16)), 0n);
}

function bigIntToAddress(value: bigint, version: number): string {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
  }
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  return canonicalAddress(groups.join(":"));
}
