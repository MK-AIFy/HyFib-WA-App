import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { mediaKind, type MediaInfo } from "@/lib/media";

function ProcessingCard({ label }: { label: string }) {
  return (
    <div className="mb-1 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/** Renders an inbound/outbound message's media attachment, if any. */
export function MediaAttachment({ media }: { media: MediaInfo }) {
  if (!media.assetId) {
    // The async fetch (media.ts in notification-worker) hasn't linked the
    // asset onto this message's payload yet.
    return <ProcessingCard label="Attachment processing…" />;
  }
  return <StoredMediaAttachment assetId={media.assetId} mimeType={media.mimeType} filename={media.filename} />;
}

function StoredMediaAttachment({
  assetId,
  mimeType,
  filename
}: {
  assetId: string;
  mimeType?: string;
  filename?: string;
}) {
  const { data, error } = useQuery({
    queryKey: ["media-blob", assetId],
    queryFn: () => api.getBlob(`/api/v1/media/${assetId}`),
    staleTime: Infinity,
    retry: 1
  });

  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);

  // Object URLs are process-local handles the browser allocates into its own
  // Blob registry — an external system, not derived UI state — so creating
  // one belongs in an effect, matching the react-hooks guidance to "update
  // external systems with the latest state from React". (Deriving it via
  // useMemo instead would double-allocate under StrictMode's dev-only
  // double-invocation of render-phase functions, silently leaking the
  // discarded first URL since only the effect's cleanup revokes anything.)
  useEffect(() => {
    if (!data) {
      return;
    }
    const url = URL.createObjectURL(data);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: see comment above.
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [data]);

  if (error) {
    // 409 media_not_ready means the fetch is still in flight server-side —
    // not a real failure, so it gets the same subtle "processing" treatment.
    const stillProcessing = error instanceof ApiError && error.status === 409;
    return <ProcessingCard label={stillProcessing ? "Attachment processing…" : "Attachment unavailable"} />;
  }

  if (!objectUrl) {
    return <ProcessingCard label="Attachment processing…" />;
  }

  const kind = mediaKind(mimeType);

  if (kind === "image") {
    return (
      <a href={objectUrl} target="_blank" rel="noopener noreferrer" className="mb-1 block">
        <img src={objectUrl} alt={filename ?? "Attachment"} className="max-h-64 rounded-md object-contain" />
      </a>
    );
  }

  if (kind === "audio") {
    return (
      <audio controls src={objectUrl} className="mb-1 w-full">
        Your browser does not support the audio element.
      </audio>
    );
  }

  if (kind === "video") {
    return (
      <video controls src={objectUrl} className="mb-1 max-h-64 w-full rounded-md">
        Your browser does not support the video element.
      </video>
    );
  }

  return (
    <div className="mb-1 flex items-center justify-between gap-2 rounded-md border border-border bg-background/50 px-3 py-2 text-xs">
      <span className="truncate">{filename ?? "Document"}</span>
      <a
        href={objectUrl}
        download={filename}
        aria-label={`Download ${filename ?? "attachment"}`}
        className="shrink-0 font-medium text-primary underline"
      >
        Download
      </a>
    </div>
  );
}
