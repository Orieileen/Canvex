import { useEffect, useRef, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { screenPointToWorld } from "@/lib/excalidraw-bounds";
import type { CanvasImagePlacement } from "@/hooks/use-canvas-image-import";

/**
 * Cursor-follow placement ghost for a freshly-imported image — Excalidraw's
 * native "pin to place" UX, recreated for the full-res CDN import path
 * (use-canvas-image-import). While mounted (placement active):
 *   - a semi-transparent preview tracks the cursor at the real on-canvas size
 *     (native px × zoom), so you see exactly where and how big it'll land;
 *   - left-click on the canvas drops it there (centered on the cursor);
 *   - Esc / right-click cancels.
 *
 * The ghost is positioned imperatively on `pointermove` (no per-move re-render).
 * Listeners are document-capture so they sit above Excalidraw without blocking
 * pan (middle/space-drag) or wheel-zoom — only a left-click on the canvas is
 * consumed. Mounted only while `placement` is non-null, so its effect lifecycle
 * is the placement lifecycle.
 */

interface CanvasImagePlacementOverlayProps {
  placement: CanvasImagePlacement;
  paneRef: RefObject<HTMLDivElement | null>;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Pin the image with top-left at this world point. */
  onPlace: (anchor: { x: number; y: number }) => void;
  onCancel: () => void;
}

export function CanvasImagePlacementOverlay({
  placement,
  paneRef,
  excalidrawApiRef,
  onPlace,
  onCancel,
}: CanvasImagePlacementOverlayProps) {
  const ghostRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const { naturalWidth, naturalHeight } = placement;
    // Capture the API instance once: it's stable for the Excalidraw mount (a
    // scene switch cancels placement → unmounts this), and `getAppState()` still
    // returns live viewport state through it. Captured so cleanup resets the
    // cursor on the same instance it was set on.
    const api = excalidrawApiRef.current;
    api?.setCursor("crosshair");

    const viewport = () => {
      const app = api?.getAppState();
      return {
        zoom: app?.zoom?.value ?? 1,
        scrollX: app?.scrollX ?? 0,
        scrollY: app?.scrollY ?? 0,
      };
    };

    // Read the pane rect per move: it shifts when the canvas sidebar collapses
    // (a flex sibling animating its width fires no resize/scroll), so caching it
    // would offset both the ghost and the drop point. One layout read per move is
    // fine for a transient gesture.
    const onMove = (e: PointerEvent) => {
      const pane = paneRef.current;
      const ghost = ghostRef.current;
      if (!pane || !ghost) return;
      const rect = pane.getBoundingClientRect();
      const { zoom } = viewport();
      const w = naturalWidth * zoom;
      const h = naturalHeight * zoom;
      ghost.style.width = `${w}px`;
      ghost.style.height = `${h}px`;
      ghost.style.transform = `translate(${e.clientX - rect.left - w / 2}px, ${e.clientY - rect.top - h / 2}px)`;
      ghost.style.visibility = "visible";
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // left only — middle/right keep pan / cancel
      if (!(e.target instanceof HTMLCanvasElement)) return; // only canvas drops
      const pane = paneRef.current;
      if (!pane || !pane.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const center = screenPointToWorld(
        { clientX: e.clientX, clientY: e.clientY },
        pane.getBoundingClientRect(),
        viewport(),
      );
      onPlace({ x: center.x - naturalWidth / 2, y: center.y - naturalHeight / 2 });
    };

    const onContextMenu = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !paneRef.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      api?.resetCursor();
    };
  }, [placement, paneRef, excalidrawApiRef, onPlace, onCancel]);

  return (
    // z-[60] is above Excalidraw's chrome (zIndex 4) on purpose: unlike the
    // read-only HUD overlays (which sit BELOW the toolbar at z-[1]/z-[3]), this is
    // a transient, modal-ish cursor-follow preview that must track over the whole
    // pane while placing.
    <>
      <img
        ref={ghostRef}
        src={placement.previewUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 z-[60] rounded-sm opacity-70 shadow-lg ring-1 ring-primary/60"
        style={{ visibility: "hidden" }}
      />
      <div className="pointer-events-none absolute left-1/2 top-3 z-[60] -translate-x-1/2 rounded-full bg-foreground/85 px-3 py-1 text-xs text-background shadow">
        Click to place · Esc to cancel
      </div>
    </>
  );
}
