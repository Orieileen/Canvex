import { useEffect, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import { selectionToPreviewBlobs } from "@/hooks/use-canvas-pinning";

/**
 * Rasterize the current selection into N thumbnail blob URLs for ImageEditBar.
 * The URLs feed both the toolbar's per-image thumbnails and the click-to-expand
 * Dialog, so a single export serves every view.
 *
 *  - single-image / image-with-shapes → 1 URL (one composite thumbnail)
 *  - multi-image → N URLs (one per image; shapes attributed via overlap, see
 *    `selectionToPreviewBlobs`)
 *
 * Debounce handles Excalidraw's per-frame `version` bump during drag —— a
 * naïve "re-export on selection change" would run at 60 FPS. The consumer
 * (`useCanvasSelection`) also recreates `selection` on every pan/zoom tick, so
 * we dedup on `selection.contentFp` (excludes viewport) before scheduling a
 * new export —— O(1) compare instead of rebuilding our own fingerprint per tick.
 *
 * URL lifecycle: the new URL set is committed to state BEFORE the old set is
 * revoked, so `<img>` decodes loading off the old URLs don't race against
 * release. Revocation on unmount lives in its own `[]`-deps effect so it
 * runs ONLY on unmount (not on every selection change) —— without that, we'd
 * kill the current URLs on every fingerprint bump before any replacement existed.
 */

const DEBOUNCE_MS = 200;

export function useSelectionPreview(
  selection: CanvasSelection | null,
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
): { previewUrls: string[] } {
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const lastFingerprintRef = useRef<string>("");
  // Holds the URLs we minted so `revokeObjectURL` targets the same strings our
  // state points at —— avoids revoking a URL the consumer's <img> is actively
  // loading.
  const liveUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!selection) {
      revokeAll(liveUrlsRef.current);
      liveUrlsRef.current = [];
      lastFingerprintRef.current = "";
      setPreviewUrls([]);
      return;
    }

    if (selection.contentFp === lastFingerprintRef.current) return;

    const api = apiRef.current;
    if (!api) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const blobs = await selectionToPreviewBlobs(selection, api);
        if (cancelled) return;
        const nextUrls = blobs.map((b) => URL.createObjectURL(b));
        // Claim fingerprint + state BEFORE revoking previous —— the render
        // that swaps `<img src>` to nextUrls must commit before old URLs are
        // released, otherwise in-flight decode on the old srcs aborts.
        const previousUrls = liveUrlsRef.current;
        liveUrlsRef.current = nextUrls;
        lastFingerprintRef.current = selection.contentFp;
        setPreviewUrls(nextUrls);
        revokeAll(previousUrls);
      } catch {
        // Preview is best-effort; swallow rather than surface error UI ——
        // toolbar function still works without a thumbnail.
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selection, apiRef]);

  useEffect(() => {
    return () => {
      revokeAll(liveUrlsRef.current);
      liveUrlsRef.current = [];
    };
  }, []);

  return { previewUrls };
}

function revokeAll(urls: readonly string[]): void {
  for (const u of urls) URL.revokeObjectURL(u);
}
