import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * Element bounds helpers shared by `useCanvasSelection` (union bbox for toolbar
 * anchor) and `useCanvasPinning` (collision detection for non-overlapping pin
 * placement). Lives in `lib/` to stay type-only at the Excalidraw boundary ——
 * importing it doesn't drag in `@excalidraw/excalidraw` runtime, which lets
 * vitest run the selection hook without hitting Excalidraw's `open-color` JSON
 * import attribute issue.
 */

export type ElementBounds = { left: number; top: number; right: number; bottom: number };

export function getElementBounds(el: ExcalidrawElement): ElementBounds | null {
  if (el.isDeleted) return null;
  const { x, y, width, height } = el;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return { left: x, top: y, right: x + width, bottom: y + height };
}

export interface ScreenRect { left: number; top: number; width: number; height: number; }
/** Project an element's world rect to screen space (canvas-pane-relative) via the
 *  Excalidraw viewport transform. Ignores element rotation (matches all call sites). */
export function elementScreenRect(
  el: { x: number; y: number; width: number; height: number },
  viewport: { zoom: number; scrollX: number; scrollY: number },
): ScreenRect {
  return {
    left: (el.x + viewport.scrollX) * viewport.zoom,
    top: (el.y + viewport.scrollY) * viewport.zoom,
    width: el.width * viewport.zoom,
    height: el.height * viewport.zoom,
  };
}

/** object-contain geometry: the sub-rect an image of intrinsic aspect `imgW:imgH`
 *  occupies (centered, letterboxed) inside a `boxW`×`boxH` container. When the box and
 *  image share an aspect (the 16:9 monitor frame + 16:9 viewport) there is no letterbox
 *  and this returns the full box. */
export function containedImageRect(
  boxW: number, boxH: number, imgW: number, imgH: number,
): ScreenRect {
  if (boxW <= 0 || boxH <= 0 || imgW <= 0 || imgH <= 0) {
    return { left: 0, top: 0, width: boxW, height: boxH };
  }
  const boxAspect = boxW / boxH;
  const imgAspect = imgW / imgH;
  let width = boxW;
  let height = boxH;
  if (imgAspect > boxAspect) height = boxW / imgAspect; // image wider → bars top/bottom
  else width = boxH * imgAspect;                        // image taller → bars left/right
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/** Map a click on an `object-contain` <img> to PAGE-VIEWPORT pixels (what the backend's
 *  document.elementFromPoint expects). `imgRect` is the img's getBoundingClientRect()
 *  (already folds in any CSS scale/zoom). Returns null if the click hit the letterbox. */
export function imagePointToViewport(
  imgRect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): { vx: number; vy: number } | null {
  const ci = containedImageRect(imgRect.width, imgRect.height, viewport.width, viewport.height);
  const ix = clientX - imgRect.left - ci.left;
  const iy = clientY - imgRect.top - ci.top;
  if (ix < 0 || iy < 0 || ix > ci.width || iy > ci.height) return null; // clicked a bar
  return { vx: (ix / ci.width) * viewport.width, vy: (iy / ci.height) * viewport.height };
}

/** Inverse of {@link imagePointToViewport} for a bbox: a page-viewport rect → the box
 *  inside an `object-contain` image of `boxW`×`boxH` (to draw the pick highlight, in the
 *  same content coordinate system the panel then scales). */
export function viewportRectToImageBox(
  bbox: [number, number, number, number],
  boxW: number, boxH: number,
  viewport: { width: number; height: number },
): ScreenRect {
  const ci = containedImageRect(boxW, boxH, viewport.width, viewport.height);
  const [bx, by, bw, bh] = bbox;
  return {
    left: ci.left + (bx / viewport.width) * ci.width,
    top: ci.top + (by / viewport.height) * ci.height,
    width: (bw / viewport.width) * ci.width,
    height: (bh / viewport.height) * ci.height,
  };
}

/** Inverse of {@link elementScreenRect}'s point projection: a viewport pointer
 *  (clientX/clientY) → world coords. `paneRect` is the canvas pane's
 *  `getBoundingClientRect()` (to make the pointer pane-relative first). Shared by
 *  the drop placement (use-canvas-image-import) and the placement overlay. */
export function screenPointToWorld(
  pointer: { clientX: number; clientY: number },
  paneRect: { left: number; top: number },
  viewport: { zoom: number; scrollX: number; scrollY: number },
): { x: number; y: number } {
  return {
    x: (pointer.clientX - paneRect.left) / viewport.zoom - viewport.scrollX,
    y: (pointer.clientY - paneRect.top) / viewport.zoom - viewport.scrollY,
  };
}
