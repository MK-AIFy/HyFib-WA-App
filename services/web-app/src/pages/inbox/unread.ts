import type { Conversation } from "@hyfib/shared-core";

// Interim client-side unread tracking (backend exposes no unread_count — see
// plan "Out of scope"). A conversation reads as unread when its last inbound
// message is newer than the last time this browser opened it.
const KEY = "hf_lastread";

function readMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export function isUnread(c: Conversation): boolean {
  if (!c.lastInboundAt) return false;
  const seen = readMap()[c.id] ?? 0;
  return new Date(c.lastInboundAt).getTime() > seen;
}

export function markRead(conversationId: string): void {
  const map = readMap();
  map[conversationId] = Date.now();
  localStorage.setItem(KEY, JSON.stringify(map));
}
