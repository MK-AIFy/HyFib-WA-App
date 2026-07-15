import type { Message } from "@hyfib/shared-core";

export type MediaKind = "image" | "audio" | "video" | "document";

/** Buckets a MIME type into a rendering strategy; unknown/missing types fall back to "document". */
export function mediaKind(mime?: string): MediaKind {
  if (!mime) return "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

export interface MediaInfo {
  assetId?: string;
  assetStatus?: string;
  mimeType?: string;
  filename?: string;
}

/**
 * Reads a message's media info out of its two separate payload keys:
 * `payload.media` (metadata recorded at inbound time — mimeType/filename/etc.)
 * and `payload.mediaAsset` (linked once the async fetch completes, carrying
 * assetId/status). A message with neither key has no media at all.
 */
export function mediaAssetOf(message: Pick<Message, "payload">): MediaInfo | undefined {
  const payload = message.payload as {
    media?: { mimeType?: string; filename?: string };
    mediaAsset?: { assetId?: string; status?: string };
  };

  if (!payload.media && !payload.mediaAsset) {
    return undefined;
  }

  return {
    assetId: payload.mediaAsset?.assetId,
    assetStatus: payload.mediaAsset?.status,
    mimeType: payload.media?.mimeType,
    filename: payload.media?.filename
  };
}
