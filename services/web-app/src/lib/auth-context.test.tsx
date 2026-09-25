import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("sends a stored legacy hf_tok ONCE as a Bearer header on boot, then removes it once the server has answered", async () => {
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

  it("under StrictMode, sends a stored legacy hf_tok exactly once despite the double-invoked boot effect", async () => {
    localStorage.setItem("hf_tok", "legacy-tok");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>
    );

    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer legacy-tok");
    expect(localStorage.getItem("hf_tok")).toBeNull();
  });

  it("removes the legacy hf_tok when the server refuses it (401)", async () => {
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

// ─── The server could not answer at boot: not a sign-out ─────────────────────────────────────

function StateProbe() {
  const { user, isLoading, isUnavailable } = useAuth();
  return (
    <div>
      <span>{isLoading ? "loading" : "ready"}</span>
      <span>{isUnavailable ? "unavailable" : "reachable"}</span>
      <span>{user ? user.displayName : "anonymous"}</span>
    </div>
  );
}

/** The gateway's answer when it cannot reach its session store (see api-gateway auth-failure.ts). */
function authUnavailable(retryAfter = "5"): Response {
  return new Response(JSON.stringify({ error: "auth_unavailable", retryAfterSeconds: Number(retryAfter) }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": retryAfter }
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderProvider(strict = false) {
  const tree = (
    <AuthProvider>
      <StateProbe />
    </AuthProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe("AuthProvider when the server cannot answer at boot", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // No jitter: each retry lands exactly on its base delay.
    vi.spyOn(Math, "random").mockReturnValue(0);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 503 is not a sign-out: the session stays undecided, is asked again after Retry-After, and is restored", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();

    await advance(0);
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();

    await advance(4_999);
    expect(fetchMock, "not before the server's Retry-After").toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("reachable")).toBeInTheDocument();
    expect(screen.getByText("Jane")).toBeInTheDocument();
  });

  it("keeps a legacy hf_tok through a 503, sends it again on the retry, and removes it once the server answers", async () => {
    localStorage.setItem("hf_tok", "legacy-tok");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();

    await advance(0);
    expect(localStorage.getItem("hf_tok"), "the server never looked at it: its one chance is not spent").toBe(
      "legacy-tok"
    );

    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer legacy-tok");
    }
    expect(screen.getByText("Jane")).toBeInTheDocument();
    expect(localStorage.getItem("hf_tok")).toBeNull();
  });

  it("treats a network failure, or an error page that is not JSON, like a 503: asked again, not signed out", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();

    await advance(0);
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    await advance(5_000); // no Retry-After to go by: 5 s
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    await advance(10_000); // a second failure in a row: doubled
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Jane")).toBeInTheDocument();
  });

  it("asks again after any answer that means 'not now' (429 and 5xx)", async () => {
    for (const status of [429, 500, 502, 504]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(status, { error: "busy" }))
        .mockResolvedValueOnce(jsonResponse(200, meUser()));
      vi.stubGlobal("fetch", fetchMock);
      const view = renderProvider();

      await advance(0);
      expect(screen.getByText("unavailable"), String(status)).toBeInTheDocument();
      await advance(5_000);
      expect(screen.getByText("Jane"), String(status)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("does not retry an answer that retrying cannot change (another 4xx): the boot ends signed out", async () => {
    for (const status of [400, 403, 404]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: "nope" }));
      vi.stubGlobal("fetch", fetchMock);
      const view = renderProvider();

      await advance(60_000);
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
      expect(screen.getByText("ready"), String(status)).toBeInTheDocument();
      expect(screen.getByText("reachable"), String(status)).toBeInTheDocument();
      expect(screen.getByText("anonymous"), String(status)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("backs off, doubling to a 30 s cap, until the server answers; a 401 then ends it as an ordinary sign-out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();
    await advance(0);

    for (const [wait, calls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [30_000, 5]
    ] as const) {
      await advance(wait - 1);
      expect(fetchMock, `not before ${wait} ms`).toHaveBeenCalledTimes(calls - 1);
      await advance(1);
      expect(fetchMock, `at ${wait} ms`).toHaveBeenCalledTimes(calls);
    }
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("reachable")).toBeInTheDocument();
    expect(screen.getByText("anonymous")).toBeInTheDocument();
  });

  it("honours a Retry-After longer than that cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authUnavailable("120"))
      .mockResolvedValueOnce(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();

    await advance(119_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops asking once unmounted", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => authUnavailable());
    vi.stubGlobal("fetch", fetchMock);
    const view = renderProvider();

    await advance(0);
    view.unmount();
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops asking when unmounted while a check is still in flight", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
      .mockImplementation(async () => authUnavailable());
    vi.stubGlobal("fetch", fetchMock);
    const view = renderProvider();

    view.unmount();
    answer(authUnavailable());
    await advance(120_000);
    expect(fetchMock, "the 503 that arrives after unmounting schedules nothing").toHaveBeenCalledTimes(1);
  });

  it("under StrictMode, still retries after a 503: the double-invoked boot effect does not cancel its own retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authUnavailable())
      .mockResolvedValueOnce(jsonResponse(200, meUser()));
    vi.stubGlobal("fetch", fetchMock);
    renderProvider(true);

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Jane")).toBeInTheDocument();
  });
});
