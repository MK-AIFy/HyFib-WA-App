import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkerConsumers } from "../dist/index.js";
import { channelRepository, messageRepository, contactRepository, autoReplyRuleRepository } from "@hyfib/persistence";
import { EventTopics } from "@hyfib/shared-core";

/**
 * These tests exercise the real handleOutbound/handleInbound consumers (captured via a
 * fake event bus, the same technique consumers.test.js uses to verify wiring) rather than
 * duplicating their logic. Redis and the phone-number → channel resolver are swapped via
 * WorkerDeps (the same DI seam already used for eventBus/metaClient); DB-backed repository
 * singletons are monkey-patched for the duration of each test since they're shared, mutable
 * objects imported from @hyfib/persistence — no real Postgres/Redis is touched.
 */

function createFakeBus() {
  const handlers = new Map();
  return {
    handlers,
    subscribe(topic, _queue, handler) {
      handlers.set(topic, handler);
    },
    async publish() {},
    async close() {}
  };
}

/** In-memory stand-in for ioredis's SET key value EX seconds NX / DEL key semantics. */
function createFakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, exFlag, ttlSeconds, nxFlag) {
      if (nxFlag === "NX" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    }
  };
}

function createFakeMetaClient(sendImpl) {
  return {
    async send(endpoint, tenantId, payload) {
      return sendImpl(endpoint, tenantId, payload);
    },
    async markRead() {}
  };
}

function outboundEvent(id, dispatchId) {
  return {
    id,
    topic: EventTopics.WhatsAppOutboundRequested,
    occurredAt: new Date().toISOString(),
    payload: {
      tenantId: "t-1",
      channelId: "c-1",
      conversationId: "conv-1",
      contactPhoneE164: "+15551230000",
      kind: "text",
      text: "hello",
      ...(dispatchId ? { dispatchId } : {})
    }
  };
}

test("handleOutbound: dispatchId claim — first call sends, replayed dispatchId skips", async () => {
  const bus = createFakeBus();
  const redis = createFakeRedis();
  let sendCalls = 0;
  let createCalls = 0;
  const metaClient = createFakeMetaClient(async () => {
    sendCalls++;
    return { messageId: `wamid.${sendCalls}`, accepted: true };
  });

  const originalGetCredentials = channelRepository.getCredentials;
  const originalCreate = messageRepository.create;
  channelRepository.getCredentials = async () => ({ id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" });
  messageRepository.create = async () => {
    createCalls++;
    return { id: "m-1" };
  };

  try {
    registerWorkerConsumers({ eventBus: bus, redis, metaClient });
    const handleOutbound = bus.handlers.get(EventTopics.WhatsAppOutboundRequested);

    await handleOutbound(outboundEvent("env-1", "dispatch-abc"));
    assert.equal(sendCalls, 1, "first call should send");
    assert.equal(createCalls, 1, "first call should persist the outbound message");

    // Replay: same dispatchId, new envelope id (as a re-published outbox row would carry).
    await handleOutbound(outboundEvent("env-2", "dispatch-abc"));
    assert.equal(sendCalls, 1, "replay must not send again");
    assert.equal(createCalls, 1, "replay must not persist again");
  } finally {
    channelRepository.getCredentials = originalGetCredentials;
    messageRepository.create = originalCreate;
  }
});

test("handleOutbound: send failure releases the dispatch claim and rethrows", async () => {
  const bus = createFakeBus();
  const redis = createFakeRedis();
  const metaClient = createFakeMetaClient(async () => {
    throw new Error("meta_adapter_rejected_500");
  });

  const originalGetCredentials = channelRepository.getCredentials;
  channelRepository.getCredentials = async () => ({ id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" });

  try {
    registerWorkerConsumers({ eventBus: bus, redis, metaClient });
    const handleOutbound = bus.handlers.get(EventTopics.WhatsAppOutboundRequested);

    await assert.rejects(
      () => handleOutbound(outboundEvent("env-1", "dispatch-fail")),
      /meta_adapter_rejected_500/
    );
    assert.equal(redis.store.has("outb:dispatch-fail"), false, "claim key must be released after send failure");
  } finally {
    channelRepository.getCredentials = originalGetCredentials;
  }
});

test("handleOutbound: pre-send failure (channel resolution) releases the dispatch claim and rethrows", async () => {
  const bus = createFakeBus();
  const redis = createFakeRedis();
  const metaClient = createFakeMetaClient(async () => {
    throw new Error("must not be called — failure happens before send");
  });

  const originalGetCredentials = channelRepository.getCredentials;
  channelRepository.getCredentials = async () => {
    throw new Error("channel_lookup_failed");
  };

  try {
    registerWorkerConsumers({ eventBus: bus, redis, metaClient });
    const handleOutbound = bus.handlers.get(EventTopics.WhatsAppOutboundRequested);

    await assert.rejects(
      () => handleOutbound(outboundEvent("env-1", "dispatch-presend-fail")),
      /channel_lookup_failed/
    );
    assert.equal(
      redis.store.has("outb:dispatch-presend-fail"),
      false,
      "claim key must be released on a pre-send failure, not just an adapter-call failure"
    );
  } finally {
    channelRepository.getCredentials = originalGetCredentials;
  }
});

test("handleOutbound: retry after a pre-send failure re-claims and sends (drop bug fixed)", async () => {
  const bus = createFakeBus();
  const redis = createFakeRedis();
  let sendCalls = 0;
  let createCalls = 0;
  const metaClient = createFakeMetaClient(async () => {
    sendCalls++;
    return { messageId: `wamid.${sendCalls}`, accepted: true };
  });

  const originalGetCredentials = channelRepository.getCredentials;
  const originalCreate = messageRepository.create;
  let failChannelLookup = true;
  channelRepository.getCredentials = async () => {
    if (failChannelLookup) {
      throw new Error("channel_lookup_failed");
    }
    return { id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" };
  };
  messageRepository.create = async () => {
    createCalls++;
    return { id: "m-1" };
  };

  try {
    registerWorkerConsumers({ eventBus: bus, redis, metaClient });
    const handleOutbound = bus.handlers.get(EventTopics.WhatsAppOutboundRequested);

    // First attempt: pre-send failure releases the claim instead of leaking it.
    await assert.rejects(() => handleOutbound(outboundEvent("env-1", "dispatch-retry")));
    assert.equal(sendCalls, 0, "the pre-send failure must occur before any send attempt");
    assert.equal(redis.store.has("outb:dispatch-retry"), false, "claim released after the pre-send failure");

    // Retry: same dispatchId, new envelope id (as a re-published outbox row would carry),
    // channel lookup now succeeds — this must NOT be skipped as an "already claimed" replay.
    failChannelLookup = false;
    await handleOutbound(outboundEvent("env-2", "dispatch-retry"));
    assert.equal(sendCalls, 1, "retry with the same dispatchId must actually send — proves the drop bug is gone");
    assert.equal(createCalls, 1, "retry must persist the outbound message");
    assert.equal(redis.store.has("outb:dispatch-retry"), true, "the successful send re-establishes the claim");
  } finally {
    channelRepository.getCredentials = originalGetCredentials;
    messageRepository.create = originalCreate;
  }
});

test("handleOutbound: no dispatchId sends without touching the redis guard", async () => {
  const bus = createFakeBus();
  const redis = createFakeRedis();
  let setCalls = 0;
  let delCalls = 0;
  const baseSet = redis.set.bind(redis);
  const baseDel = redis.del.bind(redis);
  redis.set = async (...args) => {
    setCalls++;
    return baseSet(...args);
  };
  redis.del = async (...args) => {
    delCalls++;
    return baseDel(...args);
  };

  let sendCalls = 0;
  const metaClient = createFakeMetaClient(async () => {
    sendCalls++;
    return { messageId: "wamid.999", accepted: true };
  });

  const originalGetCredentials = channelRepository.getCredentials;
  const originalCreate = messageRepository.create;
  channelRepository.getCredentials = async () => ({ id: "c-1", wabaId: "waba-1", phoneNumberId: "PN-1", accessToken: "tok" });
  messageRepository.create = async () => ({ id: "m-1" });

  try {
    registerWorkerConsumers({ eventBus: bus, redis, metaClient });
    const handleOutbound = bus.handlers.get(EventTopics.WhatsAppOutboundRequested);

    await handleOutbound(outboundEvent("env-1"));
    assert.equal(sendCalls, 1, "send should still happen without a dispatchId");
    assert.equal(setCalls, 0, "no dispatchId means the redis guard must not be touched");
    assert.equal(delCalls, 0, "no dispatchId means nothing to release");
  } finally {
    channelRepository.getCredentials = originalGetCredentials;
    messageRepository.create = originalCreate;
  }
});

test("handleInbound: replayed external message id skips message insert and auto-reply", async () => {
  const bus = createFakeBus();
  const resolveChannel = async () => ({ tenantId: "t-1", channelId: "c-1" });

  const originalFindByExternalId = messageRepository.findByExternalId;
  const originalCreate = messageRepository.create;
  const originalListEnabled = autoReplyRuleRepository.listEnabled;
  const originalFindOrCreateByPhone = contactRepository.findOrCreateByPhone;

  let createCalls = 0;
  let autoReplyCalls = 0;
  let contactCalls = 0;
  messageRepository.findByExternalId = async () => ({ id: "existing-msg" });
  messageRepository.create = async () => {
    createCalls++;
    throw new Error("must not be called on replay");
  };
  autoReplyRuleRepository.listEnabled = async () => {
    autoReplyCalls++;
    return [];
  };
  contactRepository.findOrCreateByPhone = async () => {
    contactCalls++;
    throw new Error("must not be called on replay");
  };

  try {
    registerWorkerConsumers({ eventBus: bus, resolveChannel });
    const handleInbound = bus.handlers.get(EventTopics.WhatsAppInboundReceived);

    await handleInbound({
      id: "env-1",
      topic: EventTopics.WhatsAppInboundReceived,
      occurredAt: new Date().toISOString(),
      payload: {
        phoneNumberId: "PN-1",
        from: "+15559998888",
        messageId: "wamid.replayed",
        type: "text",
        text: "hi again"
      }
    });

    assert.equal(createCalls, 0, "replay must not insert a message row");
    assert.equal(autoReplyCalls, 0, "replay must not evaluate auto-reply rules");
    assert.equal(contactCalls, 0, "replay must not even look up the contact");
  } finally {
    messageRepository.findByExternalId = originalFindByExternalId;
    messageRepository.create = originalCreate;
    autoReplyRuleRepository.listEnabled = originalListEnabled;
    contactRepository.findOrCreateByPhone = originalFindOrCreateByPhone;
  }
});

/**
 * Self-healing media re-enqueue on the replay-guard skip branch: if a prior run committed
 * the message row but then failed to enqueue MediaFetchRequested (separate transaction; a
 * transient DB error between the two), the media would otherwise be permanently orphaned
 * since replays never reach the main (non-skip) path. These three tests exercise the skip
 * branch's re-enqueue decision via the enqueueMediaFetch WorkerDeps seam, which stands in
 * for the real withTenant/outboxRepository.enqueue write (untestable here without Postgres).
 */
function replayedInboundEvent(overrides = {}) {
  return {
    id: "env-replay",
    topic: EventTopics.WhatsAppInboundReceived,
    occurredAt: new Date().toISOString(),
    payload: {
      phoneNumberId: "PN-1",
      from: "+15559998888",
      messageId: "wamid.replayed-media",
      type: "image",
      ...overrides
    }
  };
}

test("handleInbound replay: media present, no existing mediaAsset link — re-enqueues (heals the orphan)", async () => {
  const bus = createFakeBus();
  const resolveChannel = async () => ({ tenantId: "t-1", channelId: "c-1" });

  const originalFindByExternalId = messageRepository.findByExternalId;
  const originalCreate = messageRepository.create;
  const originalFindOrCreateByPhone = contactRepository.findOrCreateByPhone;

  const enqueueCalls = [];
  const enqueueMediaFetch = async (channel, phoneNumberId, conversationId, messageId, media) => {
    enqueueCalls.push({ channel, phoneNumberId, conversationId, messageId, media });
  };

  messageRepository.findByExternalId = async () => ({
    id: "existing-msg-1",
    conversationId: "conv-existing-1",
    payload: { type: "image" } // no mediaAsset link — the fetch never completed
  });
  messageRepository.create = async () => {
    throw new Error("must not be called on replay");
  };
  contactRepository.findOrCreateByPhone = async () => {
    throw new Error("must not be called on replay");
  };

  try {
    registerWorkerConsumers({ eventBus: bus, resolveChannel, enqueueMediaFetch });
    const handleInbound = bus.handlers.get(EventTopics.WhatsAppInboundReceived);

    await handleInbound(
      replayedInboundEvent({
        media: { id: "wamid.media-orphan", mimeType: "image/jpeg", sha256: "abc123", filename: "photo.jpg" }
      })
    );

    assert.equal(enqueueCalls.length, 1, "the orphaned media fetch must be re-enqueued");
    assert.deepEqual(enqueueCalls[0].channel, { tenantId: "t-1", channelId: "c-1" });
    assert.equal(enqueueCalls[0].phoneNumberId, "PN-1");
    assert.equal(enqueueCalls[0].conversationId, "conv-existing-1", "must use the existing message's conversation");
    assert.equal(enqueueCalls[0].messageId, "existing-msg-1", "must use the existing message's DB id");
    assert.deepEqual(enqueueCalls[0].media, {
      id: "wamid.media-orphan",
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      sha256: "abc123"
    });
  } finally {
    messageRepository.findByExternalId = originalFindByExternalId;
    messageRepository.create = originalCreate;
    contactRepository.findOrCreateByPhone = originalFindOrCreateByPhone;
  }
});

test("handleInbound replay: media present, existing mediaAsset link — does not re-enqueue", async () => {
  const bus = createFakeBus();
  const resolveChannel = async () => ({ tenantId: "t-1", channelId: "c-1" });

  const originalFindByExternalId = messageRepository.findByExternalId;
  const originalCreate = messageRepository.create;
  const originalFindOrCreateByPhone = contactRepository.findOrCreateByPhone;

  const enqueueCalls = [];
  const enqueueMediaFetch = async (...args) => {
    enqueueCalls.push(args);
  };

  messageRepository.findByExternalId = async () => ({
    id: "existing-msg-2",
    conversationId: "conv-existing-2",
    payload: { type: "image", mediaAsset: { assetId: "asset-1", status: "stored" } }
  });
  messageRepository.create = async () => {
    throw new Error("must not be called on replay");
  };
  contactRepository.findOrCreateByPhone = async () => {
    throw new Error("must not be called on replay");
  };

  try {
    registerWorkerConsumers({ eventBus: bus, resolveChannel, enqueueMediaFetch });
    const handleInbound = bus.handlers.get(EventTopics.WhatsAppInboundReceived);

    await handleInbound(
      replayedInboundEvent({
        media: { id: "wamid.media-linked", mimeType: "image/jpeg", sha256: "abc123", filename: "photo.jpg" }
      })
    );

    assert.equal(enqueueCalls.length, 0, "an already-linked media asset must not be re-enqueued");
  } finally {
    messageRepository.findByExternalId = originalFindByExternalId;
    messageRepository.create = originalCreate;
    contactRepository.findOrCreateByPhone = originalFindOrCreateByPhone;
  }
});

test("handleInbound replay: no media on the event — fast path, no enqueue and no extra repo reads", async () => {
  const bus = createFakeBus();
  const resolveChannel = async () => ({ tenantId: "t-1", channelId: "c-1" });

  const originalFindByExternalId = messageRepository.findByExternalId;
  const originalCreate = messageRepository.create;
  const originalFindOrCreateByPhone = contactRepository.findOrCreateByPhone;

  const enqueueCalls = [];
  const enqueueMediaFetch = async (...args) => {
    enqueueCalls.push(args);
  };

  let findByExternalIdCalls = 0;
  messageRepository.findByExternalId = async () => {
    findByExternalIdCalls++;
    return { id: "existing-msg-3", conversationId: "conv-existing-3", payload: { type: "text" } };
  };
  messageRepository.create = async () => {
    throw new Error("must not be called on replay");
  };
  contactRepository.findOrCreateByPhone = async () => {
    throw new Error("must not be called on replay");
  };

  try {
    registerWorkerConsumers({ eventBus: bus, resolveChannel, enqueueMediaFetch });
    const handleInbound = bus.handlers.get(EventTopics.WhatsAppInboundReceived);

    await handleInbound(replayedInboundEvent({ type: "text", text: "hi again" }));

    assert.equal(enqueueCalls.length, 0, "no media on the event means nothing to re-enqueue");
    assert.equal(findByExternalIdCalls, 1, "the guard's single lookup must not be followed by extra reads");
  } finally {
    messageRepository.findByExternalId = originalFindByExternalId;
    messageRepository.create = originalCreate;
    contactRepository.findOrCreateByPhone = originalFindOrCreateByPhone;
  }
});
