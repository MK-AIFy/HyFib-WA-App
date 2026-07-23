import { randomBytes } from "node:crypto";

/**
 * Campaign link click tracking: replaces URL-valued template parameters with
 * per-recipient shortlinks (`{baseUrl}/r/{token}`) so the gateway's public
 * /r/:token redirect can record clicks per campaign + contact.
 *
 * Minting is best-effort by design: a failure to store a shortlink must never
 * fail or delay the send — the original URL is kept instead.
 */

export interface MintOptions {
  /** Public base URL of the platform, e.g. config.platformBaseUrl. */
  baseUrl: string;
  /** Persists token -> destination (linkClickRepository.create behind a closure). */
  createLink: (token: string, destination: string) => Promise<void>;
  /** Invoked when minting a link fails; the original URL is used as fallback. */
  onError?: (err: unknown, destination: string) => void;
}

/** A parameter is trackable only when the entire value is an absolute http(s) URL. */
export function isTrackableUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && value.trim() === value && !/\s/.test(value);
  } catch {
    return false;
  }
}

/** 128-bit random URL-safe token (22 chars base64url). */
export function generateLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Returns a copy of `parameters` where each URL-valued entry is replaced by a
 * freshly minted shortlink. Non-URL entries pass through unchanged.
 */
export async function mintTrackedParameters(parameters: string[], opts: MintOptions): Promise<string[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const result: string[] = [];
  for (const value of parameters) {
    if (!isTrackableUrl(value)) {
      result.push(value);
      continue;
    }
    const token = generateLinkToken();
    try {
      await opts.createLink(token, value);
      result.push(`${base}/r/${token}`);
    } catch (err) {
      opts.onError?.(err, value);
      result.push(value);
    }
  }
  return result;
}
