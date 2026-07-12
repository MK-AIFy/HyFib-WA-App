import { clearSession } from "./auth-storage";

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Injected by AuthProvider so this module stays decoupled from React/router. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

/**
 * `extraHeaders` exists solely for the one-shot legacy-token upgrade in
 * auth-context.tsx's boot effect (2026-07-12, Task 18): it lets that single
 * call attach a Bearer header explicitly without this module reading a
 * token out of storage itself. Every other caller relies on the session
 * cookie, sent automatically by the browser (same-origin default).
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-requested-with": "fetch",
    ...extraHeaders
  };

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (res.status === 401) {
    clearSession();
    unauthorizedHandler?.();
    throw new ApiError(401, "Not authenticated");
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const errBody = (data ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, errBody.error ?? `Request failed (${res.status})`, errBody.detail);
  }

  return data as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = { "x-requested-with": "fetch" };

  const res = await fetch(path, { headers });

  if (res.status === 401) {
    clearSession();
    unauthorizedHandler?.();
    throw new ApiError(401, "Not authenticated");
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let detail: string | undefined;
    const text = await res.text();
    if (text) {
      try {
        const errBody = JSON.parse(text) as { error?: string; detail?: string };
        message = errBody.error ?? message;
        detail = errBody.detail;
      } catch {
        // Non-JSON error body — fall back to the generic status message.
      }
    }
    throw new ApiError(res.status, message, detail);
  }

  return res.blob();
}

export const api = {
  get: <T>(path: string, extraHeaders?: Record<string, string>): Promise<T> =>
    request<T>("GET", path, undefined, extraHeaders),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>("PUT", path, body),
  del: <T>(path: string): Promise<T> => request<T>("DELETE", path),
  getBlob: (path: string): Promise<Blob> => requestBlob(path)
};
