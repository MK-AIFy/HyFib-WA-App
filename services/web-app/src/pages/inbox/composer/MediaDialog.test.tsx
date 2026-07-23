import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { MEDIA_MAX_BYTES } from "@/hooks/use-send-media";
import { MediaDialog } from "./MediaDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog() {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MediaDialog conversationId="c1" channelId="ch1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange, user: userEvent.setup() };
}

describe("MediaDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("requires a file before sending", async () => {
    const postBinary = vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "M1" });
    const { user } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Choose a file to send")).toBeInTheDocument();
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects a file over the 16 MB upload cap without calling the API", async () => {
    const postBinary = vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "M1" });
    const { user } = renderDialog();
    const file = new File(["x"], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: MEDIA_MAX_BYTES + 1 });

    await user.upload(screen.getByLabelText("File"), file);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("File is larger than 16 MB")).toBeInTheDocument();
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("shows the selected file's name and uploads then sends with the caption", async () => {
    const postBinary = vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "M9" });
    const post = vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "media" });
    const { onOpenChange, user } = renderDialog();
    const file = new File(["jpegbytes"], "photo.jpg", { type: "image/jpeg" });

    await user.upload(screen.getByLabelText("File"), file);
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Caption (optional)"), "Look at this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "media",
        media: { mediaType: "image", mediaId: "M9", caption: "Look at this" }
      })
    );
    expect(postBinary).toHaveBeenCalledWith(
      "/api/v1/channels/whatsapp/ch1/media?filename=photo.jpg",
      file,
      "image/jpeg"
    );
    expect(toast.success).toHaveBeenCalledWith("Attachment sent");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the caption field for audio files", async () => {
    const { user } = renderDialog();

    expect(screen.getByLabelText("Caption (optional)")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("File"), new File(["OggS"], "note.ogg", { type: "audio/ogg" }));

    expect(screen.queryByLabelText("Caption (optional)")).not.toBeInTheDocument();
  });

  it("maps upload failures to friendly copy in the error toast", async () => {
    vi.spyOn(api, "postBinary").mockRejectedValue(new ApiError(502, "media_upload_failed", "meta error"));
    const { user } = renderDialog();

    await user.upload(screen.getByLabelText("File"), new File(["x"], "a.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("WhatsApp rejected this file. Try a different format.")
    );
  });
});
