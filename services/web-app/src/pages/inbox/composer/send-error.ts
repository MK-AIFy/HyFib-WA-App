import { ApiError } from "@/lib/api";

/**
 * Agent-facing copy for a failed send. The gateway's 400/409 bodies are already
 * human-readable field-validation messages, so those pass through unchanged; a
 * few status codes get friendlier wording. Used by every composer dialog and by
 * the plain text send path.
 */
export function sendErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 422 && e.message === "contact_opted_out") {
      return "This contact has opted out of WhatsApp messages.";
    }
    if (e.status === 403) return "You don't have permission to send messages.";
    if (e.status === 401) return "Your session expired. Sign in again.";
    return e.message;
  }
  return "Failed to send. Try again.";
}

/**
 * Media sends add an upload leg before the send, so the gateway's
 * upload-specific error codes get friendlier wording here; everything else
 * falls through to the shared mapping above.
 */
export function mediaSendErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === "media_too_large") return "File is larger than 16 MB";
    if (e.message === "media_upload_failed") return "WhatsApp rejected this file. Try a different format.";
    if (e.message === "meta_adapter_unavailable") return "Upload service unavailable. Try again shortly.";
  }
  return sendErrorMessage(e);
}
