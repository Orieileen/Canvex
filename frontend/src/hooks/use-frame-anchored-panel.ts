import { useEffect, useRef, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { elementScreenRect } from "@/lib/excalidraw-bounds";
import { forwardWheelToExcalidrawCanvas } from "@/lib/excalidraw-wheel-forward";

/**
 * Shared projection + interaction plumbing for an HTML panel anchored to a native
 * Excalidraw frame (ChatFrameOverlay, BrowseLogOverlay). Native frames can't
 * scroll their contents, so the panel is an absolutely-positioned HTML overlay
 * that the caller renders using the values returned here. This hook owns the
 * three pieces both panels share verbatim:
 *
 * - **Projection**: the frame's world rect → screen `rect` + `zoom`. The caller
 *   renders content at the frame's world `width`/`height` then `transform:
 *   scale(zoom)`, so text scales like an image instead of reflowing. Read fresh
 *   every render; parents bump a `tick` prop so this re-runs on pan/zoom/move.
 * - **Wheel routing** (native, non-passive — `preventDefault` needs it): when the
 *   frame is SELECTED a plain wheel scrolls the panel; otherwise (or on a
 *   ctrl/⌘ zoom gesture) the wheel is forwarded to the canvas so it pans/zooms
 *   even with the cursor over the panel.
 * - **Stick-to-bottom**: scrolls to the end whenever `stickKey` (or the frame
 *   height) changes — a new message / log line.
 *
 * Returns `rect: null` until the API is mounted and the frame is projectable; the
 * caller should `return null` in that case.
 */
export function useFrameAnchoredPanel(
  frame: ExcalidrawElement | null,
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>,
  stickKey?: string | number,
): {
  scrollRef: RefObject<HTMLDivElement | null>;
  rect: ReturnType<typeof elementScreenRect> | null;
  zoom: number;
  width: number;
  height: number;
} {
  const scrollRef = useRef<HTMLDivElement>(null);

  const api = excalidrawApiRef.current;
  const app = api?.getAppState();
  const zoom = app?.zoom?.value ?? 1;
  const rect =
    frame && app
      ? elementScreenRect(frame, {
          zoom,
          scrollX: app.scrollX ?? 0,
          scrollY: app.scrollY ?? 0,
        })
      : null;
  const width = frame?.width ?? 0;
  const height = frame?.height ?? 0;

  // Stick to the bottom as content arrives / the panel resizes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stickKey, height]);

  // Wheel routing gated on frame selection. Native listener (not React onWheel)
  // because forwarding needs preventDefault, which a passive React handler can't do.
  const frameId = frame?.id ?? null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const isZoom = e.ctrlKey || e.metaKey;
      const api = excalidrawApiRef.current;
      const selected =
        !!frameId && !!api?.getAppState().selectedElementIds?.[frameId];
      if (selected && !isZoom) {
        // Selected: scroll the panel content natively, don't move the canvas.
        e.stopPropagation();
        return;
      }
      // Not selected (or a zoom gesture) → forward to the canvas. preventDefault
      // suppresses the panel's own scroll so the canvas moves alone.
      e.preventDefault();
      e.stopPropagation();
      forwardWheelToExcalidrawCanvas(e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [frameId, excalidrawApiRef]);

  return { scrollRef, rect, zoom, width, height };
}
