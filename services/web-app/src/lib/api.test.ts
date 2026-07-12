import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { clearSession, writeSession } from "./auth-storage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the stored bearer token on every request", async () => {
    writeSession({ token: "tok-123", tenantId: "t1", tenantName: "Acme", role: "tenant_admin" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/v1/contacts");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("throws ApiError with the server's error message on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "email is required" })));

    await expect(api.post("/auth/login", {})).rejects.toMatchObject({
      message: "email is required",
      status: 400
    });
  });

  it("clears the session and notifies the unauthorized handler on 401", async () => {
    writeSession({ token: "tok-123", tenantId: "t1", tenantName: "Acme", role: "tenant_admin" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.get("/auth/me")).rejects.toBeInstanceOf(ApiError);

    expect(handler).toHaveBeenCalledOnce();
    expect(localStorage.getItem("hf_tok")).toBeNull();
    clearSession();
  });
});
