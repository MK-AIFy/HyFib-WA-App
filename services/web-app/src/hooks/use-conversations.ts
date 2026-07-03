import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Conversation, Message, SavedReply } from "@hyfib/shared-core";
import { api } from "@/lib/api";

interface ListResponse<T> {
  items: T[];
  total?: number;
}

export type ConvStateFilter = "all" | "open" | "pending" | "closed";

export function useConversations(state: ConvStateFilter) {
  return useQuery({
    queryKey: ["conversations", { state }],
    queryFn: () => {
      const qs = state === "all" ? "" : `?state=${state}`;
      return api.get<ListResponse<Conversation>>(`/api/v1/conversations${qs}`);
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

/** Text shown for a message, mirroring the portal's payload precedence. */
export function messageText(m: Message): string {
  const p = m.payload as { text?: string; media?: { caption?: string }; kind?: string };
  return p.text ?? p.media?.caption ?? `[${p.kind ?? "message"}]`;
}
