import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { FlowsPage } from "./FlowsPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

const FLOWS = [
  { id: "f-draft", name: "Menu bot", status: "draft", triggerKeyword: "menu", activeSessions: 0 },
  { id: "f-live", name: "Support bot", status: "active", triggerKeyword: "help", activeSessions: 4 }
];

function renderPage() {
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path === "/api/v1/flows") return Promise.resolve({ items: FLOWS });
    if (path === "/api/v1/teams") return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "ok" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FlowsPage />
    </QueryClientProvider>
  );
  return { postMock };
}

describe("FlowsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists flows with status, trigger and session counts", async () => {
    renderPage();
    expect(await screen.findByText("Menu bot")).toBeInTheDocument();
    expect(screen.getByText("help")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("Activate on a draft flow POSTs /activate; Pause on a live flow POSTs /pause", async () => {
    const { postMock } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Activate" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/flows/f-draft/activate", {}));

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/flows/f-live/pause", {}));
  });

  it("builder: adding a message step and submitting POSTs the serialized definition", async () => {
    const { postMock } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "New flow" }));
    await user.type(screen.getByLabelText("Name"), "Greeting bot");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    await user.type(screen.getByLabelText("Step 1 text"), "Hello there!");
    await user.click(screen.getByRole("button", { name: "Create flow" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/flows", {
        name: "Greeting bot",
        definition: { start: "step1", nodes: { step1: { type: "message", text: "Hello there!" } } }
      })
    );
  });
});
