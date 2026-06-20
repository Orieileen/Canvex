import type { RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawImageElement } from "@excalidraw/excalidraw/element/types";

import { elementScreenRect, type ScreenRect } from "@/lib/excalidraw-bounds";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";

/**
 * Lovart-style measurement HUD — a small dimension chip pinned above the active
 * element(s), reporting its on-canvas size in px (W × H), live through move /
 * resize / crop.
 *
 * Because images are inserted at their NATIVE pixel size (see use-canvas-pinning),
 * on-canvas size equals real resolution at rest — so this chip reads e.g.
 * "2048 × 2048" for a 2048² image — and it tracks live as you resize (the size is
 * the asset, Figma/Lovart-style).
 *
 *   - Single image (± co-selected prompt text / shapes): the image element's
 *     size, chip pinned to the image's own rect.
 *   - Crop mode: the cropping element's size, shown the WHOLE time the cropper is
 *     open (keyed on `croppingElementId`, not just the mid-drag `isCropping`
 *     flag) so the readout persists after you release a handle — letting you stop
 *     precisely on a target size.
 *   - Group selection: the world-space union bbox.
 *
 * Sits ABOVE the bbox so it never collides with the below-anchored ImageEditBar.
 * Read-only overlay — `pointer-events-none`, re-reads live API state every tick
 * (mirrors Mockup3dOverlay / ImageAdjustOverlay). Rendered as a direct child of
 * the `data-canvas-pane` (position: relative) so the screen-space coords from
 * `elementScreenRect` / `selection.bounds` land pane-relative.
 */

interface CanvasMeasureOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  selection: CanvasSelection | null;
  /** Bumped every Excalidraw onChange tick — drives live re-read of viewport,
   *  element dims, and crop state. */
  tick: number;
}

interface DimsChipProps {
  /** Screen-space (pane-relative) box the chip is centered above. */
  box: ScreenRect;
  label: string;
}

/** The chip itself — centered on the box's top edge and lifted just above it.
 *  When the box is near the pane's top, flip the chip to just below the top edge
 *  instead: the canvas pane is `overflow-hidden`, so a chip drawn above y≈0 would
 *  be clipped. */
function DimsChip({ box, label }: DimsChipProps) {
  const flipBelow = box.top < 24;
  return (
    <div
      data-canvas-dims
      className="pointer-events-none absolute z-40"
      style={{
        left: box.left + box.width / 2,
        top: box.top,
        transform: flipBelow
          ? "translate(-50%, 6px)"
          : "translate(-50%, calc(-100% - 6px))",
      }}
    >
      <span className="rounded bg-primary/90 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary-foreground shadow-sm backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}

function formatDims(w: number, h: number): string {
  return `${Math.round(w)} × ${Math.round(h)}`;
}

export function CanvasMeasureOverlay({ excalidrawApiRef, selection, tick }: CanvasMeasureOverlayProps) {
  void tick; // re-render trigger; live state read fresh below
  const api = excalidrawApiRef.current;
  if (!api) return null;

  const appState = api.getAppState();
  const viewport = {
    zoom: appState.zoom?.value ?? 1,
    scrollX: appState.scrollX ?? 0,
    scrollY: appState.scrollY ?? 0,
  };

  // The image to measure: the cropping element (resolved live so the readout
  // persists the WHOLE time the cropper is open — keyed on `croppingElementId`,
  // not the mid-drag-only `isCropping`), else the selected single image (±
  // co-selected prompt text / shapes). Both render identically: the element's
  // on-canvas size, chip pinned to its own rect.
  const croppingId = appState.croppingElementId;
  const croppingEl = croppingId
    ? (api
        .getSceneElements()
        .find((e) => e.id === croppingId && e.type === "image" && !e.isDeleted) as
        | ExcalidrawImageElement
        | undefined)
    : undefined;
  const image =
    croppingEl ??
    (selection?.kind === "single-image" || selection?.kind === "image-with-shapes"
      ? selection.image
      : undefined);
  if (image) {
    return <DimsChip box={elementScreenRect(image, viewport)} label={formatDims(image.width, image.height)} />;
  }

  // Group selection: world-space union bbox.
  if (!selection) return null;
  const b = selection.bounds;
  return (
    <DimsChip
      box={{ left: b.screenX, top: b.screenY, width: b.screenWidth, height: b.screenHeight }}
      label={formatDims(b.width, b.height)}
    />
  );
}
