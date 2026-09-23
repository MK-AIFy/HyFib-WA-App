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
 */

export const OUTBOUND_URL_MAX_LENGTH = 2048;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Suffixes that never name a public host: RFC 6761 localhost, RFC 6762 mDNS,
 * ICANN's private-use .internal (which covers metadata.google.internal and
 * host.docker.internal), RFC 8375 home.arpa, and conventional LAN names.
 */
const INTERNAL_NAME_SUFFIXES = ["localhost", "localdomain", "local", "internal", "home.arpa", "lan", "home", "corp"];

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

export type OutboundUrlValidation = { ok: true; url: URL } | { ok: false; error: string };

/** Raised (or passed to a lookup callback) when a destination is refused by the guard. */
export class OutboundUrlBlockedError extends Error {
  readonly code = "OUTBOUND_URL_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlBlockedError";
  }
}

/**
 * Save-time policy for a tenant-supplied callback URL. Synchronous and
 * DNS-free: a name that resolves to a private address is caught at connect
 * time by createOutboundFetch, not here.
 */
export function validateOutboundUrl(input: unknown): OutboundUrlValidation {
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
    if (isPrivateOrReservedAddress(host)) {
      return {
        ok: false,
        error: "URL must not point to a private, loopback, link-local or otherwise reserved address"
      };
    }
    return { ok: true, url };
  }
  if (isInternalHostName(host)) {
    return { ok: false, error: "URL host must be a public domain name, not an internal name" };
  }
  return { ok: true, url };
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

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface OutboundGuardDeps {
  /** Resolves a host name to every address it maps to. Defaults to the OS resolver (dns.lookup, all: true). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Decides whether an address may be connected to. Defaults to isPrivateOrReservedAddress. */
  isBlockedAddress?: (ip: string) => boolean;
}

/** The OS resolver (getaddrinfo, so /etc/hosts applies), read at call time so tests can substitute it. */
const defaultResolve = (hostname: string): Promise<ResolvedAddress[]> => dnsPromises.lookup(hostname, { all: true });

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
  const isBlocked = deps.isBlockedAddress ?? isPrivateOrReservedAddress;
  return (hostname, options, callback) => {
    // Node's own dns.lookup reports failures as callback(err) with no address.
    const fail = callback as unknown as (error: NodeJS.ErrnoException) => void;
    resolve(hostname).then(
      (answers) => {
        const blocked = answers.find((answer) => isBlocked(answer.address));
        if (blocked) {
          fail(new OutboundUrlBlockedError(`${hostname} resolves to a blocked address (${blocked.address})`));
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
  return (input, init = {}) => {
    const checked = validateOutboundUrl(typeof input === "string" ? input : input.href);
    if (!checked.ok) {
      return Promise.reject(new OutboundUrlBlockedError(checked.error));
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
