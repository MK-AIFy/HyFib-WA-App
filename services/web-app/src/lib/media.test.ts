import { describe, expect, it } from "vitest";
import { mediaAssetOf, mediaKind } from "./media";

describe("mediaKind", () => {
  it("classifies image mime types", () => {
    expect(mediaKind("image/jpeg")).toBe("image");
  });
  it("classifies audio mime types", () => {
    expect(mediaKind("audio/ogg")).toBe("audio");
  });
  it("classifies video mime types", () => {
    expect(mediaKind("video/mp4")).toBe("video");
  });
  it("falls back to document for other mime types", () => {
    expect(mediaKind("application/pdf")).toBe("document");
  });
  it("falls back to document when mime type is undefined", () => {
    expect(mediaKind(undefined)).toBe("document");
  });
});

describe("mediaAssetOf", () => {
  it("combines payload.media and payload.mediaAsset once stored", () => {
    const message = {
      payload: {
        media: { id: "meta-1", mimeType: "image/jpeg", filename: "photo.jpg" },
        mediaAsset: { assetId: "asset-1", status: "stored" }
      }
    };

    expect(mediaAssetOf(message)).toEqual({
      assetId: "asset-1",
      assetStatus: "stored",
      mimeType: "image/jpeg",
      filename: "photo.jpg"
    });
  });

  it("returns no assetId while the fetch is still pending (media-only)", () => {
    const message = {
      payload: {
        media: { id: "meta-1", mimeType: "image/jpeg" }
      }
    };

    expect(mediaAssetOf(message)).toEqual({
      assetId: undefined,
      assetStatus: undefined,
      mimeType: "image/jpeg",
      filename: undefined
    });
  });

  it("returns undefined for a message with no media at all", () => {
    const message = { payload: { text: "hello" } };

    expect(mediaAssetOf(message)).toBeUndefined();
  });
});
