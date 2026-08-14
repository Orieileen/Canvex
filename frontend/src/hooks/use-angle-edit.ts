import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import {
  selectionToSourceFile,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
import { imageEditSizeSource } from "@/hooks/use-image-edit";
import { submitCanvasJob } from "@/hooks/submit-canvas-job";
import { anglesToFalPayload, type CameraAngles } from "@/lib/angle";

/**
 * Submit an "angle rerender" job to fal.ai's Qwen-Image-Edit-LoRA. Single-image
 * selections only. Sends `image_url` JSON when sourceUrl is set, multipart
 * File otherwise (backend stages the file to media tree before calling fal).
 */

export interface SubmitAngleEditParams {
  selection: CanvasSelection;
  angles: CameraAngles;
}

export function useAngleEdit({
  sceneId,
  excalidrawApiRef,
  pinning,
  sceneAbortRef,
  angleModelIdRef,
}: {
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinning: CanvasEditPinning;
  sceneAbortRef: RefObject<AbortController | null>;
  /** Angle tab 选中的通道。跟生图的选择是两份独立 state —— 两边的模型集合不相交,
   *  共用一个 id 只会让其中一边永远选不中。 */
  angleModelIdRef: RefObject<string>;
}): {
  isSubmitting: boolean;
  error: string | null;
  submit: (params: SubmitAngleEditParams) => Promise<void>;
  dismissError: () => void;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ selection, angles }: SubmitAngleEditParams) => {
      if (selection.kind !== "single-image") {
        setError("Angle requires a single-image selection");
        return;
      }
      if (!selection.sourceUrl && !selection.fileId) {
        setError("Selected image has no source — pin it via chat first");
        return;
      }
      const sourceUrl = selection.sourceUrl;
      await submitCanvasJob({
        kind: "angle",
        placeholderLabel: "Generating angle…",
        errorMessage: "Angle rerender failed",
        sceneId, excalidrawApiRef, sceneAbortRef, pinning, inFlightRef,
        setError, setSubmitting: setIsSubmitting,
        anchor: selection.bounds,
        // fal keeps the INPUT image's size (no size arg sent), so reserve the
        // image's own dims — NOT a 2K tier. Use the image element (not
        // selection.bounds) so a text label in the selection doesn't widen the box.
        resultSize: imageEditSizeSource(selection),
        createJob: async () => {
          const api = excalidrawApiRef.current!;
          const angleParams = {
            ...anglesToFalPayload(angles),
            image_model: angleModelIdRef.current || undefined,
          };
          if (sourceUrl) {
            return canvasService.createAngle(sceneId!, { image_url: sourceUrl, ...angleParams });
          }
          const image = await selectionToSourceFile(selection, api);
          return canvasService.createAngle(sceneId!, { image, ...angleParams });
        },
      });
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning, angleModelIdRef],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}
