import { type RefObject } from "react";
import { Loader2 } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { elementScreenRect } from "@/lib/excalidraw-bounds";
import { isPendingPlaceholder } from "@/hooks/use-canvas-pinning";

interface CanvasGeneratingOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Bumped every Excalidraw onChange tick — re-projects the boxes on
   *  pan / zoom / scene change (mirrors CanvasMeasureOverlay). */
  tick: number;
}

/**
 * Lovart-style "生成中" shimmer that replaces the dashed pre-generation box.
 *
 * Excalidraw paints the placeholder rect on its `<canvas>`, which can't run CSS
 * animation — so this DOM overlay draws an opaque warm shimmer card over each
 * PENDING placeholder's live screen rect (the rect itself is now a transparent
 * bounds reservation, see buildPlaceholderAt). When a placeholder is replaced
 * (success) or tombstoned (failed) it's no longer pending → no card → the
 * Excalidraw result / red error text shows through.
 *
 * Read-only / `pointer-events-none`; re-reads live API state every tick like the
 * sibling overlays. Renders nothing when no job is in flight.
 */
export function CanvasGeneratingOverlay({ excalidrawApiRef, tick }: CanvasGeneratingOverlayProps) {
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;

  const appState = api.getAppState();
  const viewport = {
    zoom: appState.zoom?.value ?? 1,
    scrollX: appState.scrollX ?? 0,
    scrollY: appState.scrollY ?? 0,
  };

  // One card per pending placeholder rect (the matching status-text element also
  // satisfies isPendingPlaceholder, so filter to the rectangle to avoid doubles).
  const pending = api
    .getSceneElements()
    .filter((el) => el.type === "rectangle" && isPendingPlaceholder(el));
  if (!pending.length) return null;

  return (
    <>
      {pending.map((el) => {
        const rect = elementScreenRect(el, viewport);
        return (
          <div
            key={el.id}
            className="pointer-events-none absolute z-[1] overflow-hidden rounded-xl shadow-lg"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          >
            {/* Opaque warm base — covers the transparent placeholder + status text. */}
            <div className="absolute inset-0 bg-gradient-to-br from-sand via-dune to-sand" />
            {/* Diagonal light sweep. */}
            <div className="canvas-shimmer-sweep absolute inset-0" />
            {/* Breathing ember glow border. */}
            <div className="canvas-glow-breathe absolute inset-0 rounded-xl ring-2 ring-inset ring-ember/40" />
            {/* Centered status. */}
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-ember">
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none" strokeWidth={2} />
              <span className="text-sm font-medium">Generating…</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
