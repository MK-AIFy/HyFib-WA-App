import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { CtaUrlDialog } from "./CtaUrlDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(onError = false) {
  const onOpenChange = vi.fn();
  const postMock = onError
    ? vi.spyOn(api, "post").mockRejectedValue(new ApiError(422, "contact_opted_out"))
    : vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "interactive" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CtaUrlDialog conversationId="c1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange, postMock, user: userEvent.setup() };
}

describe("CtaUrlDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows validation errors and does not send when required fields are empty", async () => {
    const { postMock, user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Message body is required")).toBeInTheDocument();
    expect(screen.getByText("Button label is required")).toBeInTheDocument();
    expect(screen.getByText("URL is required")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http URL", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Message body"), "Hello");
    await user.type(screen.getByLabelText("Button label"), "Open");
    await user.type(screen.getByLabelText("URL"), "ftp://example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Must start with http:// or https://")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sends a minimal cta_url payload and omits blank header/footer", async () => {
    const { postMock, onOpenChange, user } = renderDialog();
    await user.type(screen.getByLabelText("Message body"), "View invoice");
    await user.type(screen.getByLabelText("Button label"), "Open invoice");
    await user.type(screen.getByLabelText("URL"), "https://example.com/inv/1");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "interactive",
        interactive: {
          interactiveType: "cta_url",
          bodyText: "View invoice",
          ctaDisplayText: "Open invoice",
          ctaUrl: "https://example.com/inv/1"
        }
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalled();
  });

  it("includes header and footer when provided", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Message body"), "Body");
    await user.type(screen.getByLabelText("Header (optional)"), "Head");
    await user.type(screen.getByLabelText("Footer (optional)"), "Foot");
    await user.type(screen.getByLabelText("Button label"), "Go");
    await user.type(screen.getByLabelText("URL"), "https://x.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "interactive",
        interactive: {
          interactiveType: "cta_url",
          bodyText: "Body",
          ctaDisplayText: "Go",
          ctaUrl: "https://x.com",
          headerText: "Head",
          footerText: "Foot"
        }
      })
    );
  });

  it("shows an error toast and stays open on a failed send", async () => {
    const { onOpenChange, user } = renderDialog(true);
    await user.type(screen.getByLabelText("Message body"), "Body");
    await user.type(screen.getByLabelText("Button label"), "Go");
    await user.type(screen.getByLabelText("URL"), "https://x.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This contact has opted out of WhatsApp messages."));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
