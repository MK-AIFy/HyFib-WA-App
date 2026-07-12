import type { ChannelCredentials, MediaAssetStatus } from "@hyfib/persistence";
import { EventTopics, type EventTopic, type Logger, type MediaFetchRequest } from "@hyfib/shared-core";

/** Minimal media_assets surface needed here (see @hyfib/persistence mediaRepository for the full repo). */
export interface MediaAssetDeps {
  upsertPending(
    tenantId: string,
    input: {
      metaMediaId: string;
      messageId: string;
      conversationId: string;
      mimeType?: string;
      filename?: string;
      sha256?: string;
    }
  ): Promise<{ id: string; status: MediaAssetStatus }>;
  markStored(
    tenantId: string,
    id: string,
    input: { bytes: Buffer; mimeType?: string; fileSizeBytes: number }
  ): Promise<boolean>;
  recordError(tenantId: string, id: string, error: string): Promise<boolean>;
}

export interface MediaFetchDeps {
  media: MediaAssetDeps;
  messages: { mergePayloadById(tenantId: string, messageId: string, patch: Record<string, unknown>): Promise<boolean> };
  /** Existing resolveSendChannel-style creds resolution (channel id -> phone number id + access token). */
  resolveChannel: (tenantId: string, channelId: string) => Promise<ChannelCredentials>;
  fetchMedia: (
    mediaId: string,
    tenantId: string,
    accessToken?: string
  ) => Promise<{ buffer: Buffer; mimeType?: string; fileSizeBytes?: number }>;
  /** Raw bus publish — used only for the best-effort SSE-facing MediaStored notification. */
  publish: (topic: EventTopic, payload: Record<string, unknown>, tenantId: string) => Promise<unknown>;
  logger: Logger;
}

/**
 * Attaches the media asset link onto the originating message's payload under a
 * SEPARATE top-level `mediaAsset` key. `mergePayloadById` is a SHALLOW jsonb
 * merge (`payload || $2`): patching `{media: {assetId}}` would CLOBBER the
 * existing `payload.media` metadata object (mime/sha256/caption) written by
 * handleInbound. `false` (message row gone — SET NULL semantics) is logged,
 * not treated as an error.
 */
async function linkAssetToMessage(
  req: MediaFetchRequest,
  assetId: string,
  status: MediaAssetStatus,
  deps: MediaFetchDeps
): Promise<void> {
  const merged = await deps.messages.mergePayloadById(req.tenantId, req.messageId, {
    mediaAsset: { assetId, status }
  });
  if (!merged) {
    deps.logger.info("media_fetch_message_gone", { tenantId: req.tenantId, messageId: req.messageId, assetId });
  }
}

/**
 * Downloads and stores an inbound media asset requested via
 * EventTopics.MediaFetchRequested. Idempotent by media id: `upsertPending`
 * either creates the pending row or returns the existing one, so a redelivered
 * outbox row (backoff retry, or a genuine replay after a prior success) never
 * double-fetches — a `stored` row short-circuits before any network call.
 *
 * On fetch/store failure this rethrows so the outbox's own retry/backoff/
 * dead-letter machinery is the retry engine; `recordError` is best-effort and
 * must never mask the original error.
 */
export async function processMediaFetch(req: MediaFetchRequest, deps: MediaFetchDeps): Promise<void> {
  const { id: assetId, status } = await deps.media.upsertPending(req.tenantId, {
    metaMediaId: req.mediaId,
    messageId: req.messageId,
    conversationId: req.conversationId,
    mimeType: req.mimeType,
    filename: req.filename,
    sha256: req.sha256
  });

  if (status === "stored") {
    // Replay after a prior success: don't re-fetch, just ensure the link (idempotent).
    await linkAssetToMessage(req, assetId, status, deps);
    deps.logger.info("media_fetch_already_stored", { tenantId: req.tenantId, assetId, mediaId: req.mediaId });
    return;
  }

  try {
    const channel = await deps.resolveChannel(req.tenantId, req.channelId);
    const fetched = await deps.fetchMedia(req.mediaId, req.tenantId, channel.accessToken);
    await deps.media.markStored(req.tenantId, assetId, {
      bytes: fetched.buffer,
      mimeType: fetched.mimeType,
      fileSizeBytes: fetched.fileSizeBytes ?? fetched.buffer.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Guarded: a recordError failure must never mask the original fetch/store error below.
    await deps.media.recordError(req.tenantId, assetId, message).catch((recordError) => {
      deps.logger.warn("media_fetch_record_error_failed", {
        tenantId: req.tenantId,
        assetId,
        error: recordError instanceof Error ? recordError.message : String(recordError)
      });
    });
    deps.logger.error("media_fetch_failed", {
      tenantId: req.tenantId,
      assetId,
      mediaId: req.mediaId,
      error: message
    });
    throw error; // Outbox rails (backoff -> dead-letter -> replay) are the retry engine.
  }

  await linkAssetToMessage(req, assetId, "stored", deps);

  // Best-effort SSE notification — failure here must not fail the job (bytes are
  // already durably stored; a missed live update is not worth a retry/dead-letter).
  try {
    await deps.publish(
      EventTopics.MediaStored,
      { phoneNumberId: req.phoneNumberId, conversationId: req.conversationId, messageId: req.messageId, assetId },
      req.tenantId
    );
  } catch (error) {
    deps.logger.warn("media_stored_publish_failed", {
      tenantId: req.tenantId,
      assetId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  deps.logger.info("media_fetch_stored", { tenantId: req.tenantId, assetId, mediaId: req.mediaId });
}
