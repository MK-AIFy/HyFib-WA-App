import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth-context";
import { RequireAuth } from "./guards";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const signedInUser = {
  id: "u1",
  email: "jane@acme.com",
  displayName: "Jane",
  roles: ["tenant_admin"],
  tenantId: "t1",
  tenant: { id: "t1", name: "Acme", status: "active", plan: "trial", maxUsers: 5, createdAt: "now" }
};

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <p>login page</p> },
      { element: <RequireAuth />, children: [{ path: "/inbox", element: <p>inbox page</p> }] }
    ],
    { initialEntries: [path] }
  );
  return render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("RequireAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("while the server cannot answer at boot, says so instead of sending a signed-in user to /login", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(503, { error: "auth_unavailable", retryAfterSeconds: 5 }, { "retry-after": "5" })
        )
        .mockResolvedValueOnce(jsonResponse(200, signedInUser))
    );
    renderAt("/inbox");

    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent("Can't reach the server. Retrying…");
    expect(screen.queryByText("login page")).toBeNull();

    await advance(5_000);
    expect(screen.getByText("inbox page")).toBeInTheDocument();
  });

  it("control: a visitor the server says is signed out (401) is sent to /login, as before", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthenticated" })));
    renderAt("/inbox");

    await advance(0);
    expect(screen.getByText("login page")).toBeInTheDocument();
  });
});
