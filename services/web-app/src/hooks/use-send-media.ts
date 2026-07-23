import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WhatsAppMediaKind } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import type { MediaSendPayload, SendMessageBody } from "./use-conversations";

/** Mirrors the gateway's MEDIA_UPLOAD_MAX_BYTES so oversized files fail fast client-side. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Buckets a file's MIME type into the WhatsApp outbound media type. Stickers
 * are never inferred (they need exact webp dimensions Meta enforces), so
 * anything that isn't image/video/audio ships as a document.
 */
export function whatsAppMediaType(mime: string): Exclude<WhatsAppMediaKind, "sticker"> {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export interface SendMediaInput {
  file: File;
  caption?: string;
}

/**
 * Two-step media send: upload the raw bytes through the gateway's channel
 * media route (which proxies to Meta and returns Meta's media id), then POST
 * the conversation send with `kind: "media"` referencing that id. One mutation
 * so the dialog gets a single pending/error state; an upload failure never
 * reaches the send step. Caption rules follow Meta: trimmed, dropped when
 * blank, never sent for audio; filename only means something for documents.
 */
export function useSendMedia(conversationId: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, caption }: SendMediaInput) => {
      const mediaType = whatsAppMediaType(file.type);
      const { mediaId } = await api.postBinary<{ mediaId: string }>(
        `/api/v1/channels/whatsapp/${channelId}/media?filename=${encodeURIComponent(file.name)}`,
        file,
        file.type || "application/octet-stream"
      );

      const media: MediaSendPayload = { mediaType, mediaId };
      const trimmedCaption = caption?.trim();
      if (trimmedCaption && mediaType !== "audio") media.caption = trimmedCaption;
      if (mediaType === "document") media.filename = file.name;

      const body: SendMessageBody = { kind: "media", media };
      return api.post<{ status: string; kind: string }>(`/api/v1/conversations/${conversationId}/messages`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  });
}
