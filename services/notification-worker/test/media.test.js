import test from "node:test";
import assert from "node:assert/strict";
import { processMediaFetch } from "../dist/media.js";

function createFakeLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    logs,
    info(message, meta) {
      logs.info.push({ message, meta });
    },
    warn(message, meta) {
      logs.warn.push({ message, meta });
    },
    error(message, meta) {
      logs.error.push({ message, meta });
    },
    debug(message, meta) {
      logs.debug.push({ message, meta });
    }
  };
}

function baseRequest(overrides = {}) {
  return {
    tenantId: "t-1",
    channelId: "c-1",
    phoneNumberId: "PN-1",
    conversationId: "conv-1",
    messageId: "m-1",
    mediaId: "wamid.media-1",
    mimeType: "image/jpeg",
    filename: "photo.jpg",
    sha256: "abc123",
    ...overrides
  };
}

test("processMediaFetch: happy path fetches, stores, links the asset and publishes MediaStored", async () => {
  const logger = createFakeLogger();
  const upsertCalls = [];
  const markStoredCalls = [];
  const mergeCalls = [];
  const publishCalls = [];
  const resolveChannelCalls = [];
  const fetchMediaCalls = [];

  const buffer = Buffer.from("bytes-here");

  const deps = {
    media: {
      async upsertPending(tenantId, input) {
        upsertCalls.push({ tenantId, input });
        return { id: "asset-1", status: "pending" };
      },
      async markStored(tenantId, id, input) {
        markStoredCalls.push({ tenantId, id, input });
        return true;
      },
      async recordError() {
        throw new Error("must not be called on success");
      }
    },
    messages: {
      async mergePayloadById(tenantId, messageId, patch) {
        mergeCalls.push({ tenantId, messageId, patch });
        return true;
      }
    },
    async resolveChannel(tenantId, channelId) {
      resolveChannelCalls.push({ tenantId, channelId });
      return { id: channelId, wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok-1" };
    },
    async fetchMedia(mediaId, tenantId, accessToken) {
      fetchMediaCalls.push({ mediaId, tenantId, accessToken });
      return { buffer, mimeType: "image/jpeg", fileSizeBytes: buffer.length };
    },
    async publish(topic, payload, tenantId) {
      publishCalls.push({ topic, payload, tenantId });
      return {};
    },
    logger
  };

  await processMediaFetch(baseRequest(), deps);

  assert.equal(upsertCalls.length, 1);
  assert.deepEqual(upsertCalls[0].input, {
    metaMediaId: "wamid.media-1",
    messageId: "m-1",
    conversationId: "conv-1",
    mimeType: "image/jpeg",
    filename: "photo.jpg",
    sha256: "abc123"
  });

  assert.equal(resolveChannelCalls.length, 1);
  assert.deepEqual(resolveChannelCalls[0], { tenantId: "t-1", channelId: "c-1" });

  assert.equal(fetchMediaCalls.length, 1);
  assert.deepEqual(fetchMediaCalls[0], { mediaId: "wamid.media-1", tenantId: "t-1", accessToken: "tok-1" });

  assert.equal(markStoredCalls.length, 1);
  assert.equal(markStoredCalls[0].id, "asset-1");
  assert.equal(markStoredCalls[0].input.bytes, buffer);
  assert.equal(markStoredCalls[0].input.mimeType, "image/jpeg");
  assert.equal(markStoredCalls[0].input.fileSizeBytes, buffer.length);

  assert.equal(mergeCalls.length, 1);
  assert.deepEqual(mergeCalls[0].patch, { mediaAsset: { assetId: "asset-1", status: "stored" } });

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].topic, "media.stored");
  assert.deepEqual(publishCalls[0].payload, {
    phoneNumberId: "PN-1",
    conversationId: "conv-1",
    messageId: "m-1",
    assetId: "asset-1"
  });
  assert.equal(publishCalls[0].tenantId, "t-1");
});

test("processMediaFetch: already-stored short-circuits — no fetch/markStored, merge still ensured", async () => {
  const logger = createFakeLogger();
  const mergeCalls = [];
  let fetchMediaCalls = 0;
  let markStoredCalls = 0;
  let resolveChannelCalls = 0;

  const deps = {
    media: {
      async upsertPending() {
        return { id: "asset-1", status: "stored" };
      },
      async markStored() {
        markStoredCalls++;
        return true;
      },
      async recordError() {
        throw new Error("must not be called");
      }
    },
    messages: {
      async mergePayloadById(tenantId, messageId, patch) {
        mergeCalls.push({ tenantId, messageId, patch });
        return true;
      }
    },
    async resolveChannel() {
      resolveChannelCalls++;
      return { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok-1" };
    },
    async fetchMedia() {
      fetchMediaCalls++;
      throw new Error("must not be called — already stored");
    },
    async publish() {
      throw new Error("must not be called — already stored means no fresh MediaStored");
    },
    logger
  };

  await processMediaFetch(baseRequest(), deps);

  assert.equal(fetchMediaCalls, 0, "fetchMedia must not be called when the asset is already stored");
  assert.equal(markStoredCalls, 0, "markStored must not be called when the asset is already stored");
  assert.equal(resolveChannelCalls, 0, "channel resolution is unnecessary when short-circuiting");
  assert.equal(mergeCalls.length, 1, "the payload link must still be ensured (idempotent)");
  assert.deepEqual(mergeCalls[0].patch, { mediaAsset: { assetId: "asset-1", status: "stored" } });
});

test("processMediaFetch: fetch failure records the error and rethrows the same error", async () => {
  const logger = createFakeLogger();
  const recordErrorCalls = [];
  const originalError = new Error("meta_adapter_media_fetch_failed_502");

  const deps = {
    media: {
      async upsertPending() {
        return { id: "asset-1", status: "pending" };
      },
      async markStored() {
        throw new Error("must not be called on fetch failure");
      },
      async recordError(tenantId, id, message) {
        recordErrorCalls.push({ tenantId, id, message });
        return true;
      }
    },
    messages: {
      async mergePayloadById() {
        throw new Error("must not be called — the flow throws before linking on failure");
      }
    },
    async resolveChannel() {
      return { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok-1" };
    },
    async fetchMedia() {
      throw originalError;
    },
    async publish() {
      throw new Error("must not be called on fetch failure");
    },
    logger
  };

  await assert.rejects(
    () => processMediaFetch(baseRequest(), deps),
    (error) => error === originalError
  );

  assert.equal(recordErrorCalls.length, 1);
  assert.deepEqual(recordErrorCalls[0], { tenantId: "t-1", id: "asset-1", message: originalError.message });
});

test("processMediaFetch: recordError failure does not mask the original error", async () => {
  const logger = createFakeLogger();
  const originalError = new Error("meta_adapter_media_fetch_failed_502");

  const deps = {
    media: {
      async upsertPending() {
        return { id: "asset-1", status: "pending" };
      },
      async markStored() {
        throw new Error("must not be called on fetch failure");
      },
      async recordError() {
        throw new Error("db_write_failed");
      }
    },
    messages: {
      async mergePayloadById() {
        throw new Error("must not be called — the flow throws before linking on failure");
      }
    },
    async resolveChannel() {
      return { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok-1" };
    },
    async fetchMedia() {
      throw originalError;
    },
    async publish() {
      throw new Error("must not be called on fetch failure");
    },
    logger
  };

  await assert.rejects(
    () => processMediaFetch(baseRequest(), deps),
    (error) => error === originalError
  );
  assert.ok(
    logger.logs.warn.some((entry) => entry.message === "media_fetch_record_error_failed"),
    "the recordError failure should be logged, not swallowed silently"
  );
});

test("processMediaFetch: MediaStored publish failure does not fail the job", async () => {
  const logger = createFakeLogger();
  const buffer = Buffer.from("bytes-here");

  const deps = {
    media: {
      async upsertPending() {
        return { id: "asset-1", status: "pending" };
      },
      async markStored() {
        return true;
      },
      async recordError() {
        throw new Error("must not be called on success");
      }
    },
    messages: {
      async mergePayloadById() {
        return true;
      }
    },
    async resolveChannel() {
      return { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok-1" };
    },
    async fetchMedia() {
      return { buffer, mimeType: "image/jpeg", fileSizeBytes: buffer.length };
    },
    async publish() {
      throw new Error("sse_bus_unavailable");
    },
    logger
  };

  // Must resolve, not reject — bytes are already durably stored, so a failed
  // best-effort SSE notification must not fail (and retry) the whole job.
  await processMediaFetch(baseRequest(), deps);

  assert.ok(
    logger.logs.warn.some((entry) => entry.message === "media_stored_publish_failed"),
    "the publish failure should be logged, not swallowed silently"
  );
});
