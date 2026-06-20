import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import {
  selectionToSourceFile,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
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
}: {
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinning: CanvasEditPinning;
  sceneAbortRef: RefObject<AbortController | null>;
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
        createJob: async () => {
          const api = excalidrawApiRef.current!;
          const angleParams = anglesToFalPayload(angles);
          if (sourceUrl) {
            return canvasService.createAngle(sceneId!, { image_url: sourceUrl, ...angleParams });
          }
          const image = await selectionToSourceFile(selection, api);
          return canvasService.createAngle(sceneId!, { image, ...angleParams });
        },
      });
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}
