import { promises as dnsPromises } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * Guard for server-side requests to tenant-supplied URLs (the outbound
 * customer webhook / status_callback_url). Two layers:
 *
 *  - validateOutboundUrl: synchronous, syntax-only policy for save time —
 *    http(s) only, no credentials, no private/reserved IP literals (after the
 *    URL parser has normalised decimal/octal/hex IPv4 spellings), no empty
 *    host labels beyond one trailing dot, no obviously-internal host names.
 *  - createOutboundFetch: the delivery transport. It re-applies that policy,
 *    then connects through createGuardedLookup, which resolves the name once,
 *    refuses the whole answer if any address is private/reserved, and hands
 *    only the vetted address to the socket. There is no second resolution for
 *    a DNS-rebinding answer to slip into, and redirects are never followed.
 *
 * All three accept an optional operator allowlist (OUTBOUND_WEBHOOK_ALLOWLIST,
 * never tenant-settable) for receivers that legitimately live on a private
 * network. It is two independent knobs, least privilege:
 *
 *  - a host entry (exact name, or a suffix meaning any subdomain but not the
 *    suffix itself) lifts only the NAME checks — internal suffixes and
 *    single-label names — for that host, at save and at delivery time;
 *  - an address/CIDR entry permits only those ADDRESSES, as IP literals at
 *    save time and as resolved addresses at connect time.
 *
 * So hooks.corp -> 10.1.2.3 needs both "hooks.corp" and "10.1.2.0/24": a host
 * entry never admits whatever private address its name resolves to. Nothing
 * lifts the scheme, credential or empty-label rules, and the hard floor
 * (isHardBlockedAddress: link-local, cloud metadata in IPv4 and IPv6 — the
 * IPv6 endpoints are unique-local, not link-local — unspecified, multicast,
 * 240/4) stays blocked whatever is listed — 0.0.0.0/0 and ::/0 included.
 * Loopback opens only for an entry lying entirely inside 127.0.0.0/8, or
 * exactly ::1: a broad range such as 0.0.0.0/0 never opens loopback. It
 * still exposes the host's own services through the host's other addresses —
 * its private IP, or a Docker bridge such as 172.17.0.1 (app-server listens on
 * all interfaces) — so exact /32 and /128 entries are the safe form. Omitting
 * the allowlist (or passing an empty one) is exactly the behaviour without it.
 */

export const OUTBOUND_URL_MAX_LENGTH = 2048;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Suffixes that never name a public host: RFC 6761 localhost, RFC 6762 mDNS,
 * ICANN's private-use .internal (which covers metadata.google.internal and
 * host.docker.internal), RFC 8375 home.arpa, and conventional LAN names.
 */
const INTERNAL_NAME_SUFFIXES = ["localhost", "localdomain", "local", "internal", "home.arpa", "lan", "home", "corp"];

/** DNS limits (RFC 1035), as @hyfib/config enforces them on allowlist host entries. */
const MAX_HOST_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** At most this many refused addresses are named in a connect-time refusal, so a huge DNS answer cannot flood a log line. */
const MAX_NAMED_ADDRESSES = 8;

/** IPv4 ranges (base, prefix length) that are private, shared, loopback, link-local, documentation or reserved. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

/**
 * Hard floor: never connectable, whatever the operator allowlist says —
 * unspecified 0.0.0.0/8, link-local 169.254.0.0/16 (cloud metadata),
 * multicast 224.0.0.0/4, 240.0.0.0/4 including 255.255.255.255, and the
 * IPv4 metadata endpoints that sit OUTSIDE link-local, in otherwise
 * allowlistable space (so 0.0.0.0/0, 100.64.0.0/10 or 192.0.0.0/24 would
 * otherwise open them):
 *  - 100.100.100.200/32 — Alibaba Cloud ECS instance metadata (Alibaba Cloud
 *    ECS docs, "Instance metadata"; cloud-init DataSourceAliYun.py).
 *  - 192.0.0.192/32 — Oracle Cloud Infrastructure Compute Classic instance
 *    metadata (OpenStack/EC2-style paths).
 */
const HARD_FLOOR_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["100.100.100.200", 32],
  ["192.0.0.192", 32]
];

/**
 * Hard floor, IPv6 cloud-metadata endpoints (each an exact /128). They are
 * unique-local (fc00::/7), NOT link-local, so without this an operator entry
 * such as ::/0, fc00::/7 or fd00::/8 would open them:
 *  - fd00:ec2::254 — AWS EC2 Instance Metadata Service over IPv6 (AWS EC2 user
 *    guide, "Instance metadata" IPv6 endpoint; cloud-init DataSourceEc2.py).
 *  - fd20:ce::254 — Google Compute Engine metadata server over IPv6 (GCE docs,
 *    "About VM metadata").
 *  - fd00:c1::a9fe:a9fe — Oracle Cloud Infrastructure IMDS over IPv6, the
 *    deploy target (cloud-init DataSourceOracle.py: IPV6_METADATA_ROOT =
 *    "http://[fd00:c1::a9fe:a9fe]/opc/v{version}/"; OCI docs, "Getting
 *    Instance Metadata").
 * Compared as parsed groups, so every spelling (upper case, zero-padded,
 * uncompressed, a trailing dotted quad, a zone id) is the same address.
 */
const HARD_FLOOR_IPV6_ADDRESSES: ReadonlyArray<readonly number[]> = [
  "fd00:ec2::254",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe"
].map((address) => parseIPv6(address)!);

const IPV4_LOOPBACK_START = 127 * 2 ** 24;
const IPV4_LOOPBACK_END = 128 * 2 ** 24;

/**
 * IPv6 prefixes whose addresses carry an IPv4 address (see embeddedIPv4):
 * IPv4-mapped, IPv4-translated, IPv4-compatible, NAT64, local-use NAT64, 6to4.
 */
const IPV6_TRANSITION_PREFIXES: ReadonlyArray<{ groups: number[]; prefix: number }> = [
  { groups: [0, 0, 0, 0, 0, 0xffff, 0, 0], prefix: 96 },
  { groups: [0, 0, 0, 0, 0xffff, 0, 0, 0], prefix: 96 },
  { groups: [0, 0, 0, 0, 0, 0, 0, 0], prefix: 96 },
  { groups: [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], prefix: 96 },
  { groups: [0x64, 0xff9b, 1, 0, 0, 0, 0, 0], prefix: 48 },
  { groups: [0x2002, 0, 0, 0, 0, 0, 0, 0], prefix: 16 }
];

/**
 * What an operator could do about a refusal, offered only when doing exactly
 * that works: "host" — a host-name entry for the URL's host in
 * OUTBOUND_WEBHOOK_ALLOWLIST would lift it (the resolved address is checked
 * separately); "address" — an entry for the address(es) the refusal names
 * would. Absent when nothing can: scheme, credentials, a malformed host, a
 * host name no allowlist entry can spell, the hard floor, an IPv6 spelling of
 * an IPv4 loopback address, or a DNS answer containing any of those (or more
 * refused addresses than the refusal can name).
 */
export type OutboundAllowlistRemedy = "host" | "address";

export type OutboundUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: string; remedy?: OutboundAllowlistRemedy };

/** Raised (or passed to a lookup callback) when a destination is refused by the guard. */
export class OutboundUrlBlockedError extends Error {
  readonly code = "OUTBOUND_URL_BLOCKED";
  /** Which kind of allowlist entry could permit this destination; undefined when none can. */
  readonly remedy: OutboundAllowlistRemedy | undefined;

  constructor(message: string, remedy?: OutboundAllowlistRemedy) {
    super(message);
    this.name = "OutboundUrlBlockedError";
    this.remedy = remedy;
  }
}

/**
 * The operator's exceptions (OUTBOUND_WEBHOOK_ALLOWLIST, parsed by
 * @hyfib/config). Treated as immutable: it is compiled once per object.
 */
export interface OutboundAllowlist {
  /** Exact host names (case-insensitive, one trailing dot tolerated) whose name checks are lifted. */
  hosts?: readonly string[];
  /** Suffixes such as "corp.example": any subdomain's name checks are lifted, never the bare suffix's. */
  hostSuffixes?: readonly string[];
  /** IPv4/IPv6 addresses or CIDRs ("10.1.2.3", "10.1.2.0/24", "fd00::/64") whose addresses are admitted. */
  cidrs?: readonly string[];
}

export interface OutboundUrlPolicy {
  /** Operator allowlist; omitted or empty means no exceptions. */
  allowlist?: OutboundAllowlist;
}

/**
 * Save-time policy for a tenant-supplied callback URL. Synchronous and
 * DNS-free: a name that resolves to a private address is caught at connect
 * time by createOutboundFetch, not here. Throws only when `policy.allowlist`
 * itself is malformed (fail loud, never silently widened or dropped).
 */
export function validateOutboundUrl(input: unknown, policy: OutboundUrlPolicy = {}): OutboundUrlValidation {
  const allowlist = compiledAllowlist(policy.allowlist);
  if (typeof input !== "string") {
    return { ok: false, error: "URL must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "URL is required" };
  }
  if (trimmed.length > OUTBOUND_URL_MAX_LENGTH) {
    return { ok: false, error: `URL must be at most ${OUTBOUND_URL_MAX_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "URL must be a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "URL must use http or https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "URL must not contain credentials" };
  }
  // The WHATWG parser has already turned 2130706433 / 0x7f.1 / 0177.0.0.1 into
  // a dotted quad and bracketed any IPv6 literal, so one check covers them all.
  const bracketed = url.hostname.startsWith("[");
  const host = bracketed ? url.hostname.slice(1, -1) : url.hostname.replace(/\.$/, "");
  if (host === "") {
    return { ok: false, error: "URL must include a host" };
  }
  // Only the root label may be empty, and only as the one trailing dot just
  // stripped ("example.com."). Refusing every other empty label — instead of
  // stripping all trailing dots — closes the class outright: "localhost.."
  // cannot shed a dot to dodge the suffix check, "127.0.0.1.." (which the
  // parser keeps as a domain) cannot pose as a public name, and "a..b.com" is
  // not a DNS name at all, so nothing depends on how a resolver treats it.
  if (!bracketed && host.split(".").includes("")) {
    return { ok: false, error: "URL host must not contain an empty label" };
  }
  if (isIP(host) !== 0) {
    if (isPrivateOrReservedAddress(host) && !isAllowlistedAddress(host, allowlist)) {
      return {
        ok: false,
        error: "URL must not point to a private, loopback, link-local or otherwise reserved address",
        ...addressRemedy(host)
      };
    }
    return { ok: true, url };
  }
  if (isInternalHostName(host) && !isAllowlistedHost(host, allowlist)) {
    return {
      ok: false,
      error: "URL host must be a public domain name, not an internal name",
      ...(isAllowlistableHostName(host) ? { remedy: "host" as const } : {})
    };
  }
  return { ok: true, url };
}

/**
 * True when an allowlist entry can spell this host name. The URL parser keeps
 * characters such as "!", "~" or "," in a host, and puts no limit on label
 * length, but no entry can list them (a ',' even splits the variable), so a
 * "host" remedy for such a name could never be followed — and the entry would
 * stop the app from starting.
 */
function isAllowlistableHostName(host: string): boolean {
  try {
    normaliseAllowlistedName(host);
    return true;
  } catch {
    return false;
  }
}

/**
 * An address/CIDR entry can admit any address except the hard floor and the
 * IPv6 spellings of an IPv4 loopback address (see isAllowlistedAddress).
 */
function addressRemedy(ip: string): { remedy?: OutboundAllowlistRemedy } {
  return isHardBlockedAddress(ip) || isEmbeddedIPv4Loopback(ip) ? {} : { remedy: "address" };
}

/**
 * Single-label names resolve through the host's search domains to internal
 * services (docker-compose names such as postgres or rabbitmq, GCE's bare
 * "metadata"), so a public callback host always has at least one dot.
 */
function isInternalHostName(host: string): boolean {
  const name = host.toLowerCase();
  if (!name.includes(".")) {
    return true;
  }
  return INTERNAL_NAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * True when `ip` must never be connected to from the server: private, shared
 * (CGNAT), loopback, link-local, unspecified, multicast, documentation,
 * benchmarking or reserved space, in IPv4 or IPv6 (including IPv4-mapped,
 * IPv4-compatible, NAT64 and 6to4 forms of such an IPv4 address). Anything
 * that is not a well-formed address is treated as reserved (fail closed).
 */
export function isPrivateOrReservedAddress(ip: string): boolean {
  const zone = ip.indexOf("%");
  const address = zone === -1 ? ip : ip.slice(0, zone);
  const version = isIP(address);
  if (version === 4) {
    const value = parseIPv4(address);
    return value === undefined || isBlockedIPv4(value);
  }
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups === undefined || isBlockedIPv6(groups);
  }
  return true;
}

function parseIPv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = parseIPv4(base)!;
    return value >= start && value < start + size;
  });
}

/** Expands an IPv6 address (optionally ending in a dotted quad) into its eight 16-bit groups. */
function parseIPv6(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const trailer = text.slice(lastColon + 1);
  if (trailer.includes(".")) {
    const v4 = parseIPv4(trailer);
    if (v4 === undefined) {
      return undefined;
    }
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parseGroups = (part: string | undefined): number[] | undefined => {
    if (!part) {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return undefined;
      }
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]);
  const tail = parseGroups(halves[1]);
  if (!head || !tail) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) {
    return undefined;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIPv6(groups: number[]): boolean {
  const g = (index: number): number => groups[index] ?? 0;
  // NAT64 well-known prefix 64:ff9b::/96 — on an IPv6-only host with DNS64
  // every IPv4-only receiver looks like this, so judge the embedded address.
  if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
    return isBlockedIPv4(g(6) * 65536 + g(7));
  }
  // Only global unicast 2000::/3 is reachable. Everything else — ::/8
  // (unspecified, loopback, IPv4-mapped/compatible), 64:ff9b:1::/48,
  // 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8 — is refused.
  if ((g(0) & 0xe000) !== 0x2000) {
    return true;
  }
  if (g(0) === 0x2001 && g(1) < 0x0200) {
    return true; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID)
  }
  if (g(0) === 0x2001 && g(1) === 0x0db8) {
    return true; // 2001:db8::/32 documentation
  }
  if (g(0) === 0x3fff && (g(1) & 0xf000) === 0) {
    return true; // 3fff::/20 documentation
  }
  if (g(0) === 0x2002) {
    return isBlockedIPv4(g(1) * 65536 + g(2)); // 6to4 embeds the IPv4 address
  }
  return false;
}

function inIPv4Ranges(value: number, ranges: ReadonlyArray<readonly [string, number]>): boolean {
  return ranges.some(([base, prefix]) => {
    const start = parseIPv4(base)!;
    return value >= start && value < start + 2 ** (32 - prefix);
  });
}

/**
 * The IPv4 address an IPv6 transition form carries, if it is one: IPv4-mapped
 * (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d, so :: carries 0.0.0.0),
 * IPv4-translated (::ffff:0:a.b.c.d), NAT64 64:ff9b::/96 and the local-use
 * 64:ff9b:1::/48 in its /96 layout, and 6to4 (2002:AABB:CCDD::). ::1 is the
 * IPv6 loopback, not an embedding.
 */
function embeddedIPv4(groups: number[]): number | undefined {
  const g = (index: number): number => groups[index] ?? 0;
  const tail = g(6) * 65536 + g(7);
  const zeroPrefix = g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0;
  if (zeroPrefix && g(4) === 0 && (g(5) === 0xffff || g(5) === 0)) {
    return g(5) === 0 && tail === 1 ? undefined : tail;
  }
  if (zeroPrefix && g(4) === 0xffff && g(5) === 0) {
    return tail;
  }
  if (g(0) === 0x64 && g(1) === 0xff9b && ((g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) || g(2) === 1)) {
    return tail;
  }
  if (g(0) === 0x2002) {
    return g(1) * 65536 + g(2);
  }
  return undefined;
}

/**
 * True for the hard floor no operator allowlist can open: unspecified
 * (0.0.0.0/8, ::), link-local (169.254.0.0/16 — cloud metadata — and
 * fe80::/10), multicast (224.0.0.0/4, ff00::/8), 240.0.0.0/4 including
 * 255.255.255.255, the cloud-metadata endpoints outside link-local
 * (HARD_FLOOR_IPV4_RANGES' /32s, HARD_FLOOR_IPV6_ADDRESSES), plus any IPv6
 * transition form that embeds such an IPv4 address. Anything that is not a
 * well-formed address counts (fail closed).
 */
export function isHardBlockedAddress(ip: string): boolean {
  const zone = ip.indexOf("%");
  const address = zone === -1 ? ip : ip.slice(0, zone);
  const version = isIP(address);
  if (version === 4) {
    const value = parseIPv4(address);
    return value === undefined || inIPv4Ranges(value, HARD_FLOOR_IPV4_RANGES);
  }
  if (version === 6) {
    const groups = parseIPv6(address);
    if (groups === undefined) {
      return true;
    }
    const first = groups[0] ?? 0;
    if ((first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
      return true;
    }
    if (HARD_FLOOR_IPV6_ADDRESSES.some((floor) => floor.every((group, index) => group === groups[index]))) {
      return true;
    }
    const embedded = embeddedIPv4(groups);
    return embedded !== undefined && inIPv4Ranges(embedded, HARD_FLOOR_IPV4_RANGES);
  }
  return true;
}

// ─── Operator allowlist ─────────────────────────────────────────────────────

interface CompiledAllowlist {
  hosts: ReadonlySet<string>;
  hostSuffixes: readonly string[];
  v4: ReadonlyArray<{ start: number; size: number; loopbackOnly: boolean }>;
  v6: ReadonlyArray<{ groups: number[]; prefix: number; loopbackOnly: boolean }>;
}

const compiledAllowlists = new WeakMap<OutboundAllowlist, CompiledAllowlist>();

function invalidAllowlistEntry(entry: unknown, why: string): Error {
  return new Error(`Invalid outbound allowlist entry ${JSON.stringify(entry)}: ${why}`);
}

/** Compiles (once per allowlist object) or throws naming the first malformed entry. */
function compiledAllowlist(allowlist: OutboundAllowlist | undefined): CompiledAllowlist | undefined {
  if (allowlist === undefined) {
    return undefined;
  }
  let compiled = compiledAllowlists.get(allowlist);
  if (compiled === undefined) {
    compiled = compileAllowlist(allowlist);
    compiledAllowlists.set(allowlist, compiled);
  }
  return compiled;
}

function compileAllowlist(allowlist: OutboundAllowlist): CompiledAllowlist {
  const v4: Array<CompiledAllowlist["v4"][number]> = [];
  const v6: Array<CompiledAllowlist["v6"][number]> = [];
  for (const entry of allowlist.cidrs ?? []) {
    const cidr = parseAllowlistCidr(entry);
    if (cidr.version === 4) {
      const size = 2 ** (32 - cidr.prefix);
      const start = cidr.value;
      v4.push({ start, size, loopbackOnly: start >= IPV4_LOOPBACK_START && start + size <= IPV4_LOOPBACK_END });
    } else {
      const loopbackOnly = cidr.prefix === 128 && isIPv6Loopback(cidr.groups);
      v6.push({ groups: cidr.groups, prefix: cidr.prefix, loopbackOnly });
    }
  }
  return {
    hosts: new Set((allowlist.hosts ?? []).map((entry) => normaliseAllowlistedName(entry))),
    hostSuffixes: (allowlist.hostSuffixes ?? []).map((entry) => normaliseAllowlistedName(entry)),
    v4,
    v6
  };
}

/**
 * Lower-case, one trailing dot stripped; anything that could never equal a URL
 * host, or that @hyfib/config's OUTBOUND_WEBHOOK_ALLOWLIST parser refuses
 * (a label over 63 or a name over 253 characters), throws.
 */
function normaliseAllowlistedName(entry: unknown): string {
  if (typeof entry !== "string") {
    throw invalidAllowlistEntry(entry, "a host name must be a string");
  }
  const name = entry.toLowerCase().replace(/\.$/, "");
  if (name === "" || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(name)) {
    throw invalidAllowlistEntry(entry, "not a plain host name (no wildcard, scheme, port or empty label)");
  }
  if (name.length > MAX_HOST_NAME_LENGTH || name.split(".").some((label) => label.length > MAX_LABEL_LENGTH)) {
    throw invalidAllowlistEntry(entry, "a host name is at most 253 characters, each label at most 63");
  }
  return name;
}

type ParsedCidr = { version: 4; value: number; prefix: number } | { version: 6; groups: number[]; prefix: number };

function parseAllowlistCidr(entry: unknown): ParsedCidr {
  if (typeof entry !== "string") {
    throw invalidAllowlistEntry(entry, "an address or CIDR must be a string");
  }
  const parts = entry.split("/");
  const [address = ""] = parts;
  const version = address.includes("%") ? 0 : isIP(address);
  const bits = version === 4 ? 32 : 128;
  const prefixText = parts[1] ?? String(bits);
  if (version === 0 || parts.length > 2 || !/^\d{1,3}$/.test(prefixText) || Number(prefixText) > bits) {
    throw invalidAllowlistEntry(entry, "not an IP address or CIDR");
  }
  const prefix = Number(prefixText);
  if (version === 4) {
    const value = parseIPv4(address)!;
    if (value % 2 ** (32 - prefix) !== 0) {
      throw invalidAllowlistEntry(entry, "host bits are set below the prefix");
    }
    return { version: 4, value, prefix };
  }
  const groups = parseIPv6(address);
  if (groups === undefined) {
    throw invalidAllowlistEntry(entry, "not an IP address or CIDR");
  }
  if (!ipv6InPrefix(groups, groups, prefix, true)) {
    throw invalidAllowlistEntry(entry, "host bits are set below the prefix");
  }
  return { version: 6, groups, prefix };
}

/**
 * True when `groups` lies in base/prefix. With `requireZeroHostBits`, instead
 * checks that `base` itself has no bits set below the prefix.
 */
function ipv6InPrefix(groups: number[], base: number[], prefix: number, requireZeroHostBits = false): boolean {
  for (let index = 0; index < 8; index += 1) {
    const networkBits = Math.min(16, Math.max(0, prefix - index * 16));
    const mask = networkBits === 0 ? 0 : (0xffff << (16 - networkBits)) & 0xffff;
    const value = groups[index] ?? 0;
    if (requireZeroHostBits ? (value & ~mask & 0xffff) !== 0 : (value & mask) !== ((base[index] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

function isIPv6Loopback(groups: number[]): boolean {
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

function isIPv4Loopback(value: number | undefined): boolean {
  return value !== undefined && value >= IPV4_LOOPBACK_START && value < IPV4_LOOPBACK_END;
}

/** ::ffff:127.0.0.1 and the other IPv6 forms carrying a 127/8 address: never allowlistable. */
function isEmbeddedIPv4Loopback(ip: string): boolean {
  const zone = ip.indexOf("%");
  const address = zone === -1 ? ip : ip.slice(0, zone);
  if (isIP(address) !== 6) {
    return false;
  }
  const groups = parseIPv6(address);
  return groups !== undefined && isIPv4Loopback(embeddedIPv4(groups));
}

function isAllowlistedHost(host: string, allowlist: CompiledAllowlist | undefined): boolean {
  if (allowlist === undefined) {
    return false;
  }
  const name = host.toLowerCase();
  return allowlist.hosts.has(name) || allowlist.hostSuffixes.some((suffix) => name.endsWith(`.${suffix}`));
}

/**
 * True when an operator entry admits this (otherwise blocked) address. Never
 * for the hard floor; loopback only through an entry that is itself entirely
 * loopback (inside 127.0.0.0/8, or exactly ::1), so a broad range such as
 * 0.0.0.0/0 or ::/0 never opens loopback — though it does open the host's
 * own private and Docker-bridge addresses, and its services on them. Entries match
 * their own family only: 10.0.0.0/8 does not admit ::ffff:10.0.0.1. And an
 * IPv6 spelling of an IPv4 address (mapped, NAT64, 6to4, ...) is admitted
 * only by an entry inside that form's own prefix (::ffff:10.0.0.0/104), so a
 * range meant to open IPv6 (::/0) never opens private IPv4 hosts through it.
 */
function isAllowlistedAddress(ip: string, allowlist: CompiledAllowlist | undefined): boolean {
  if (allowlist === undefined || isHardBlockedAddress(ip)) {
    return false;
  }
  const zone = ip.indexOf("%");
  const address = zone === -1 ? ip : ip.slice(0, zone);
  if (isIP(address) === 4) {
    const value = parseIPv4(address);
    if (value === undefined) {
      return false;
    }
    const loopback = isIPv4Loopback(value);
    return allowlist.v4.some(
      (range) => value >= range.start && value < range.start + range.size && (!loopback || range.loopbackOnly)
    );
  }
  const groups = parseIPv6(address);
  if (groups === undefined) {
    return false;
  }
  const loopback = isIPv6Loopback(groups) || isIPv4Loopback(embeddedIPv4(groups));
  const transition =
    embeddedIPv4(groups) === undefined
      ? undefined
      : IPV6_TRANSITION_PREFIXES.find((form) => ipv6InPrefix(groups, form.groups, form.prefix));
  return allowlist.v6.some(
    (range) =>
      ipv6InPrefix(groups, range.groups, range.prefix) &&
      (!loopback || range.loopbackOnly) &&
      (transition === undefined ||
        (range.prefix >= transition.prefix && ipv6InPrefix(range.groups, transition.groups, transition.prefix)))
  );
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface OutboundGuardDeps {
  /** Resolves a host name to every address it maps to. Defaults to the OS resolver (dns.lookup, all: true). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * Decides whether an address may be connected to. Defaults to
   * isPrivateOrReservedAddress minus what `allowlist` admits; when injected it
   * replaces that address decision entirely.
   */
  isBlockedAddress?: (ip: string) => boolean;
  /** Operator allowlist (host entries for the URL check, address entries for both). Omitted: no exceptions. */
  allowlist?: OutboundAllowlist;
}

/** The OS resolver (getaddrinfo, so /etc/hosts applies), read at call time so tests can substitute it. */
const defaultResolve = (hostname: string): Promise<ResolvedAddress[]> => dnsPromises.lookup(hostname, { all: true });

/**
 * The refusal for a DNS answer containing refused addresses. It names every
 * one of them (up to MAX_NAMED_ADDRESSES), because the whole answer is refused
 * until each is admitted. It offers the "address" remedy only when listing
 * exactly the named addresses would let the connection through: never when
 * any of them is unallowable (the hard floor, an IPv6-spelled IPv4 loopback)
 * or when some had to be left unnamed.
 */
function blockedAnswerError(hostname: string, blocked: readonly string[]): OutboundUrlBlockedError {
  const named = blocked.slice(0, MAX_NAMED_ADDRESSES);
  const unnamed = blocked.length - named.length;
  const list = unnamed > 0 ? `${named.join(", ")} and ${unnamed} more` : named.join(", ");
  const message =
    blocked.length === 1
      ? `${hostname} resolves to a blocked address (${list})`
      : `${hostname} resolves to blocked addresses (${list})`;
  const remediable = unnamed === 0 && blocked.every((address) => addressRemedy(address).remedy === "address");
  return new OutboundUrlBlockedError(message, remediable ? "address" : undefined);
}

function requestedFamily(family: number | "IPv4" | "IPv6" | undefined): number {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  return family ?? 0;
}

/**
 * A `lookup` for net/http/https connections: resolves once, refuses the whole
 * answer when any address is blocked (a mixed answer is never trusted), and
 * gives the socket only vetted addresses — in both the single-address and the
 * `all: true` (happy-eyeballs) callback shapes Node uses.
 */
export function createGuardedLookup(deps: OutboundGuardDeps = {}): LookupFunction {
  const resolve = deps.resolve ?? defaultResolve;
  // Compiled now, so a malformed allowlist fails when the transport is built, not on first delivery.
  const allowlist = compiledAllowlist(deps.allowlist);
  const isBlocked =
    deps.isBlockedAddress ?? ((ip: string) => isPrivateOrReservedAddress(ip) && !isAllowlistedAddress(ip, allowlist));
  return (hostname, options, callback) => {
    // Node's own dns.lookup reports failures as callback(err) with no address.
    const fail = callback as unknown as (error: NodeJS.ErrnoException) => void;
    resolve(hostname).then(
      (answers) => {
        const blocked = [...new Set(answers.map((answer) => answer.address).filter((address) => isBlocked(address)))];
        if (blocked.length > 0) {
          fail(blockedAnswerError(hostname, blocked));
          return;
        }
        const family = requestedFamily(options.family);
        const usable = family === 0 ? answers : answers.filter((answer) => answer.family === family);
        const first = usable[0];
        if (!first) {
          fail(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }));
          return;
        }
        if (options.all) {
          callback(
            null,
            usable.map((answer) => ({ address: answer.address, family: answer.family }))
          );
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
    );
  };
}

export interface OutboundRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Aborts the whole exchange; defaults to a 10s timeout. */
  signal?: AbortSignal;
  /** Accepted for fetch compatibility and ignored: redirects are never followed. */
  redirect?: string;
}

export interface OutboundResponse {
  ok: boolean;
  status: number;
}

export type OutboundFetch = (url: string | URL, init?: OutboundRequestInit) => Promise<OutboundResponse>;

/**
 * A minimal fetch-shaped client for tenant-supplied URLs. Rejects with
 * OutboundUrlBlockedError when the URL or any resolved address is refused;
 * resolves with the status of the first response (a 3xx is returned as-is,
 * never followed) as soon as it arrives, then closes the connection without
 * reading the body. Uses a fresh agent per request so no pooled socket from
 * another caller can be reused.
 */
export function createOutboundFetch(deps: OutboundGuardDeps = {}): OutboundFetch {
  const lookup = createGuardedLookup(deps);
  const policy: OutboundUrlPolicy = { allowlist: deps.allowlist };
  return (input, init = {}) => {
    const checked = validateOutboundUrl(typeof input === "string" ? input : input.href, policy);
    if (!checked.ok) {
      return Promise.reject(new OutboundUrlBlockedError(checked.error, checked.remedy));
    }
    const url = checked.url;
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const options = {
      method: init.method ?? "GET",
      headers,
      lookup,
      agent: false as const,
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    };
    return new Promise<OutboundResponse>((resolve, reject) => {
      let settled = false;
      const onResponse = (res: IncomingMessage): void => {
        settled = true;
        const status = res.statusCode ?? 0;
        // Only the status matters. Destroying the unread response destroys its
        // socket (agent:false, so it is this request's alone): draining instead
        // would hold the connection open for a slow or huge body until the
        // timeout. The teardown and any later abort stay swallowed here and in
        // the req 'error' handler, so neither can surface as an unhandled 'error'.
        res.on("error", () => undefined);
        res.destroy();
        resolve({ ok: status >= 200 && status < 300, status });
      };
      const req =
        url.protocol === "https:" ? httpsRequest(url, options, onResponse) : httpRequest(url, options, onResponse);
      req.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });
      req.end(init.body);
    });
  };
}
