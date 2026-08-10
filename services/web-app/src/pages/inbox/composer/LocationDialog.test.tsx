import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { LocationDialog } from "./LocationDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(onError = false) {
  const onOpenChange = vi.fn();
  const postMock = onError
    ? vi.spyOn(api, "post").mockRejectedValue(new ApiError(409, "Conversation has no contact"))
    : vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "location" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LocationDialog conversationId="c1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange, postMock, user: userEvent.setup() };
}

describe("LocationDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires latitude and longitude", async () => {
    const { postMock, user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Latitude is required")).toBeInTheDocument();
    expect(screen.getByText("Longitude is required")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("rejects non-numeric and out-of-range coordinates", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Latitude"), "abc");
    await user.type(screen.getByLabelText("Longitude"), "-200");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Must be a number")).toBeInTheDocument();
    expect(screen.getByText("Must be between -180 and 180")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("flags latitude beyond ±90", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Latitude"), "95");
    await user.type(screen.getByLabelText("Longitude"), "10");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Must be between -90 and 90")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sends numeric coordinates and omits blank name/address", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Latitude"), "12.9716");
    await user.type(screen.getByLabelText("Longitude"), "77.5946");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "location",
        location: { latitude: 12.9716, longitude: 77.5946 }
      })
    );
    const [, body] = postMock.mock.calls[0]!;
    const location = (body as { location: { latitude: unknown; longitude: unknown } }).location;
    expect(typeof location.latitude).toBe("number");
    expect(typeof location.longitude).toBe("number");
  });

  it("includes name and address when provided", async () => {
    const { postMock, user } = renderDialog();
    await user.type(screen.getByLabelText("Latitude"), "1");
    await user.type(screen.getByLabelText("Longitude"), "2");
    await user.type(screen.getByLabelText("Name (optional)"), "HQ");
    await user.type(screen.getByLabelText("Address (optional)"), "MG Road");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "location",
        location: { latitude: 1, longitude: 2, name: "HQ", address: "MG Road" }
      })
    );
  });

  it("shows an error toast on a failed send", async () => {
    const { user } = renderDialog(true);
    await user.type(screen.getByLabelText("Latitude"), "1");
    await user.type(screen.getByLabelText("Longitude"), "2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Conversation has no contact"));
  });
});
