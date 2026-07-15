import test from "node:test";
import assert from "node:assert/strict";
import {
  tenantRepository,
  channelRepository,
  contactRepository,
  conversationRepository,
  messageRepository,
  mediaRepository,
  closePool
} from "../dist/index.js";

// These tests require a live PostgreSQL with the schema + app role applied,
// including migration 016_media_assets.sql. CI provides it via service
// containers; locally run with RUN_DB_TESTS=1 (see rls.integration.test.js).
const skip = !process.env.RUN_DB_TESTS;

async function seedMessage(tenantName, contactPhone) {
  const t = await tenantRepository.create(tenantName);
  const channel = await channelRepository.create(t.id, {
    wabaId: `WABA-${tenantName}`,
    phoneNumberId: `PNID-${tenantName}`,
    displayPhoneNumber: "+15550000099"
  });
  const contact = await contactRepository.findOrCreateByPhone(t.id, contactPhone);
  const conversation = await conversationRepository.findOrCreate(t.id, contact.id, channel.id);
  const message = await messageRepository.create(t.id, {
    conversationId: conversation.id,
    direction: "inbound",
    status: "delivered",
    payload: { type: "image", mediaId: "meta-media-1" }
  });
  return { tenant: t, conversation, message };
}

test(
  "upsertPending is idempotent on (tenant, metaMediaId) and preserves message_id via COALESCE",
  { skip },
  async () => {
    const { tenant, conversation, message } = await seedMessage("Media Tenant A", "+15551110001");

    const first = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-1",
      messageId: message.id,
      conversationId: conversation.id,
      mimeType: "image/jpeg"
    });
    assert.equal(first.status, "pending");

    // A second webhook referencing the same media id, but naively passing a
    // different (e.g. null-ish placeholder) messageId — the original must win.
    const otherMessage = await messageRepository.create(tenant.id, {
      conversationId: conversation.id,
      direction: "inbound",
      status: "delivered",
      payload: { type: "image", mediaId: "meta-media-1" }
    });
    const second = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-1",
      messageId: otherMessage.id,
      conversationId: conversation.id,
      mimeType: "image/jpeg"
    });

    assert.equal(second.id, first.id, "same (tenant, metaMediaId) must resolve to the same row");

    const meta = await mediaRepository.getMeta(tenant.id, first.id);
    assert.equal(meta.messageId, message.id, "message_id from the first insert must be preserved (COALESCE)");
  }
);

test(
  "upsertPending enriches mime/filename/sha256 fill-if-null on conflict, never overwriting present values",
  { skip },
  async () => {
    const { tenant, conversation, message } = await seedMessage("Media Tenant Enrich", "+15551110009");

    // First sighting arrives bare — a webhook that referenced the media id
    // without metadata.
    const first = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-enrich",
      messageId: message.id,
      conversationId: conversation.id
    });
    let meta = await mediaRepository.getMeta(tenant.id, first.id);
    assert.equal(meta.mimeType, undefined);
    assert.equal(meta.filename, undefined);
    assert.equal(meta.sha256, undefined);

    // A later replay carries the metadata — it must land on the existing row.
    const second = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-enrich",
      messageId: message.id,
      conversationId: conversation.id,
      mimeType: "image/png",
      filename: "receipt.png",
      sha256: "abc123"
    });
    assert.equal(second.id, first.id);
    meta = await mediaRepository.getMeta(tenant.id, first.id);
    assert.equal(meta.mimeType, "image/png", "null mime_type must be enriched on conflict");
    assert.equal(meta.filename, "receipt.png", "null filename must be enriched on conflict");
    assert.equal(meta.sha256, "abc123", "null sha256 must be enriched on conflict");

    // A third sighting with different values must NOT overwrite what's there.
    await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-enrich",
      messageId: message.id,
      conversationId: conversation.id,
      mimeType: "application/pdf",
      filename: "other.pdf",
      sha256: "zzz999"
    });
    meta = await mediaRepository.getMeta(tenant.id, first.id);
    assert.equal(meta.mimeType, "image/png", "present mime_type must never be overwritten");
    assert.equal(meta.filename, "receipt.png", "present filename must never be overwritten");
    assert.equal(meta.sha256, "abc123", "present sha256 must never be overwritten");
  }
);

test(
  "markStored round-trips bytes and transitions pending -> stored; recordError transitions -> failed",
  { skip },
  async () => {
    const { tenant, conversation, message } = await seedMessage("Media Tenant B", "+15551110002");

    const created = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-2",
      messageId: message.id,
      conversationId: conversation.id
    });
    assert.equal(created.status, "pending");

    const bytes = Buffer.from("hello media bytes", "utf8");
    const stored = await mediaRepository.markStored(tenant.id, created.id, {
      bytes,
      mimeType: "image/png",
      fileSizeBytes: bytes.length
    });
    assert.equal(stored, true);

    const serving = await mediaRepository.getForServing(tenant.id, created.id);
    assert.equal(serving.status, "stored");
    assert.ok(Buffer.isBuffer(serving.bytes));
    assert.equal(serving.bytes.equals(bytes), true, "stored bytes must round-trip exactly");
    assert.equal(serving.mimeType, "image/png");
    assert.equal(serving.fileSizeBytes, bytes.length);

    const meta = await mediaRepository.getMeta(tenant.id, created.id);
    assert.equal(meta.status, "stored");
    assert.equal(meta.error, undefined);

    // A second, independent asset that fails instead of succeeding.
    const failing = await mediaRepository.upsertPending(tenant.id, {
      metaMediaId: "meta-media-2-fail",
      messageId: message.id,
      conversationId: conversation.id
    });
    const errored = await mediaRepository.recordError(tenant.id, failing.id, "Graph API 404: media not found");
    assert.equal(errored, true);

    const failedMeta = await mediaRepository.getMeta(tenant.id, failing.id);
    assert.equal(failedMeta.status, "failed");
    assert.equal(failedMeta.error, "Graph API 404: media not found");

    const failedServing = await mediaRepository.getForServing(tenant.id, failing.id);
    assert.equal(failedServing.status, "failed");
    assert.equal(failedServing.bytes, undefined, "a failed fetch must not have bytes");
  }
);

test("RLS: a second tenant cannot read another tenant's media asset", { skip }, async () => {
  const owner = await seedMessage("Media Tenant Owner", "+15551110003");
  const other = await tenantRepository.create("Media Tenant Other");

  const asset = await mediaRepository.upsertPending(owner.tenant.id, {
    metaMediaId: "meta-media-3",
    messageId: owner.message.id,
    conversationId: owner.conversation.id
  });
  await mediaRepository.markStored(owner.tenant.id, asset.id, {
    bytes: Buffer.from("secret bytes"),
    fileSizeBytes: 12
  });

  const metaAsOther = await mediaRepository.getMeta(other.id, asset.id);
  assert.equal(metaAsOther, undefined, "another tenant must not see the asset's metadata");

  const servingAsOther = await mediaRepository.getForServing(other.id, asset.id);
  assert.equal(servingAsOther, undefined, "another tenant must not be able to fetch the asset's bytes");

  // The owning tenant still can.
  const metaAsOwner = await mediaRepository.getMeta(owner.tenant.id, asset.id);
  assert.ok(metaAsOwner);
});

test(
  "mergePayloadById merges keys into an existing message payload without clobbering other fields",
  { skip },
  async () => {
    const { tenant, conversation } = await seedMessage("Media Tenant Merge", "+15551110004");
    const message = await messageRepository.create(tenant.id, {
      conversationId: conversation.id,
      direction: "inbound",
      status: "delivered",
      payload: { type: "image", mediaId: "meta-media-4", caption: "keep me" }
    });

    const merged = await messageRepository.mergePayloadById(tenant.id, message.id, {
      mediaStatus: "stored",
      mediaAssetId: "some-asset-id"
    });
    assert.equal(merged, true);

    const thread = await messageRepository.listByConversation(tenant.id, conversation.id, { limit: 10 });
    const target = thread.find((m) => m.id === message.id);
    assert.equal(target.payload.caption, "keep me", "pre-existing fields must survive the merge");
    assert.equal(target.payload.mediaId, "meta-media-4");
    assert.equal(target.payload.mediaStatus, "stored");
    assert.equal(target.payload.mediaAssetId, "some-asset-id");

    const missing = await messageRepository.mergePayloadById(tenant.id, "00000000-0000-0000-0000-000000000000", {
      x: 1
    });
    assert.equal(missing, false, "merging a non-existent message id returns false");
  }
);

test.after(async () => {
  if (!skip) {
    await closePool();
  }
});
