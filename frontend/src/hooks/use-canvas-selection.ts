import { useCallback, useRef, useState } from "react";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  ExcalidrawTextElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

import { elementScreenRect, getElementBounds } from "@/lib/excalidraw-bounds";
import { getAiChatImageUrl } from "@/lib/excalidraw-custom-data";

/**
 * Track the canvas selection for the floating ImageEditBar.
 *
 * 三种 mode 由 { images数量, 非text shape数量 } 决定; per-mode tab 启用矩阵由
 * ImageEditBar::computeSupportMatrix 拥有 (在那里改, 不在这里复述).
 *   - single-image:    1 image, 0 非text shape
 *   - image-with-shapes: 1 image, ≥1 非text shape (shapes 当编辑指令合成进源图)
 *   - multi-image:     ≥2 image (± shapes)
 *
 * Text elements 单独抽到 `texts` 字段, 不进 `shapes` —— 它们当 prompt input
 * 用 (ImagePanel/VideoPanel/AnglePanel 把 text 内容拼到用户输入前面), 不参与
 * rasterize. 任何 mode 都可能附带 texts (含 single-image: 1 image + 1 text =
 * single-image kind, text 走 prompt).
 *
 * 无 image 选区 → null, toolbar 不现身 (含 "只选了 text 没选图" 的情况).
 *
 * onChange 每 tick 都 fire, 两级 fingerprint 防无谓 setSelection。
 */

interface SelectionAppState {
  selectedElementIds?: Record<string, true | undefined>;
  zoom?: { value: number };
  scrollX?: number;
  scrollY?: number;
}

export interface CanvasSelectionBounds {
  /** World-space union bbox of all selected elements. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Canvas-container space rect (zoom/pan applied). Toolbar uses this for
   *  `position: absolute` placement. */
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
}

interface CanvasSelectionBase {
  bounds: CanvasSelectionBounds;
  /** `id:version` joined over selected elements —— excludes viewport, so
   *  pan/zoom doesn't bust it. Exposed so `useSelectionPreview` can O(1)
   *  compare without rebuilding its own fingerprint per onChange tick. */
  contentFp: string;
  /** Excalidraw `text` elements in the selection — extracted as **prompt input**
   *  (their `text` property is joined into the image/video/angle prompt before
   *  the user's input). Not rasterized into the source PNG. Empty when no text
   *  is selected. */
  texts: ExcalidrawTextElement[];
}

export type CanvasSelection =
  | (CanvasSelectionBase & {
      kind: "single-image";
      image: ExcalidrawImageElement;
      sourceUrl: string | null;
      fileId: FileId | null;
    })
  | (CanvasSelectionBase & {
      kind: "image-with-shapes";
      image: ExcalidrawImageElement;
      /** Non-text shapes only (text 单独走 `texts` 当 prompt). */
      shapes: ExcalidrawElement[];
      sourceUrl: string | null;
      fileId: FileId | null;
    })
  | (CanvasSelectionBase & {
      kind: "multi-image";
      images: ExcalidrawImageElement[];
      /** Non-text shapes only (text 单独走 `texts` 当 prompt). */
      shapes: ExcalidrawElement[];
    });

/** Flatten a selection's elements (images first, shapes after) in a mode-agnostic
 *  way. Used by the preview hook (exportToBlob input + fingerprint) and by
 *  `selectionToSourceFile` (image-with-shapes rasterize) so they stay aligned. */
export function getSelectionElements(
  selection: CanvasSelection,
): ExcalidrawElement[] {
  if (selection.kind === "single-image") return [selection.image];
  if (selection.kind === "image-with-shapes") {
    return [selection.image, ...selection.shapes];
  }
  return [...selection.images, ...selection.shapes];
}

/** Union world-space bbox over a set of elements. Null if no valid bounds. */
function computeUnionBounds(
  elements: readonly ExcalidrawElement[],
): { x: number; y: number; width: number; height: number } | null {
  let minL = Infinity;
  let minT = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;
  for (const el of elements) {
    const b = getElementBounds(el);
    if (!b) continue;
    if (b.left < minL) minL = b.left;
    if (b.top < minT) minT = b.top;
    if (b.right > maxR) maxR = b.right;
    if (b.bottom > maxB) maxB = b.bottom;
  }
  if (!Number.isFinite(minL)) return null;
  return { x: minL, y: minT, width: maxR - minL, height: maxB - minT };
}

export function useCanvasSelection(): {
  selection: CanvasSelection | null;
  update: (
    elements: readonly ExcalidrawElement[],
    appState: unknown,
  ) => void;
} {
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const lastIdsKeyRef = useRef<string>("");
  const lastPosFpRef = useRef<string>("");

  const update = useCallback(
    (elements: readonly ExcalidrawElement[], appState: unknown) => {
      const state = appState as SelectionAppState | null | undefined;
      const selectedIds = Object.keys(state?.selectedElementIds ?? {});
      // Object.keys order is stable per same-object in V8; sort only defends
      // against the ids coming from a different appState snapshot with a
      // different insertion order.
      const idsKey = selectedIds.length > 1
        ? [...selectedIds].sort().join(",")
        : selectedIds.join(",");
      const idsChanged = idsKey !== lastIdsKeyRef.current;
      lastIdsKeyRef.current = idsKey;

      if (selectedIds.length === 0) {
        if (idsChanged) setSelection(null);
        return;
      }

      // Single pass: bucket into images / non-text shapes / texts, build
      // version fingerprint, collect selectedElements for bounds computation.
      // Scene order is stable across ticks for the same ID set, so no sort
      // needed on versionParts.
      const selectedSet = new Set(selectedIds);
      const selectedElements: ExcalidrawElement[] = [];
      const images: ExcalidrawImageElement[] = [];
      const shapes: ExcalidrawElement[] = [];
      const texts: ExcalidrawTextElement[] = [];
      const versionParts: string[] = [];
      for (const el of elements) {
        if (!selectedSet.has(el.id) || el.isDeleted) continue;
        selectedElements.push(el);
        if (el.type === "image") images.push(el as ExcalidrawImageElement);
        else if (el.type === "text") texts.push(el as ExcalidrawTextElement);
        else shapes.push(el);
        versionParts.push(`${el.id}:${el.version}`);
      }
      if (images.length === 0) {
        if (idsChanged) setSelection(null);
        return;
      }

      const zoom = state?.zoom?.value ?? 1;
      const scrollX = state?.scrollX ?? 0;
      const scrollY = state?.scrollY ?? 0;
      const contentFp = versionParts.join(",");
      const posFp = `${contentFp}|${zoom}|${scrollX}|${scrollY}`;
      if (!idsChanged && posFp === lastPosFpRef.current) return;
      lastPosFpRef.current = posFp;

      const world = computeUnionBounds(selectedElements);
      if (!world) {
        if (idsChanged) setSelection(null);
        return;
      }

      const screen = elementScreenRect(world, { zoom, scrollX, scrollY });
      const bounds: CanvasSelectionBounds = {
        ...world,
        screenX: screen.left,
        screenY: screen.top,
        screenWidth: screen.width,
        screenHeight: screen.height,
      };

      if (images.length === 1 && shapes.length === 0) {
        const image = images[0];
        setSelection({
          kind: "single-image",
          image,
          sourceUrl: getAiChatImageUrl(image),
          fileId: image.fileId ?? null,
          bounds,
          contentFp,
          texts,
        });
        return;
      }
      if (images.length === 1) {
        const image = images[0];
        setSelection({
          kind: "image-with-shapes",
          image,
          shapes,
          sourceUrl: getAiChatImageUrl(image),
          fileId: image.fileId ?? null,
          bounds,
          contentFp,
          texts,
        });
        return;
      }
      setSelection({
        kind: "multi-image",
        images,
        shapes,
        bounds,
        contentFp,
        texts,
      });
    },
    [],
  );

  return { selection, update };
}
