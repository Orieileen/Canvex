import { type ReactNode, type RefObject } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { elementScreenRect } from "@/lib/excalidraw-bounds";
import { isFailedPlaceholder, isPendingPlaceholder } from "@/hooks/use-canvas-pinning";

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
 * bounds reservation, see buildPlaceholderAt). PENDING → warm shimmer card +
 * spinner; FAILED → static card + alert icon + the error message (instead of a
 * bare red-text tombstone). A replaced (success) placeholder is gone → no card,
 * so the Excalidraw result shows through.
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

  // One card per placeholder rect (the matching status-text element also matches
  // the predicate, so filter to rectangles to avoid doubles). Pending -> animated
  // shimmer card; failed -> static failure card with the error message, so a
  // failed pre-gen space keeps the same card UI instead of collapsing to bare text.
  const elements = api.getSceneElements();
  const pending = elements.filter((el) => el.type === "rectangle" && isPendingPlaceholder(el));
  const failed = elements.filter((el) => el.type === "rectangle" && isFailedPlaceholder(el));
  if (!pending.length && !failed.length) return null;

  return (
    <>
      {pending.map((el) => (
        <PlaceholderCard key={el.id} el={el} viewport={viewport}>
          {/* Diagonal light sweep. */}
          <div className="canvas-shimmer-sweep absolute inset-0" />
          {/* Breathing ember glow border. */}
          <div className="canvas-glow-breathe absolute inset-0 rounded-xl ring-2 ring-inset ring-ember/40" />
          {/* Centered status. */}
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-ember">
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" strokeWidth={2} />
            <span className="text-sm font-medium">Generating…</span>
          </div>
        </PlaceholderCard>
      ))}
      {failed.map((el) => (
        <PlaceholderCard key={el.id} el={el} viewport={viewport}>
          {/* Static destructive ring (terminal — no breathing/shimmer). */}
          <div className="absolute inset-0 rounded-xl ring-2 ring-inset ring-destructive/50" />
          {/* Centered failure icon + message. */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center text-destructive">
            <AlertTriangle className="size-5" strokeWidth={2} />
            <span className="whitespace-pre-wrap text-sm font-medium">{failedMessage(el, elements)}</span>
          </div>
        </PlaceholderCard>
      ))}
    </>
  );
}

/** Shared placeholder-card chrome: positioned over the element's screen rect with
 *  the opaque warm base that covers the transparent bounds-reservation rect.
 *  Variant content (shimmer/spinner vs alert/message) is passed as children. */
function PlaceholderCard({
  el,
  viewport,
  children,
}: {
  el: ExcalidrawElement;
  viewport: { zoom: number; scrollX: number; scrollY: number };
  children: ReactNode;
}) {
  const rect = elementScreenRect(el, viewport);
  return (
    <div
      className="pointer-events-none absolute z-[1] overflow-hidden rounded-xl shadow-lg"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {/* Opaque warm base — covers the transparent placeholder rect + status text. */}
      <div className="absolute inset-0 bg-gradient-to-br from-sand via-dune to-sand" />
      {children}
    </div>
  );
}

/** Error message for a failed placeholder rect -- read from its grouped status-
 *  text sibling (set by markPlaceholdersFailed). Generic fallback otherwise. */
function failedMessage(
  rect: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): string {
  const groups = new Set(rect.groupIds ?? []);
  const text = elements.find(
    (e) => e.type === "text" && e.id !== rect.id && (e.groupIds ?? []).some((g) => groups.has(g)),
  ) as { text?: string } | undefined;
  return text?.text || "Generation failed";
}
