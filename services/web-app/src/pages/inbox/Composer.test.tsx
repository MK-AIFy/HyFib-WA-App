import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Composer } from "./Composer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function renderComposer(sendRejects = false) {
  vi.spyOn(api, "get").mockResolvedValue({ items: [] });
  const postMock = sendRejects
    ? vi.spyOn(api, "post").mockRejectedValue(new ApiError(422, "contact_opted_out"))
    : vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "text" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Composer conversationId="c1" />
    </QueryClientProvider>
  );
  return { postMock, user: userEvent.setup() };
}

describe("Composer", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("sends a text message on Enter with the kind:text union shape", async () => {
    const { postMock, user } = renderComposer();
    await user.type(screen.getByLabelText("Message"), "hi");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", { kind: "text", text: "hi" })
    );
  });

  it("shows an error toast when a text send fails", async () => {
    const { user } = renderComposer(true);
    await user.type(screen.getByLabelText("Message"), "hi");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This contact has opted out of WhatsApp messages."));
  });

  it("signals typing (throttled) while the agent types", async () => {
    const { postMock, user } = renderComposer();
    await user.type(screen.getByLabelText("Message"), "hello");
    const typingCalls = postMock.mock.calls.filter(([path]) => path === "/api/v1/conversations/c1/typing");
    expect(typingCalls).toHaveLength(1);
  });

  it("opens the attach menu and launches the location dialog", async () => {
    const { user } = renderComposer();
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("menuitem", { name: "Template" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Location" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Link button" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Contact card" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Location" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Send a location");
  });
});
