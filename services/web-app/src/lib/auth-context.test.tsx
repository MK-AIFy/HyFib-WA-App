import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";
import { writeSession } from "./auth-storage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function Probe() {
  const { user, isLoading, login } = useAuth();
  return (
    <div>
      <span>{isLoading ? "loading" : "ready"}</span>
      <span>{user ? user.displayName : "anonymous"}</span>
      <button onClick={() => void login("jane@acme.com", "hunter22")}>login</button>
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

  it("bootstraps the session from /auth/me when a token is already stored", async () => {
    writeSession({ token: "tok-123", tenantId: "t1", tenantName: "Acme", role: "tenant_admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "u1",
          email: "jane@acme.com",
          displayName: "Jane",
          roles: ["tenant_admin"],
          tenantId: "t1",
          tenant: { id: "t1", name: "Acme", status: "active", plan: "trial", maxUsers: 5, createdAt: "now" }
        })
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(screen.getByText("Jane")).toBeInTheDocument();
  });

  it("skips the bootstrap call and stays anonymous with no stored token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(screen.getByText("anonymous")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("login() persists the session and updates the user", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          token: "tok-456",
          user: {
            id: "u1",
            email: "jane@acme.com",
            displayName: "Jane",
            roles: ["tenant_admin"],
            tenantId: "t1",
            tenant: { id: "t1", name: "Acme", status: "active", plan: "trial", maxUsers: 5, createdAt: "now" }
          }
        })
      )
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() => expect(screen.getByText("Jane")).toBeInTheDocument());
    expect(localStorage.getItem("hf_tok")).toBe("tok-456");
    expect(localStorage.getItem("hf_tname")).toBe("Acme");
  });
});
