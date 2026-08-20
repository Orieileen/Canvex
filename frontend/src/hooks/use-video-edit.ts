import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import {
  selectionToSourceFile,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
import { submitCanvasJob } from "@/hooks/submit-canvas-job";

/**
 * Submit an "image-to-video" job. Single-image selections only. Sends
 * `image_urls` JSON when sourceUrl is set, multipart File otherwise.
 */

export type VideoDuration = 5 | 10 | 15;
export type VideoAspectRatio = "16:9" | "9:16" | "1:1";

export const VIDEO_DURATIONS: VideoDuration[] = [5, 10, 15];
export const VIDEO_ASPECT_RATIOS: VideoAspectRatio[] = ["16:9", "9:16", "1:1"];

export interface SubmitVideoEditParams {
  selection: CanvasSelection;
  prompt: string;
  duration: VideoDuration;
  aspectRatio: VideoAspectRatio;
}

export function useVideoEdit({
  sceneId,
  excalidrawApiRef,
  pinning,
  sceneAbortRef,
  videoModelIdRef,
}: {
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinning: CanvasEditPinning;
  sceneAbortRef: RefObject<AbortController | null>;
  /** Video tab 选的通道。用 ref 而不是值: 提交那一刻读最新的, 不用把它塞进依赖数组。 */
  videoModelIdRef: RefObject<string>;
}): {
  isSubmitting: boolean;
  error: string | null;
  submit: (params: SubmitVideoEditParams) => Promise<void>;
  dismissError: () => void;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ selection, prompt, duration, aspectRatio }: SubmitVideoEditParams) => {
      if (selection.kind !== "single-image") {
        setError("Video requires a single-image selection");
        return;
      }
      if (!selection.sourceUrl && !selection.fileId) {
        setError("Selected image has no source — pin it via chat first");
        return;
      }
      const sourceUrl = selection.sourceUrl;
      await submitCanvasJob({
        kind: "video",
        placeholderLabel: `Generating video (${duration}s)…`,
        errorMessage: "Video generation failed",
        sceneId, excalidrawApiRef, sceneAbortRef, pinning, inFlightRef,
        setError, setSubmitting: setIsSubmitting,
        anchor: selection.bounds,
        createJob: async () => {
          const api = excalidrawApiRef.current!;
          const base = {
            prompt, duration, aspect_ratio: aspectRatio,
            imageModelId: videoModelIdRef.current || undefined,
          };
          if (sourceUrl) {
            return canvasService.createVideo(sceneId!, { ...base, image_urls: [sourceUrl] });
          }
          const image = await selectionToSourceFile(selection, api);
          return canvasService.createVideo(sceneId!, { ...base, image });
        },
      });
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning, videoModelIdRef],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}
