// Keys match the vanilla-JS portal (services/web-portal/public/index.html)
// exactly so a browser session survives the nginx cutover in either direction.
const TENANT_ID_KEY = "hf_tid";
const TENANT_NAME_KEY = "hf_tname";
const ROLE_KEY = "hf_role";
const CHANNEL_ID_KEY = "hf_chid";
const CHANNEL_PHONE_KEY = "hf_chphone";
// 2026-07-12 (Task 18): legacy Bearer-token key. The browser no longer
// writes or reads it — auth runs on the HttpOnly hf_session cookie — but
// clearSession() keeps purging it for one release so a client upgrading
// from the old localStorage-token build doesn't strand a stale value.
const LEGACY_TOKEN_KEY = "hf_tok";

export interface StoredSession {
  tenantId: string;
  tenantName: string;
  role: string;
}

export function readStoredRole(): string | null {
  return localStorage.getItem(ROLE_KEY);
}

export function writeSession(session: StoredSession): void {
  localStorage.setItem(TENANT_ID_KEY, session.tenantId);
  localStorage.setItem(TENANT_NAME_KEY, session.tenantName);
  localStorage.setItem(ROLE_KEY, session.role);
}

export function writeChannel(channelId: string, channelPhone: string): void {
  localStorage.setItem(CHANNEL_ID_KEY, channelId);
  localStorage.setItem(CHANNEL_PHONE_KEY, channelPhone);
}

export function clearSession(): void {
  for (const key of [LEGACY_TOKEN_KEY, TENANT_ID_KEY, TENANT_NAME_KEY, ROLE_KEY, CHANNEL_ID_KEY, CHANNEL_PHONE_KEY]) {
    localStorage.removeItem(key);
  }
}
