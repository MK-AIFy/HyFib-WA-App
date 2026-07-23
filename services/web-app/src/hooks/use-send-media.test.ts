import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useSendMedia, whatsAppMediaType } from "./use-send-media";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("whatsAppMediaType — MIME bucketing for the send payload", () => {
  it("maps image/video/audio prefixes and falls back to document", () => {
    expect(whatsAppMediaType("image/jpeg")).toBe("image");
    expect(whatsAppMediaType("video/mp4")).toBe("video");
    expect(whatsAppMediaType("audio/ogg")).toBe("audio");
    expect(whatsAppMediaType("application/pdf")).toBe("document");
    expect(whatsAppMediaType("")).toBe("document");
  });
});

describe("useSendMedia — upload then send", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSendMedia("conv-1", "chan-1"), { wrapper: wrapperFor(client) });
    return { client, result };
  }

  it("uploads the file bytes to the channel media route, then sends kind media with the returned mediaId and trimmed caption", async () => {
    const postBinary = vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "MEDIA-9" });
    const post = vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "media" });
    const { result } = setup();
    const file = new File(["fake-jpeg-bytes"], "photo summer.jpg", { type: "image/jpeg" });

    result.current.mutate({ file, caption: "  Beach day  " });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postBinary).toHaveBeenCalledWith(
      "/api/v1/channels/whatsapp/chan-1/media?filename=photo%20summer.jpg",
      file,
      "image/jpeg"
    );
    expect(post).toHaveBeenCalledWith("/api/v1/conversations/conv-1/messages", {
      kind: "media",
      media: { mediaType: "image", mediaId: "MEDIA-9", caption: "Beach day" }
    });
  });

  it("omits a blank caption, includes filename for documents, and defaults an empty MIME to octet-stream", async () => {
    vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "MEDIA-2" });
    const post = vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "media" });
    const { result } = setup();
    const file = new File(["%PDF"], "invoice.pdf", { type: "" });

    result.current.mutate({ file, caption: "   " });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.postBinary).toHaveBeenCalledWith(
      "/api/v1/channels/whatsapp/chan-1/media?filename=invoice.pdf",
      file,
      "application/octet-stream"
    );
    const [, body] = post.mock.calls[0] as [string, { media: Record<string, unknown> }];
    expect(body.media).toEqual({ mediaType: "document", mediaId: "MEDIA-2", filename: "invoice.pdf" });
    expect("caption" in body.media).toBe(false);
  });

  it("never includes a caption for audio sends (WhatsApp does not support them)", async () => {
    vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "MEDIA-3" });
    const post = vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "media" });
    const { result } = setup();
    const file = new File(["OggS"], "note.ogg", { type: "audio/ogg" });

    result.current.mutate({ file, caption: "hello" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, body] = post.mock.calls[0] as [string, { media: Record<string, unknown> }];
    expect(body.media).toEqual({ mediaType: "audio", mediaId: "MEDIA-3" });
  });

  it("does not attempt the send when the upload fails, and surfaces the upload error", async () => {
    vi.spyOn(api, "postBinary").mockRejectedValue(new Error("media_too_large"));
    const post = vi.spyOn(api, "post").mockResolvedValue({});
    const { result } = setup();
    const file = new File(["x"], "big.jpg", { type: "image/jpeg" });

    result.current.mutate({ file });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("media_too_large");
    expect(post).not.toHaveBeenCalled();
  });

  it("invalidates the thread and conversation list after a successful send", async () => {
    vi.spyOn(api, "postBinary").mockResolvedValue({ mediaId: "MEDIA-4" });
    vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "media" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSendMedia("conv-1", "chan-1"), { wrapper: wrapperFor(client) });

    result.current.mutate({ file: new File(["x"], "a.jpg", { type: "image/jpeg" }) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages", "conv-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
  });
});
