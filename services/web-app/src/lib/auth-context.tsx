import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Role, Tenant } from "@hyfib/shared-core";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { clearSession, readStoredToken, writeSession } from "./auth-storage";

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

function persist(user: SessionUser, token: string): void {
  writeSession({
    token,
    tenantId: user.tenantId,
    tenantName: user.tenant?.name ?? user.tenantId,
    role: user.roles[0] ?? ""
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  // Only worth showing a loading state when there's a stored token to
  // validate; otherwise there's nothing to await and no synchronous
  // setState is needed inside the effect below.
  const [isLoading, setIsLoading] = useState<boolean>(() => Boolean(readStoredToken()));

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  useEffect(() => {
    const token = readStoredToken();
    if (!token) {
      return;
    }
    api
      .get<SessionUser>("/auth/me")
      .then((me) => setUser(me))
      .catch(() => {
        // 401 already clears storage via the unauthorized handler.
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<AuthResponse>("/auth/login", { email, password });
    persist(data.user, data.token);
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
