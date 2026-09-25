import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects an unauthenticated visitor to the login page", async () => {
    // The server says there is no session. (A request that fails outright is not that answer: the app keeps
    // asking instead of signing out; see auth-context.test.tsx.)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );
    render(<App />);
    // shadcn's CardTitle renders a <div>, not a heading element (tracked as
    // an a11y gap for the iteration-11 pass), so this can't query by role.
    expect(await screen.findByText("Sign in to HyFib")).toBeInTheDocument();
  });
});
