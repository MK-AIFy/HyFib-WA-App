import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo } from "@/lib/media";
import { MediaAttachment } from "./MediaAttachment";

// jsdom does not implement URL.createObjectURL/revokeObjectURL (they require a
// real Blob-storage-backed browser engine), so they're stubbed per-test here —
// the same vi.stubGlobal-style approach the rest of this repo's tests use for
// other browser APIs missing from jsdom (see src/test/setup.ts for localStorage).
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderMedia(media: MediaInfo) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MediaAttachment media={media} />
    </QueryClientProvider>
  );
}

describe("MediaAttachment", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock-url"),
      writable: true,
      configurable: true
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a processing placeholder when the asset hasn't been linked to the message yet", () => {
    renderMedia({ mimeType: "image/jpeg" });

    expect(screen.getByText("Attachment processing…")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders a stored image as an <img> with a blob: object URL", async () => {
    const blob = new Blob(["fake-bytes"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));

    renderMedia({ assetId: "asset-1", assetStatus: "stored", mimeType: "image/png", filename: "photo.png" });

    const img = await screen.findByRole("img");
    expect(img).toHaveAttribute("src", "blob:mock-url");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  it("revokes the object URL when the component unmounts", async () => {
    const blob = new Blob(["fake-bytes"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));

    const { unmount } = renderMedia({ assetId: "asset-1", mimeType: "image/png" });
    await screen.findByRole("img");

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("shows a processing placeholder (not an error) on a 409 media_not_ready response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: "media_not_ready", status: "pending" }))
    );

    renderMedia({ assetId: "asset-1", mimeType: "image/png" });

    expect(await screen.findByText("Attachment processing…", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("shows an unavailable message on a non-409 error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "media_corrupt" })));

    renderMedia({ assetId: "asset-1", mimeType: "image/png" });

    expect(await screen.findByText("Attachment unavailable", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("renders a document as a filename card with a download link", async () => {
    const blob = new Blob(["fake-bytes"], { type: "application/pdf" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));

    renderMedia({ assetId: "asset-1", mimeType: "application/pdf", filename: "invoice.pdf" });

    const link = await screen.findByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "blob:mock-url");
    expect(link).toHaveAttribute("download", "invoice.pdf");
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
  });
});
