import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth-context";
import { LoginPage } from "./LoginPage";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** /auth/me says "signed out", so the login form shows; /auth/login answers with `loginResponse`. */
function stubServer(loginResponse: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url === "/auth/me" ? jsonResponse(401, { error: "unauthenticated" }) : loginResponse();
    })
  );
}

async function submitLogin() {
  const user = userEvent.setup();
  const router = createMemoryRouter(
    [
      { path: "/login", element: <LoginPage /> },
      { path: "/inbox", element: <p>inbox page</p> }
    ],
    { initialEntries: ["/login"] }
  );
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
  await user.type(await screen.findByLabelText("Email"), "jane@acme.com");
  await user.type(screen.getByLabelText("Password"), "hunter22");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("says sign-in is temporarily unavailable when the server cannot check it (503), not the raw error code", async () => {
    stubServer(() => jsonResponse(503, { error: "auth_unavailable", retryAfterSeconds: 5 }, { "retry-after": "5" }));
    await submitLogin();

    expect(await screen.findByText("Sign-in is temporarily unavailable. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText("auth_unavailable")).toBeNull();
  });

  it("control: any other refusal still shows the server's own message", async () => {
    stubServer(() => jsonResponse(400, { error: "email is required" }));
    await submitLogin();

    expect(await screen.findByText("email is required")).toBeInTheDocument();
  });
});
