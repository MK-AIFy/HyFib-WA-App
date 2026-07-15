import { useQuery } from "@tanstack/react-query";
import type { MessageSearchResult } from "@hyfib/shared-core";
import { api } from "@/lib/api";

interface MessageSearchResponse {
  items: MessageSearchResult[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Message content search (Task 25's `GET /api/v1/messages/search?q=`).
 *
 * `q` here is expected to ALREADY be the debounced value InboxPage produces
 * for the conversation search box (`query` in InboxPage.tsx, fed down as
 * `q` to ConversationList and — via MessageSearchResults — to this hook).
 * This hook adds NO debouncing of its own: a second independent timer on
 * top of the existing one would double the effective delay and, worse, let
 * the two timers settle at different moments for the same keystroke stream,
 * splitting "conversations" and "messages" scope results out of sync with
 * each other.
 *
 * `enabled` mirrors the backend's own minimum length (min 2 chars, else a
 * 400 — see api-gateway's `/api/v1/messages/search` handler): gating here
 * avoids firing a request that's guaranteed to fail, which matters more
 * than usual because this route carries a tight 10/min "expensive" rate
 * budget (rate-limit.ts EXPENSIVE_EXACT) shared across the whole tenant.
 *
 * `q` is trimmed before it reaches the query key/request — matching
 * `useConversations`' `trimmedQ` convention — so whitespace-only edits
 * (e.g. trailing spaces while typing) don't mint distinct cache entries or
 * hit the endpoint with a query the trgm index won't usefully match anyway.
 * Default `staleTime`/no polling: fine for a rate-limited search endpoint.
 */
export function useMessageSearch(q: string) {
  const trimmedQ = q.trim();
  return useQuery({
    queryKey: ["message-search", trimmedQ],
    queryFn: () => api.get<MessageSearchResponse>(`/api/v1/messages/search?q=${encodeURIComponent(trimmedQ)}`),
    enabled: trimmedQ.length >= 2
  });
}
