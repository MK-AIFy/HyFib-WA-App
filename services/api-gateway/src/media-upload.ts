/**
 * Pure mapping from the media-upload proxy's {status, body} result to the
 * gateway's client-facing response. Kept separate from index.ts so the
 * mapping is unit-testable without booting the gateway (same pattern as
 * media-headers.ts).
 *
 * Contract:
 * - 2xx with a mediaId -> uploaded (the route audits and answers 201)
 * - 4xx                -> passed through verbatim, so adapter-side validation
 *                         (including 413 media_too_large with maxBytes)
 *                         surfaces with its real reason instead of a 502
 * - 503                -> 503 meta_adapter_unavailable (adapter down or the
 *                         upload deadline was exceeded)
 * - anything else      -> 502 media_upload_failed (Meta rejected the upload
 *                         or returned an unusable response)
 */
export type MediaUploadOutcome =
  | { kind: "uploaded"; mediaId: string }
  | { kind: "error"; status: number; body: Record<string, unknown> };

export function mapMediaUploadProxyResult(status: number, body: Record<string, unknown>): MediaUploadOutcome {
  const mediaId = typeof body.mediaId === "string" && body.mediaId.length > 0 ? body.mediaId : undefined;
  if (status >= 200 && status < 300 && mediaId) {
    return { kind: "uploaded", mediaId };
  }
  if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
    return { kind: "error", status, body };
  }
  const detail = typeof body.error === "string" ? body.error : "meta error";
  if (status === 503) {
    const details = typeof body.details === "string" ? body.details : undefined;
    return { kind: "error", status: 503, body: { error: "meta_adapter_unavailable", detail: details ?? detail } };
  }
  return { kind: "error", status: 502, body: { error: "media_upload_failed", detail } };
}
