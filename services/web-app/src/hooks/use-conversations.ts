import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Conversation,
  Message,
  SavedReply,
  WhatsAppContactCard,
  WhatsAppInteractivePayload,
  WhatsAppOutboundRequest
} from "@hyfib/shared-core";
import { api } from "@/lib/api";

export type TemplateSendPayload = NonNullable<WhatsAppOutboundRequest["template"]>;
export type LocationSendPayload = NonNullable<WhatsAppOutboundRequest["location"]>;

/**
 * The set of outbound message kinds the composer can send, as a discriminated
 * union on `kind`. Built from shared-core primitives (type-only imports); the
 * gateway's own `SendMessageRequest` is looser (all-optional), so the UI keeps
 * this stricter shape locally. Each variant is the exact JSON body POSTed to
 * `/api/v1/conversations/:id/messages`.
 */
export type SendMessageBody =
  | { kind: "text"; text: string; previewUrl?: boolean }
  | { kind: "template"; template: TemplateSendPayload }
  | { kind: "interactive"; interactive: WhatsAppInteractivePayload }
  | { kind: "location"; location: LocationSendPayload }
  | { kind: "contacts"; contacts: WhatsAppContactCard[] };

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
 *
 * `placeholderData: keepPreviousData` (review finding 1, Task 24 follow-up):
 * every debounced keystroke or archived-toggle click produces a NEW query
 * key (`q`/`archived` are part of the key), and most of those keys have
 * never been fetched before. Without this option, TanStack Query makes
 * `data` transiently `undefined` while such a key's first fetch is in
 * flight. InboxPage derives `freshActive = data?.items.find(...)`, and when
 * `data` is undefined that lookup is also undefined, so
 * `selectedUnreadCount = freshActive?.unreadCount ?? active?.unreadCount ?? 0`
 * falls back to `active.unreadCount` — the STALE click-time snapshot
 * (captured once in `setActive(c)` and never updated) — instead of the
 * already-zeroed live row. That spuriously flips selectedUnreadCount from 0
 * back to a positive number and re-fires the mark-read effect, producing a
 * duplicate POST .../read (reproduced in InboxPage.test.tsx).
 *
 * `keepPreviousData` closes the hole at the root: on a key transition,
 * `data` keeps holding the PREVIOUS key's result instead of going
 * undefined, so `freshActive` stays defined throughout the transition. The
 * previous key's cached row for the selected conversation is exactly the
 * one `useMarkRead`'s optimistic update (and its onSettled refetch) already
 * zeroed via `setQueriesData({ queryKey: ["conversations"] }, ...)` — a
 * prefix match that covers every cached `["conversations", ...]` entry, not
 * just the active key — so the placeholder value the effect reads is
 * already correct. No extra ref is needed: the `?? active` fallback only
 * ever triggers when `data` is undefined, and after mount that no longer
 * happens with `keepPreviousData` in place.
 */
export function useConversations(state: ConvStateFilter, q?: string, archived?: boolean) {
  // Trim before canonicalizing: a whitespace-only search box value (e.g.
  // "   ") is not a real query — without this, `q || undefined` treats it as
  // truthy, so it survives into both the query key (a distinct, needlessly
  // cached entry per amount of whitespace) and the request as `q=%20%20%20`.
  const trimmedQ = q?.trim() || undefined;
  return useQuery({
    queryKey: ["conversations", { state, q: trimmedQ, archived: archived || undefined }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (state !== "all") params.set("state", state);
      if (trimmedQ) params.set("q", trimmedQ);
      if (archived) params.set("archived", "true");
      const qs = params.toString();
      return api.get<ListResponse<Conversation>>(`/api/v1/conversations${qs ? `?${qs}` : ""}`);
    },
    placeholderData: keepPreviousData
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
    // The route returns 202 { status: "message_enqueued", kind } — never a
    // Message row (the send is async through the outbox), so nothing here reads
    // the result; the invalidations below refetch the thread once the worker
    // has persisted the outbound row.
    mutationFn: (body: SendMessageBody) =>
      api.post<{ status: string; kind: string }>(`/api/v1/conversations/${conversationId}/messages`, body),
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
