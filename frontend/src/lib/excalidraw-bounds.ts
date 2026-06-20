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
