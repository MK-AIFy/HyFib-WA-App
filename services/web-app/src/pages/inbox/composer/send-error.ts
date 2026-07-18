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
