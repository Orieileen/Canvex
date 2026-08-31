import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from "react";
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
 * - **Click-to-select**: a press inside the panel selects the frame. The panel
 *   covers the frame's whole interior, so without this the only way to select it
 *   is the few px of frame border — and the wheel routing above needs it
 *   selected before it will scroll the panel at all.
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
  /** Put this on the panel root — see "Click-to-select" above. */
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
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

  // Press inside the panel → select the frame. Paired with the wheel routing
  // above on purpose: that only scrolls the panel while the frame is SELECTED,
  // and the panel covers the frame's entire interior. Without this, selecting
  // means hitting the frame's border (or its name label) — which reads as
  // "I clicked the chat box and nothing happened".
  //
  // stopPropagation keeps the press off the canvas so it can't start a
  // selection-box drag. No preventDefault — selecting text inside still works.
  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      e.stopPropagation();
      const api = excalidrawApiRef.current;
      if (!api || !frameId) return;
      const selected = api.getAppState().selectedElementIds ?? {};
      const ids = Object.keys(selected).filter((id) => selected[id]);
      // Already the sole selection — skip the scene update so clicking around
      // inside an open chat isn't a re-render per click.
      if (ids.length === 1 && ids[0] === frameId) return;
      api.updateScene({ appState: { selectedElementIds: { [frameId]: true } } });
    },
    [frameId, excalidrawApiRef],
  );

  return { scrollRef, onPointerDown, rect, zoom, width, height };
}
