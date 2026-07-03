import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("redirects an unauthenticated visitor to the login page", async () => {
    render(<App />);
    // shadcn's CardTitle renders a <div>, not a heading element (tracked as
    // an a11y gap for the iteration-11 pass), so this can't query by role.
    expect(await screen.findByText("Sign in to HyFib")).toBeInTheDocument();
  });
});
