import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { ContactCardDialog } from "./ContactCardDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(onError = false) {
  const onOpenChange = vi.fn();
  const postMock = onError
    ? vi.spyOn(api, "post").mockRejectedValue(new ApiError(422, "contact_opted_out"))
    : vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "contacts" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContactCardDialog conversationId="c1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange, postMock, user: userEvent.setup() };
}

describe("ContactCardDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires a display name", async () => {
    const { postMock, user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Display name is required")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("flags an empty phone row", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Display name"), "Jane");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Phone is required")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("adds and removes phone rows", async () => {
    const { user } = renderDialog();
    expect(screen.getByLabelText("Phone 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add phone" }));
    expect(await screen.findByLabelText("Phone 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove phone 2" }));
    await waitFor(() => expect(screen.queryByLabelText("Phone 2")).toBeNull());
  });

  it("sends a single contact card with phone and omits empty emails and blank type", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Display name"), "Jane Doe");
    await user.type(screen.getByLabelText("Phone 1"), "+15551230000");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "contacts",
        contacts: [{ name: { formattedName: "Jane Doe" }, phones: [{ phone: "+15551230000" }] }]
      })
    );
  });

  it("sends a name-only card when the default phone row is removed", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Display name"), "Only Name");
    await user.click(screen.getByRole("button", { name: "Remove phone 1" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "contacts",
        contacts: [{ name: { formattedName: "Only Name" } }]
      })
    );
  });

  it("shows an error toast on a failed send", async () => {
    const { user } = renderDialog(true);
    await user.type(screen.getByLabelText("Display name"), "Jane");
    await user.type(screen.getByLabelText("Phone 1"), "+15551230000");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This contact has opted out of WhatsApp messages."));
  });
});
