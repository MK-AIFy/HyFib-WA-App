import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Conversation, Message, SavedReply } from "@hyfib/shared-core";
import { api } from "@/lib/api";

interface ListResponse<T> {
  items: T[];
  total?: number;
}

export type ConvStateFilter = "all" | "open" | "pending" | "closed";

/**
 * `q` (contact name/phone search) and `archived` (archived-folder toggle)
 * are folded into the query key alongside `state`. Passing `q: q || undefined`
 * / `archived: archived || undefined` keeps the key's JSON hash IDENTICAL to
 * the pre-Task-24 `{ state }` shape whenever both are unset (JSON.stringify —
 * which TanStack Query's default key hasher uses — drops object properties
 * whose value is `undefined`), so existing `["conversations", { state }]`
 * cache entries/tests keep matching.
 *
 * CRITICAL wiring constraint (carried over from Task 22, extended here):
 * InboxPage owns `state`, `q` (debounced), and `archived` and calls this hook
 * itself for freshness lookups; ConversationList must be called with the
 * SAME three arguments (passed down as props) so both call sites resolve to
 * one shared cache entry. See InboxPage.tsx / ConversationList.tsx.
 */
export function useConversations(state: ConvStateFilter, q?: string, archived?: boolean) {
  return useQuery({
    queryKey: ["conversations", { state, q: q || undefined, archived: archived || undefined }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (state !== "all") params.set("state", state);
      if (q) params.set("q", q);
      if (archived) params.set("archived", "true");
      const qs = params.toString();
      return api.get<ListResponse<Conversation>>(`/api/v1/conversations${qs ? `?${qs}` : ""}`);
    }
  });
}

export function useMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["messages", conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => api.get<ListResponse<Message>>(`/api/v1/conversations/${conversationId}/messages`)
  });
}

export function useSavedReplies() {
  return useQuery({
    queryKey: ["saved-replies"],
    queryFn: () => api.get<ListResponse<SavedReply>>("/api/v1/saved-replies")
  });
}

export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      api.post<Message>(`/api/v1/conversations/${conversationId}/messages`, { kind: "text", text }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  });
}

export function useSetConversationState(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: "open" | "pending" | "closed") =>
      api.post(`/api/v1/conversations/${conversationId}/state`, { state }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] })
  });
}

/**
 * Marks a conversation read. Optimistically zeroes `unreadCount` in every
 * cached `["conversations", ...]` list query (badges clear the instant the
 * user opens the thread) and, on settle (success OR error alike), invalidates
 * those same queries so the next refetch restores backend truth — a failed
 * markRead is harmless (the row just goes back to its real unread count), so
 * there's nothing to roll back beyond that refetch.
 */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => api.post(`/api/v1/conversations/${conversationId}/read`, {}),
    onMutate: (conversationId: string) => {
      qc.setQueriesData<ListResponse<Conversation>>({ queryKey: ["conversations"] }, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)) };
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["conversations"] })
  });
}

/**
 * Archives/unarchives a conversation. Mirrors useMarkRead's settle-then-
 * invalidate shape (no optimistic cache write here — the archived folder's
 * membership changing is exactly the kind of list-shape change a refetch
 * should own, not a hand-rolled cache patch).
 */
export function useArchiveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post(`/api/v1/conversations/${id}/archive`, { archived }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["conversations"] })
  });
}

/** Pins/unpins a conversation. See useArchiveConversation for the settle-invalidate rationale. */
export function usePinConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.post(`/api/v1/conversations/${id}/pin`, { pinned }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["conversations"] })
  });
}

/** Text shown for a message, mirroring the portal's payload precedence. */
export function messageText(m: Message): string {
  const p = m.payload as { text?: string; media?: { caption?: string }; kind?: string };
  return p.text ?? p.media?.caption ?? `[${p.kind ?? "message"}]`;
}
