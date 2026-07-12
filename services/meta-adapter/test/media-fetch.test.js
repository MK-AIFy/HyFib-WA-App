import test from "node:test";
import assert from "node:assert/strict";
import { fetchMediaDirect } from "../dist/index.js";

const RESOLVE_URL_PREFIX = "https://graph.facebook.com/";

/**
 * Builds a fake fetchImpl that returns queued Response objects in order and
 * records every call (url + headers) so tests can assert on call count,
 * target host and the Authorization header carried on each request.
 */
function queuedFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (index >= responses.length) {
      throw new Error(`queuedFetch: no queued response left for call ${index + 1} (${url})`);
    }
    const response = responses[index];
    index += 1;
    return response;
  };
  return { fetchImpl, calls };
}

function resolveResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function downloadResponse(bytes, { status = 200, contentType, contentLength } = {}) {
  const headers = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Response(bytes, { status, headers });
}

/**
 * A download Response that reports ok/headers normally but whose body-read
 * (arrayBuffer) rejects — simulating the AbortSignal firing mid-stream or a
 * network error surfacing only once the body is consumed.
 */
function downloadResponseWithFailingBody({ status = 200, contentType, contentLength } = {}) {
  const headers = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  const response = new Response(null, { status, headers });
  response.arrayBuffer = () => Promise.reject(new Error("simulated body read failure"));
  return response;
}

test("fetchMediaDirect: happy path returns buffer + mime + sha256, both calls carry the bearer token", async () => {
  const bytes = Buffer.from("fake-image-bytes");
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/1", mime_type: "image/png", sha256: "abc123", file_size: bytes.length }),
    downloadResponse(bytes, { contentType: "image/png" })
  ]);

  const result = await fetchMediaDirect("media-1", "test-token", { fetchImpl, requestId: "req-1" });

  assert.equal(result.status, 200);
  assert.ok(result.media);
  assert.ok(Buffer.from(result.media.buffer).equals(bytes));
  assert.equal(result.media.mimeType, "image/png");
  assert.equal(result.media.sha256, "abc123");
  assert.equal(result.media.fileSizeBytes, bytes.length);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${RESOLVE_URL_PREFIX}v22.0/media-1`);
  assert.equal(calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(calls[1].url, "https://lookaside.fbsbx.com/blob/1");
  assert.equal(calls[1].headers.Authorization, "Bearer test-token");
});

test("fetchMediaDirect: expired download URL triggers a fresh resolve + retry that succeeds", async () => {
  const bytes = Buffer.from("fresh-bytes");
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/expired", mime_type: "image/jpeg" }),
    downloadResponse(Buffer.from(""), { status: 404 }),
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/fresh", mime_type: "image/jpeg" }),
    downloadResponse(bytes, { contentType: "image/jpeg" })
  ]);

  const result = await fetchMediaDirect("media-2", "test-token", { fetchImpl });

  assert.equal(result.status, 200);
  assert.ok(Buffer.from(result.media.buffer).equals(bytes));

  // Two resolve calls (fresh URL each time) and two download calls.
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, `${RESOLVE_URL_PREFIX}v22.0/media-2`);
  assert.equal(calls[1].url, "https://lookaside.fbsbx.com/blob/expired");
  assert.equal(calls[2].url, `${RESOLVE_URL_PREFIX}v22.0/media-2`);
  assert.equal(calls[3].url, "https://lookaside.fbsbx.com/blob/fresh");
});

test("fetchMediaDirect: content-length over the cap is rejected with 413 before downloading the body", async () => {
  const overCapBytes = 16 * 1024 * 1024 + 1;
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/big" }),
    downloadResponse(Buffer.from("irrelevant-small-body"), { contentLength: overCapBytes })
  ]);

  const result = await fetchMediaDirect("media-3", "test-token", { fetchImpl });

  assert.equal(result.status, 413);
  assert.equal(result.error, "media_too_large");
  assert.equal(result.media, undefined);
  assert.equal(calls.length, 2, "cap failures are not retried");
});

test("fetchMediaDirect: body larger than the cap is rejected even when content-length lies", async () => {
  const actualOverCapBytes = Buffer.alloc(16 * 1024 * 1024 + 1);
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/lying-header" }),
    downloadResponse(actualOverCapBytes, { contentLength: 10 })
  ]);

  const result = await fetchMediaDirect("media-3b", "test-token", { fetchImpl });

  assert.equal(result.status, 413);
  assert.equal(result.error, "media_too_large");
  assert.equal(calls.length, 2);
});

test("fetchMediaDirect: missing token (no accessToken, no config default) errors without calling fetch", async () => {
  const { fetchImpl, calls } = queuedFetch([]);

  const result = await fetchMediaDirect("media-4", undefined, { fetchImpl });

  assert.equal(result.status, 503);
  assert.equal(result.error, "meta_adapter_unavailable");
  assert.equal(result.media, undefined);
  assert.equal(calls.length, 0, "no HTTP calls should be made without a token");
});

test("fetchMediaDirect: non-OK resolve response maps to an error result without attempting a download", async () => {
  const { fetchImpl, calls } = queuedFetch([resolveResponse({ error: { message: "Unsupported get request" } }, 404)]);

  const result = await fetchMediaDirect("media-5", "test-token", { fetchImpl });

  assert.equal(result.status, 502);
  assert.equal(result.error, "meta_media_failed");
  assert.equal(result.media, undefined);
  assert.equal(calls.length, 1, "no download call should be attempted after a failed resolve");
});

test("fetchMediaDirect: download 500 (non-retryable) maps to 502 with a single resolve/download pair", async () => {
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/server-error" }),
    downloadResponse(Buffer.from(""), { status: 500 })
  ]);

  const result = await fetchMediaDirect("media-6", "test-token", { fetchImpl });

  assert.equal(result.status, 502);
  assert.equal(result.error, "meta_media_download_failed");
  assert.equal(result.media, undefined);
  assert.equal(calls.length, 2, "500 is non-retryable: only one resolve + one download call");
  assert.equal(
    calls.filter((call) => call.url.startsWith(RESOLVE_URL_PREFIX)).length,
    1,
    "no second resolve call for a non-retryable download failure"
  );
});

test("fetchMediaDirect: download body-read failure (arrayBuffer rejects) resolves to a network outcome, not an unhandled rejection", async () => {
  const { fetchImpl, calls } = queuedFetch([
    resolveResponse({ url: "https://lookaside.fbsbx.com/blob/body-fail" }),
    downloadResponseWithFailingBody()
  ]);

  // Awaiting here proves the rejection inside downloadMediaBytes/arrayBuffer()
  // was caught and mapped to a result rather than escaping the promise chain.
  const result = await fetchMediaDirect("media-7", "test-token", { fetchImpl });

  assert.equal(result.status, 503);
  assert.equal(result.error, "meta_adapter_unavailable");
  assert.equal(result.media, undefined);
  assert.equal(calls.length, 2, "network-kind failures during body read are not retried");
});
