import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function meUser() {
  return {
    id: "u1",
    email: "jane@acme.com",
    displayName: "Jane",
    roles: ["tenant_admin"],
    tenantId: "t1",
    tenant: { id: "t1", name: "Acme", status: "active", plan: "trial", maxUsers: 5, createdAt: "now" }
  };
}

function Probe() {
  const { user, isLoading, login, logout } = useAuth();
  return (
    <div>
      <span>{isLoading ? "loading" : "ready"}</span>
      <span>{user ? user.displayName : "anonymous"}</span>
      <button onClick={() => void login("jane@acme.com", "hunter22")}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always calls /auth/me on boot (cookie auth) and hydrates the session on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(screen.getByText("Jane")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/auth/me", expect.anything());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("calls /auth/me on boot and stays anonymous when there is no session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(screen.getByText("anonymous")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends a stored legacy hf_tok ONCE as a Bearer header on boot, then removes it regardless of outcome", async () => {
    localStorage.setItem("hf_tok", "legacy-tok");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer legacy-tok");
    expect(localStorage.getItem("hf_tok")).toBeNull();
  });

  it("removes the legacy hf_tok even when the upgrade /auth/me call fails", async () => {
    localStorage.setItem("hf_tok", "stale-tok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "Not authenticated" })));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(localStorage.getItem("hf_tok")).toBeNull();
  });

  it("login() persists display fields (not a token) and updates the user", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/auth/me") {
          return jsonResponse(401, { error: "Not authenticated" });
        }
        return jsonResponse(200, { token: "tok-456", user: meUser() });
      })
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() => expect(screen.getByText("Jane")).toBeInTheDocument());
    expect(localStorage.getItem("hf_tname")).toBe("Acme");
    expect(localStorage.getItem("hf_tok")).toBeNull();
  });

  it("logout() calls the API and clears the stored session", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/auth/me") {
          return jsonResponse(200, meUser());
        }
        return jsonResponse(200, { ok: true });
      })
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("Jane")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    expect(localStorage.getItem("hf_tid")).toBeNull();
    expect(localStorage.getItem("hf_tname")).toBeNull();
    expect(localStorage.getItem("hf_role")).toBeNull();
  });
});
