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
  /**
   * True while the boot check cannot get an answer from the server (an outage). Boot is still undecided
   * (isLoading stays true): the user is not treated as signed out, and the check is retried.
   */
  isUnavailable: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const BOOT_RETRY_DEFAULT_MS = 5_000;
const BOOT_RETRY_MIN_MS = 1_000;
const BOOT_RETRY_MAX_MS = 30_000;

/**
 * Whether a failed /auth/me means the server could not answer, as opposed to answering "no". Either the request
 * got no answer (a network failure, or an error page that is not the API's JSON), or the answer was "not now": a
 * 5xx (503 auth_unavailable when the gateway cannot reach its session store) or a 429.
 */
function couldNotAnswer(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return error.status >= 500 || error.status === 429;
}

/**
 * How long to wait before asking /auth/me again after `failures` failed tries in a row: the server's Retry-After
 * (5 s if it gave none), doubling per failure up to 30 s but never sooner than the server asked, plus up to 50%
 * jitter so that tabs opened together do not all ask again at the same moment.
 */
function bootRetryDelayMs(failures: number, retryAfterSeconds: number | undefined): number {
  const asked =
    retryAfterSeconds === undefined ? BOOT_RETRY_DEFAULT_MS : Math.max(BOOT_RETRY_MIN_MS, retryAfterSeconds * 1000);
  const base = Math.max(asked, Math.min(BOOT_RETRY_MAX_MS, asked * 2 ** failures));
  return Math.round(base * (1 + Math.random() / 2));
}

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
  const [isUnavailable, setIsUnavailable] = useState<boolean>(false);
  const bootStartedRef = useRef(false);
  const unmountedRef = useRef(false);
  const bootRetryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  useEffect(() => {
    // Whether the provider has really left the page, for the boot retry below. Under StrictMode this runs
    // mount, unmount, mount again, so the flag is reset by the second mount: the boot effect runs only once
    // and must not lose its retry to that simulated unmount.
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearTimeout(bootRetryRef.current);
    };
  }, []);

  useEffect(() => {
    // 2026-07-12 (Task 18) legacy upgrade: a client that authenticated
    // before the cookie-session cutover still has a Bearer token sitting in
    // localStorage. Send it as an Authorization header on this boot call so
    // the server can mint the hf_session cookie, then drop the key once the
    // server has answered, so every later boot runs on pure cookie auth.
    // React StrictMode double-invokes this effect in dev; the ref sentinel
    // makes the second invocation a true no-op so we never double-fire it.
    if (bootStartedRef.current) return;
    bootStartedRef.current = true;

    const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
    const extraHeaders = legacyToken ? { authorization: `Bearer ${legacyToken}` } : undefined;
    let failures = 0;

    // The server answered, with a session or without one: boot is over, and the legacy token has had its chance.
    const settle = () => {
      if (legacyToken) {
        localStorage.removeItem(LEGACY_TOKEN_KEY);
      }
      setIsUnavailable(false);
      setIsLoading(false);
    };

    const checkSession = () => {
      api.get<SessionUser>("/auth/me", extraHeaders).then(
        (me) => {
          setUser(me);
          settle();
        },
        (error: unknown) => {
          if (!couldNotAnswer(error)) {
            // Signed out (a 401 has already run the app's sign-out path), or a refusal no retry would change.
            settle();
            return;
          }
          // An outage is not an answer: stay undecided, keep the legacy token for the next try, and ask again.
          if (unmountedRef.current) {
            return;
          }
          setIsUnavailable(true);
          const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
          bootRetryRef.current = setTimeout(checkSession, bootRetryDelayMs(failures, retryAfterSeconds));
          failures += 1;
        }
      );
    };
    checkSession();
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

  const value = useMemo(
    () => ({ user, isLoading, isUnavailable, login, logout }),
    [user, isLoading, isUnavailable, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
