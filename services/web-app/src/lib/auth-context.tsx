import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Role, Tenant } from "@hyfib/shared-core";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { clearSession, writeSession } from "./auth-storage";

// 2026-07-12 (Task 18): legacy localStorage key for the Bearer token, kept
// here only so the boot effect can do a one-shot upgrade for clients that
// logged in before the cookie-session cutover. See auth-storage.ts's own
// LEGACY_TOKEN_KEY comment for the storage-cleanup side of this.
const LEGACY_TOKEN_KEY = "hf_tok";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  status?: string;
  tenantId: string;
  tenant: Tenant;
}

interface AuthResponse {
  token: string;
  user: SessionUser;
}

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function persist(user: SessionUser): void {
  writeSession({
    tenantId: user.tenantId,
    tenantName: user.tenant?.name ?? user.tenantId,
    role: user.roles[0] ?? ""
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  // Auth now runs on the hf_session cookie, which this module can't inspect
  // (HttpOnly), so the boot effect always awaits /auth/me — an anonymous
  // 401 resolves fast and is already handled below.
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const bootStartedRef = useRef(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  useEffect(() => {
    // 2026-07-12 (Task 18) legacy upgrade: a client that authenticated
    // before the cookie-session cutover still has a Bearer token sitting in
    // localStorage. Send it ONCE as an Authorization header on this boot
    // call so the server can mint the hf_session cookie, then drop the key
    // regardless of outcome so every later boot runs on pure cookie auth.
    // React StrictMode double-invokes this effect in dev; the ref sentinel
    // makes the second invocation a true no-op so we never double-fire it.
    if (bootStartedRef.current) return;
    bootStartedRef.current = true;

    const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
    const extraHeaders = legacyToken ? { authorization: `Bearer ${legacyToken}` } : undefined;

    api
      .get<SessionUser>("/auth/me", extraHeaders)
      .then((me) => setUser(me))
      .catch(() => {
        // Anonymous or expired session — 401 already clears storage via the
        // unauthorized handler.
      })
      .finally(() => {
        if (legacyToken) {
          localStorage.removeItem(LEGACY_TOKEN_KEY);
        }
        setIsLoading(false);
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<AuthResponse>("/auth/login", { email, password });
    persist(data.user);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
    }
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, isLoading, login, logout }), [user, isLoading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
