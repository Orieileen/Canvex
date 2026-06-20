import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawImageElement } from "@excalidraw/excalidraw/element/types";

import {
  getSelectionElements,
  type CanvasSelection,
} from "@/hooks/use-canvas-selection";
import {
  fetchAsDataURL,
  imageDimensionsFromDataURL,
  rasterizeElements,
  type UseCanvasPinning,
} from "@/hooks/use-canvas-pinning";

/**
 * Flatten the current selection into a single PNG and pin it as a new image.
 * Pure client-side; no backend roundtrip, no credit consumed. The blob lives
 * only as dataURL in Excalidraw's files cache.
 *
 * Caller (ImageEditBar's support matrix) gates the no-op case (single-image
 * with zero overlays) — without that, flatten just re-encodes the source.
 */

const PIN_GAP = 16;
/** 4× balances source-fidelity vs scene-payload bloat — merged blobs ride as
 *  dataURL on save, and a 4K source inside a small bbox would otherwise
 *  produce a 50 MB PNG. */
const MAX_EXPORT_SCALE = 4;

async function computeExportScale(
  selection: CanvasSelection,
  api: ExcalidrawImperativeAPI,
): Promise<number> {
  const images: ExcalidrawImageElement[] =
    selection.kind === "multi-image" ? selection.images : [selection.image];
  const files = api.getFiles();
  const scales = await Promise.all(
    images.map(async (img) => {
      if (!img.fileId || img.width <= 0 || img.height <= 0) return 1;
      const dataURL = files[img.fileId]?.dataURL;
      if (!dataURL) return 1;
      try {
        const natural = await imageDimensionsFromDataURL(dataURL);
        return Math.max(natural.width / img.width, natural.height / img.height);
      } catch {
        return 1;
      }
    }),
  );
  return Math.min(Math.max(1, ...scales), MAX_EXPORT_SCALE);
}

export function useMergeLayer({
  excalidrawApiRef,
  pinMergedImage,
}: {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinMergedImage: UseCanvasPinning["pinMergedImage"];
}): {
  isProcessing: boolean;
  error: string | null;
  merge: (selection: CanvasSelection) => Promise<void>;
  dismissError: () => void;
} {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const merge = useCallback(
    async (selection: CanvasSelection) => {
      const api = excalidrawApiRef.current;
      if (!api) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setIsProcessing(true);

      let objectUrl: string | null = null;
      try {
        const elements = [...getSelectionElements(selection), ...selection.texts];
        if (elements.length < 2) {
          setError("Nothing to merge — selection has no overlays");
          return;
        }
        const exportScale = await computeExportScale(selection, api);
        const blob = await rasterizeElements(elements, api, { exportScale });
        objectUrl = URL.createObjectURL(blob);
        const { dataURL, mimeType } = await fetchAsDataURL(objectUrl);
        await pinMergedImage({
          dataURL,
          mimeType,
          dedupKey: `merge-${crypto.randomUUID()}`,
          startAt: {
            x: selection.bounds.x + selection.bounds.width + PIN_GAP,
            y: selection.bounds.y,
          },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Merge failed");
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setIsProcessing(false);
        inFlightRef.current = false;
      }
    },
    [excalidrawApiRef, pinMergedImage],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isProcessing, error, merge, dismissError };
}
