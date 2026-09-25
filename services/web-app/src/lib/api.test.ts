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

  it("sends x-requested-with and no authorization header on every request (cookie auth)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/v1/contacts");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-requested-with"]).toBe("fetch");
    expect(headers.authorization).toBeUndefined();
  });

  it("sends x-requested-with and no authorization header on mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/v1/contacts", { phoneE164: "+15555550123" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-requested-with"]).toBe("fetch");
    expect(headers.authorization).toBeUndefined();
  });

  it("getBlob sends x-requested-with and no authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["csv"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getBlob("/api/v1/contacts/export");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-requested-with"]).toBe("fetch");
    expect(headers.authorization).toBeUndefined();
  });

  it("get() attaches an explicit extraHeaders authorization header when supplied (legacy upgrade hook)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/auth/me", { authorization: "Bearer legacy-tok" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer legacy-tok");
    expect(headers["x-requested-with"]).toBe("fetch");
  });

  it("throws ApiError with the server's error message on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "email is required" })));

    await expect(api.post("/auth/login", {})).rejects.toMatchObject({
      message: "email is required",
      status: 400
    });
  });

  it("carries the server's Retry-After, in seconds, on the ApiError it throws", async () => {
    const unavailable = (retryAfter?: string) =>
      new Response(JSON.stringify({ error: "auth_unavailable", retryAfterSeconds: 5 }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          ...(retryAfter === undefined ? {} : { "retry-after": retryAfter })
        }
      });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable("5")));
    await expect(api.get("/auth/me")).rejects.toMatchObject({ status: 503, retryAfterSeconds: 5 });

    // No header, or the HTTP-date form, which nothing here sends: no hint.
    for (const retryAfter of [undefined, "Wed, 21 Oct 2026 07:28:00 GMT", "soon"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable(retryAfter)));
      const error = await api.get("/auth/me").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).retryAfterSeconds, String(retryAfter)).toBeUndefined();
    }
  });

  it("clears the session and notifies the unauthorized handler on 401", async () => {
    writeSession({ tenantId: "t1", tenantName: "Acme", role: "tenant_admin" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.get("/auth/me")).rejects.toBeInstanceOf(ApiError);

    expect(handler).toHaveBeenCalledOnce();
    expect(localStorage.getItem("hf_tname")).toBeNull();
    clearSession();
  });

  it("getBlob clears the session and notifies the unauthorized handler on 401", async () => {
    writeSession({ tenantId: "t1", tenantName: "Acme", role: "tenant_admin" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api.getBlob("/api/v1/contacts/export")).rejects.toMatchObject({ status: 401 });

    expect(handler).toHaveBeenCalledOnce();
    expect(localStorage.getItem("hf_tname")).toBeNull();
  });
});
