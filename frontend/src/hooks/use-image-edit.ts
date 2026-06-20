import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import {
  selectionToSourceFile,
  selectionToSourceFiles,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
import { submitCanvasJob } from "@/hooks/submit-canvas-job";
import { imageEditOutputSize } from "@/lib/canvas-image-output-size";

/**
 * Submit a "edit this image" / "cutout this image" job directly to the canvas
 * image-edit backend (no agent), track its lifecycle, and pin the result.
 *
 * Parallels the chat agent's `generate_image` tool but skips the LLM routing
 * layer — ImageEditBar users already picked the target image/selection, so
 * going through the agent would just add latency and token cost. Placeholder
 * UX + n>1 stack behaviour are identical to the agent path (same
 * `pinAssetResultRows`).
 *
 * Three selection kinds:
 *  - single-image → fetch source via URL / dataURL
 *  - image-with-shapes → `selectionToSourceFile` rasterizes shapes onto one PNG
 *  - multi-image → `selectionToSourceFiles` produces a File[] that the backend
 *    stores in `source_images` JSONField; provider sees `image: [url, url, ...]`.
 *    Per-image shape overlap: shapes whose bbox overlaps image[i] get burned
 *    into selection-i.png. Cutout is blocked on multi (view/service rejects).
 */

/**
 * 对齐 apimart 官方支持比例 (`gpt-image-2` / `doubao-seedance`):
 *   1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 21:9, 9:21, auto
 *
 * apimart 只接受比例字符串 (e.g. "16:9"), 后端原样转发. "auto" 让 apimart 服务端
 * 按 image_urls 源图比例自动匹配. 默认 "auto": 跟源图比例, 用户可改.
 */
export type ImageEditSize =
  | "auto"
  | "1:1"
  | "4:3"
  | "3:4"
  | "3:2"
  | "2:3"
  | "16:9"
  | "9:16"
  | "21:9"
  | "9:21";
export type ImageEditCount = 1 | 2 | 4;

export const IMAGE_EDIT_SIZES: { value: ImageEditSize; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "1:1",  label: "1:1" },
  { value: "4:3",  label: "4:3" },
  { value: "3:4",  label: "3:4" },
  { value: "3:2",  label: "3:2" },
  { value: "2:3",  label: "2:3" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "21:9", label: "21:9" },
  { value: "9:21", label: "9:21" },
];
export const IMAGE_EDIT_COUNTS: ImageEditCount[] = [1, 2, 4];

/** apimart Seedream-4.5 画质档位. 2K=1:1 2048×2048 (默认), 4K=1:1 4096×4096
 *  (输出大 4 倍, 耗时更长). cutout/split 2K 已足够, 4K 给创作场景. */
export type ImageEditResolution = "2K" | "4K";
export const IMAGE_EDIT_RESOLUTIONS: ImageEditResolution[] = ["2K", "4K"];

export interface SubmitImageEditParams {
  selection: CanvasSelection;
  prompt?: string;
  cutout?: boolean;
  size?: ImageEditSize;
  resolution?: ImageEditResolution;
  n?: ImageEditCount;
}

export function useImageEdit({
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
  submit: (params: SubmitImageEditParams) => Promise<void>;
  dismissError: () => void;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ selection, prompt, cutout, size, resolution, n }: SubmitImageEditParams) => {
      // Cutout has no multi-image semantics (rembg is single-image) —— backend
      // rejects too, but surface inline so the user doesn't pay a round-trip.
      if (cutout && selection.kind === "multi-image") {
        setError("Cutout cannot combine multiple images");
        return;
      }
      await submitCanvasJob({
        kind: "image",
        placeholderLabel: cutout ? "Cutting out…" : "Editing image…",
        errorMessage: "Image edit failed",
        sceneId, excalidrawApiRef, sceneAbortRef, pinning, inFlightRef,
        setError, setSubmitting: setIsSubmitting,
        anchor: selection.bounds,
        // Non-cutout edits standardize to the resolution tier (2K/4K) → reserve a
        // box the size of that result. Cutout keeps the source size (rembg), so
        // omit it and let createPlaceholder fall back to the anchor (source) rect.
        resultSize: cutout ? undefined : imageEditOutputSize(size, resolution, selection.bounds),
        createJob: async () => {
          // submitCanvasJob guards api non-null before calling createJob
          const api = excalidrawApiRef.current!;
          const image: File | File[] = selection.kind === "multi-image"
            ? await selectionToSourceFiles(selection, api)
            : await selectionToSourceFile(selection, api);
          return canvasService.createImageEdit(sceneId!, {
            image, prompt, cutout, size, resolution, n,
          });
        },
      });
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}
