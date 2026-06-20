import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import * as THREE from "three";
import { DecalGeometry } from "three/examples/jsm/geometries/DecalGeometry.js";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";

import {
  DEFAULT_MOCKUP_ROTATION,
  DEFAULT_MOCKUP_SCALE,
  anchorToWorld,
  getMockupBinding,
  resolveMaskThreshold,
  resolveOpacity,
  resolveScaleY,
  type Mockup3dBinding,
} from "@/lib/canvas-mockup";
import { forwardWheelToExcalidrawCanvas } from "@/lib/excalidraw-wheel-forward";
import { elementScreenRect } from "@/lib/excalidraw-bounds";
import { cn } from "@/lib/utils";
import type { DepthStatus } from "@/hooks/use-mockup";

/**
 * Per-binding Three.js overlay — separate canvas per mockup so each has its
 * own viewport. For each base image with a mockup3d binding:
 *   - Bg mesh: depth-displaced PlaneGeometry from base + depth map
 *   - Decal: DecalGeometry projected onto that mesh from the anchor's normal
 */

// Hardcoded English labels (Canvex has no `canvas` i18n namespace yet).
// Folded back into i18n when the full string merge lands. Keys mirror the
// meired `canvas` namespace so the merge is a mechanical lookup.
const LABELS = {
  "mockup.computingDepth": "Computing depth…",
  "mockup.depthFailed": "Depth failed",
  "mockup.dropDesign": "Drop a design here",
  "mockup.badge": "3D Mockup",
  "mockup.remove": "Remove mockup",
  "gizmo.dragMove": "Drag to move",
  "gizmo.dragResize": "Drag to resize · double-click to reset",
  "gizmo.dragResizeWidth": "Drag to resize width · double-click to reset",
  "gizmo.dragResizeHeight": "Drag to resize height · double-click to reset",
  "gizmo.dragRotate": "Drag to rotate · double-click to reset",
} as const;

type LabelKey = keyof typeof LABELS;
function t(key: LabelKey): string {
  return LABELS[key];
}

interface Mockup3dOverlayProps {
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Pane element used as the screen-space origin for gizmo drag math.
   *  Pointer coords are page-relative; we need the pane's getBoundingClientRect
   *  to translate them into Excalidraw scene coords. */
  paneRef: RefObject<HTMLElement | null>;
  receivingBaseId: string | null;
  depthStatusFor: (baseId: string) => DepthStatus;
  /** Bumped every Excalidraw onChange tick — drives a re-render so we re-read
   *  live API state (viewport + element positions). */
  tick: number;
  /** Live updates from the in-canvas transform gizmo. The panel's sliders
   *  call the same actions; both edit the same binding. */
  onAnchorChange: (baseId: string, anchor: readonly [number, number]) => void;
  onScaleChange: (baseId: string, scale: number) => void;
  onScaleYChange: (baseId: string, scaleY: number) => void;
  onRotationChange: (baseId: string, rotation: number) => void;
  /** Removes the binding from the base — design's file stays in the scene
   *  (marked isDeleted) so an undo can recover it; the base goes back to
   *  rendering plainly. */
  onRemove: (baseId: string) => void;
  /** Restores the soft-deleted design as a normal canvas element at the
   *  given world position and clears the binding. Triggered by dragging the
   *  design out of the base bbox. */
  onDetach: (params: { baseId: string; worldX: number; worldY: number }) => void;
}

const MIN_GIZMO_SIZE = 48; // CSS px — minimum hit area so tiny decals stay grabbable
const ROTATE_HANDLE_OFFSET = 24; // CSS px above the gizmo top edge for the rotate stub

// Shared base for the two full-pane overlay layers below (they differ only in
// z-index — see the render/interaction comments at each layer).
const OVERLAY_LAYER = "pointer-events-none absolute inset-0 overflow-hidden";

/** 4 corner handle positions (uniform-scale; cursor matches CSS resize axes). */
const CORNER_SPECS = [
  { x: 0, y: 0, cursor: "nwse-resize" },
  { x: 1, y: 0, cursor: "nesw-resize" },
  { x: 0, y: 1, cursor: "nesw-resize" },
  { x: 1, y: 1, cursor: "nwse-resize" },
] as const;

/** 4 edge handle specs (single-axis scale). Width/height pre-baked so the
 *  JSX style block stays a flat object spread instead of per-side ternary. */
const EDGE_SPECS = [
  { side: "left",   axis: "x", left: "0%",   top: "50%", cursor: "ew-resize", w: "0.5rem", h: "1.5rem" },
  { side: "right",  axis: "x", left: "100%", top: "50%", cursor: "ew-resize", w: "0.5rem", h: "1.5rem" },
  { side: "top",    axis: "y", left: "50%",  top: "0%",  cursor: "ns-resize", w: "1.5rem", h: "0.5rem" },
  { side: "bottom", axis: "y", left: "50%",  top: "100%", cursor: "ns-resize", w: "1.5rem", h: "0.5rem" },
] as const;

/** Approximate screen rect of the decal. Three.js renders the aspect-preserved
 *  decal independently — the gizmo is just for interaction, so when scaleY
 *  is undefined we fall back to scale (square gizmo), accepting a slight
 *  visual mismatch with the actual painted shape. */
function computeGizmoRect(r: BindingRender): { cx: number; cy: number; w: number; h: number } {
  const baseSize = Math.min(r.screenRect.width, r.screenRect.height);
  const w = Math.max(MIN_GIZMO_SIZE, r.binding.scale * baseSize);
  const h = Math.max(MIN_GIZMO_SIZE, resolveScaleY(r.binding) * baseSize);
  return {
    cx: r.screenRect.left + r.binding.anchor[0] * r.screenRect.width,
    cy: r.screenRect.top + r.binding.anchor[1] * r.screenRect.height,
    w, h,
  };
}

interface BindingRender {
  baseId: string;
  isSelected: boolean;
  baseDataURL: string;
  depthDataURL: string;
  /** Foreground mask data URL — null when binding predates segmentation;
   *  the renderer falls back to depth-based mask in that case. */
  maskDataURL: string | null;
  designDataURL: string;
  binding: Mockup3dBinding;
  screenRect: { left: number; top: number; width: number; height: number };
}

export function Mockup3dOverlay({
  excalidrawApiRef,
  paneRef,
  receivingBaseId,
  depthStatusFor,
  tick,
  onAnchorChange,
  onScaleChange,
  onScaleYChange,
  onRotationChange,
  onRemove,
  onDetach,
}: Mockup3dOverlayProps) {
  void tick;

  // Floating ghost during a move drag — a 2D thumbnail of the design that
  // follows the cursor outside the base bbox. The actual mockup decal stays
  // at its current anchor; only on pointerup do we commit the new state
  // (re-anchor inside, detach outside). Without this, the design felt
  // "trapped" at the base's edges because anchor was clamped to [0..1].
  const [dragGhost, setDragGhost] = useState<{
    designDataURL: string;
    cursorX: number; // viewport coords (matches PointerEvent.clientX)
    cursorY: number;
    width: number;  // CSS px
    height: number;
    rotation: number;
  } | null>(null);

  const api = excalidrawApiRef.current;
  let ringRect: { left: number; top: number; width: number; height: number } | null = null;
  let ringStatus: DepthStatus = "idle";
  const renders: BindingRender[] = [];

  if (api) {
    const appState = api.getAppState();
    const elements = api.getSceneElements();
    const files = api.getFiles();
    const zoom = appState.zoom?.value ?? 1;
    const scrollX = appState.scrollX ?? 0;
    const scrollY = appState.scrollY ?? 0;
    const selectedIds = (appState.selectedElementIds ?? {}) as Record<string, true | undefined>;

    if (receivingBaseId) {
      const base = elements.find(
        (el) => el.id === receivingBaseId && el.type === "image" && !el.isDeleted,
      ) as ExcalidrawImageElement | undefined;
      if (base) {
        ringRect = elementScreenRect(base, { zoom, scrollX, scrollY });
        ringStatus = depthStatusFor(receivingBaseId);
      }
    }

    for (const el of elements) {
      if (el.isDeleted || el.type !== "image") continue;
      const binding = getMockupBinding(el);
      if (!binding) continue;
      const baseImg = el as ExcalidrawImageElement;
      if (!baseImg.fileId) continue;
      const baseDataURL = files[baseImg.fileId]?.dataURL;
      const depthDataURL = files[binding.depthFileId]?.dataURL;
      const maskDataURL = binding.maskFileId ? files[binding.maskFileId]?.dataURL ?? null : null;
      const designDataURL = files[binding.designFileId]?.dataURL;
      if (!baseDataURL || !depthDataURL || !designDataURL) continue;
      renders.push({
        baseId: el.id,
        isSelected: !!selectedIds[el.id],
        baseDataURL,
        depthDataURL,
        maskDataURL,
        designDataURL,
        binding,
        screenRect: elementScreenRect(baseImg, { zoom, scrollX, scrollY }),
      });
    }
  }

  // ── Drag handlers (move / resize / rotate) ──────────────────────────────
  //
  // Common pattern: pointerdown captures start state + opens global
  // pointermove/up listeners. Each frame re-reads live API state so
  // concurrent zoom/pan via wheel forwarding doesn't desync the math.

  /** Setup boilerplate shared by all drag handlers. `onEnd` (optional) fires
   *  on pointerup/cancel — used by move drag to detect detach. */
  const beginDrag = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      onMove: (ev: PointerEvent) => void,
      onEnd?: (ev: PointerEvent) => void,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
      const onUp = (ev: PointerEvent) => {
        try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        onEnd?.(ev);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [],
  );

  /** Drag the gizmo center → real-time anchor inside, detach on release outside.
   *  - Inside the base bbox: anchor updates live, the decal follows the cursor
   *    smoothly (the gizmo is the visual feedback).
   *  - Outside: anchor clamps at the edge, but a floating ghost of the design
   *    follows the cursor freely so it doesn't feel "trapped" in the container.
   *  On release: outside → detach (revive design at drop point); inside → done. */
  const startMoveDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, render: BindingRender) => {
      const startUv = render.binding.anchor;
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const liveBase = () => {
        const apiLive = excalidrawApiRef.current;
        if (!apiLive) return null;
        return apiLive.getSceneElements().find(
          (el) => el.id === render.baseId && el.type === "image" && !el.isDeleted,
        ) as ExcalidrawImageElement | undefined;
      };
      const cursorWorld = (ev: PointerEvent): { x: number; y: number } | null => {
        const apiLive = excalidrawApiRef.current;
        const pane = paneRef.current;
        if (!apiLive || !pane) return null;
        const state = apiLive.getAppState();
        const z = state.zoom?.value ?? 1;
        const sx = state.scrollX ?? 0;
        const sy = state.scrollY ?? 0;
        const rect = pane.getBoundingClientRect();
        return {
          x: (ev.clientX - rect.left) / z - sx,
          y: (ev.clientY - rect.top) / z - sy,
        };
      };
      const g = computeGizmoRect(render);
      beginDrag(e, (ev) => {
        const baseLive = liveBase();
        const apiLive = excalidrawApiRef.current;
        if (!baseLive || !apiLive) return;
        const z = apiLive.getAppState().zoom?.value ?? 1;
        const du = (ev.clientX - startClientX) / z / baseLive.width;
        const dv = (ev.clientY - startClientY) / z / baseLive.height;
        const nextU = startUv[0] + du;
        const nextV = startUv[1] + dv;
        onAnchorChange(render.baseId, [
          Math.max(0, Math.min(1, nextU)),
          Math.max(0, Math.min(1, nextV)),
        ]);
        const outside = nextU < 0 || nextU > 1 || nextV < 0 || nextV > 1;
        if (outside) {
          setDragGhost({
            designDataURL: render.designDataURL,
            cursorX: ev.clientX,
            cursorY: ev.clientY,
            width: g.w,
            height: g.h,
            rotation: render.binding.rotation,
          });
        } else {
          setDragGhost(null);
        }
      }, (ev) => {
        setDragGhost(null);
        const baseLive = liveBase();
        const w = cursorWorld(ev);
        if (!baseLive || !w) return;
        const outside =
          w.x < baseLive.x || w.x > baseLive.x + baseLive.width ||
          w.y < baseLive.y || w.y > baseLive.y + baseLive.height;
        if (outside) onDetach({ baseId: render.baseId, worldX: w.x, worldY: w.y });
      });
    },
    [beginDrag, excalidrawApiRef, paneRef, onAnchorChange, onDetach],
  );

  /** Resolve the anchor's current screen-space center — the pivot point for
   *  resize/rotate drags. Returns null when API/pane/base aren't ready. */
  const getAnchorScreenPos = useCallback(
    (render: BindingRender): { x: number; y: number } | null => {
      const apiNow = excalidrawApiRef.current;
      const pane = paneRef.current;
      if (!apiNow || !pane) return null;
      const baseEl = apiNow.getSceneElements().find(
        (el) => el.id === render.baseId && el.type === "image" && !el.isDeleted,
      ) as ExcalidrawImageElement | undefined;
      if (!baseEl) return null;
      const state = apiNow.getAppState();
      const z = state.zoom?.value ?? 1;
      const sx = state.scrollX ?? 0;
      const sy = state.scrollY ?? 0;
      const paneRect = pane.getBoundingClientRect();
      const [aWorldX, aWorldY] = anchorToWorld(baseEl, render.binding.anchor);
      return {
        x: paneRect.left + (aWorldX + sx) * z,
        y: paneRect.top + (aWorldY + sy) * z,
      };
    },
    [excalidrawApiRef, paneRef],
  );

  /** Drag the external rotate stub → rotate. Angle measured from anchor to
   *  pointer; delta added to the starting rotation. */
  const startRotateDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, render: BindingRender) => {
      const a = getAnchorScreenPos(render);
      if (!a) return;
      const startAngle = Math.atan2(e.clientY - a.y, e.clientX - a.x);
      const startRotation = render.binding.rotation;
      beginDrag(e, (ev) => {
        const curAngle = Math.atan2(ev.clientY - a.y, ev.clientX - a.x);
        onRotationChange(render.baseId, startRotation + (curAngle - startAngle));
      });
    },
    [beginDrag, getAnchorScreenPos, onRotationChange],
  );

  /** Drag any corner → uniform scale on both axes. Both axes are multiplied
   *  by the same `current_dist / start_dist` ratio so the current aspect
   *  ratio is preserved through the drag. */
  const startUniformScaleDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, render: BindingRender) => {
      const a = getAnchorScreenPos(render);
      if (!a) return;
      const startDist = Math.max(4, Math.hypot(e.clientX - a.x, e.clientY - a.y));
      const startScaleY = resolveScaleY(render.binding);
      beginDrag(e, (ev) => {
        const curDist = Math.hypot(ev.clientX - a.x, ev.clientY - a.y);
        const ratio = curDist / startDist;
        if (!Number.isFinite(ratio) || ratio <= 0) return;
        onScaleChange(render.baseId, render.binding.scale * ratio);
        onScaleYChange(render.baseId, startScaleY * ratio);
      });
    },
    [beginDrag, getAnchorScreenPos, onScaleChange, onScaleYChange],
  );

  /** Drag a side handle → scale on that axis. Project the screen-space
   *  pointer offset onto the design's local axis (which rotates with the
   *  binding), so dragging the right edge always feels like "wider", even
   *  when the design is rotated 90° on canvas. */
  const startScaleAxisDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, render: BindingRender, axis: "x" | "y") => {
      const a = getAnchorScreenPos(render);
      if (!a) return;
      const angle = render.binding.rotation;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const projectLocal = (dx: number, dy: number) =>
        axis === "x" ? dx * cos + dy * sin : -dx * sin + dy * cos;
      const startLocal = projectLocal(e.clientX - a.x, e.clientY - a.y);
      if (Math.abs(startLocal) < 4) return; // degenerate (handle on top of anchor)
      const startScale = axis === "x" ? render.binding.scale : resolveScaleY(render.binding);
      const setter = axis === "x" ? onScaleChange : onScaleYChange;
      beginDrag(e, (ev) => {
        const curLocal = projectLocal(ev.clientX - a.x, ev.clientY - a.y);
        const ratio = curLocal / startLocal;
        if (!Number.isFinite(ratio) || ratio <= 0) return;
        setter(render.baseId, startScale * ratio);
      });
    },
    [beginDrag, getAnchorScreenPos, onScaleChange, onScaleYChange],
  );

  return (
    <>
    {/* Render layer — Excalidraw static-canvas (image) depth, zIndex 1: above
        the base image it sits on, but below the interactive canvas (selection,
        zIndex 2) and the UI chrome (toolbars, zIndex 4). The live render, the
        always-on "3D" badge, and the receiving ring are read-only annotations
        (pointer-events-none), so they never cover Excalidraw's controls. */}
    <div className={cn(OVERLAY_LAYER, "z-[1]")}>
      {ringRect && (
        <div
          data-mockup-receiving-ring
          className="absolute rounded-md border-2 border-dashed border-primary"
          style={ringRect}
        >
          {ringStatus === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-xs text-primary backdrop-blur-sm">
              {t("mockup.computingDepth")}
            </div>
          )}
          {ringStatus === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-destructive/10 text-xs text-destructive backdrop-blur-sm">
              {t("mockup.depthFailed")}
            </div>
          )}
          {ringStatus === "ready" && (
            <div className="absolute inset-x-0 top-2 mx-auto w-fit rounded bg-background/90 px-2 py-0.5 text-xs text-primary">
              {t("mockup.dropDesign")}
            </div>
          )}
        </div>
      )}
      {renders.map((r) => (
        <div
          key={r.baseId}
          data-mockup-3d-base={r.baseId}
          // Always pointer-events-none on the canvas: zoom, pan, select/drag
          // base, and clicks all pass through to Excalidraw. Interaction
          // happens only via the gizmo below.
          className="pointer-events-none absolute"
          style={{
            left: r.screenRect.left,
            top: r.screenRect.top,
            width: r.screenRect.width,
            height: r.screenRect.height,
          }}
        >
          <Mockup3dBaseRenderer
            baseId={r.baseId}
            baseDataURL={r.baseDataURL}
            depthDataURL={r.depthDataURL}
            maskDataURL={r.maskDataURL}
            designDataURL={r.designDataURL}
            binding={r.binding}
            width={r.screenRect.width}
            height={r.screenRect.height}
          />
        </div>
      ))}
      {/* "3D" badge — visible on every base with a binding so users see at
          a glance which images carry a mockup, even when not selected. */}
      {renders.map((r) => (
        <div
          key={`${r.baseId}-badge`}
          data-mockup-badge={r.baseId}
          className="pointer-events-none absolute z-40"
          style={{ left: r.screenRect.left + 6, top: r.screenRect.top + 6 }}
        >
          <span className="rounded bg-primary/85 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground shadow-sm backdrop-blur-sm">
            {t("mockup.badge")}
          </span>
        </div>
      ))}
    </div>
    {/* Interaction layer — above the interactive canvas (zIndex 2) so the gizmo
        handles stay hit-testable (the canvas would otherwise swallow the
        pointerdown) and the drag ghost stays visible, while still below
        Excalidraw's UI chrome (zIndex 4) so it never covers the toolbars. */}
    <div className={cn(OVERLAY_LAYER, "z-[3]")}>
      {/* Transform gizmo (only when base is selected). Container rotates with
          the design; corner handles uniform-scale, edge handles axis-scale,
          external stub above the top edge rotates. */}
      {renders.map((r) => {
        if (!r.isSelected) return null;
        const g = computeGizmoRect(r);
        return (
          <div
            key={`${r.baseId}-gizmo`}
            data-mockup-gizmo={r.baseId}
            className="pointer-events-none absolute"
            style={{
              left: g.cx,
              top: g.cy,
              width: g.w,
              height: g.h,
              transform: `translate(-50%, -50%) rotate(${r.binding.rotation}rad)`,
              transformOrigin: "50% 50%",
            }}
          >
            <div className="absolute inset-0 rounded-md border-2 border-primary/70" />
            <div
              data-mockup-move
              onPointerDown={(e) => startMoveDrag(e, r)}
              onWheel={forwardWheelToExcalidrawCanvas}
              className="pointer-events-auto absolute inset-3 cursor-move rounded-sm hover:bg-primary/5"
              title={t("gizmo.dragMove")}
            />
            {CORNER_SPECS.map((c, i) => (
              <div
                key={i}
                data-mockup-resize={i}
                onPointerDown={(e) => startUniformScaleDrag(e, r)}
                onDoubleClick={() => {
                  onScaleChange(r.baseId, DEFAULT_MOCKUP_SCALE);
                  onScaleYChange(r.baseId, DEFAULT_MOCKUP_SCALE);
                }}
                onWheel={forwardWheelToExcalidrawCanvas}
                className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-md hover:scale-125"
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, cursor: c.cursor }}
                title={t("gizmo.dragResize")}
              />
            ))}
            {EDGE_SPECS.map((s) => (
              <div
                key={s.side}
                data-mockup-scale={s.axis}
                onPointerDown={(e) => startScaleAxisDrag(e, r, s.axis)}
                onDoubleClick={() => {
                  const setter = s.axis === "x" ? onScaleChange : onScaleYChange;
                  setter(r.baseId, DEFAULT_MOCKUP_SCALE);
                }}
                onWheel={forwardWheelToExcalidrawCanvas}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-md hover:scale-110"
                style={{ left: s.left, top: s.top, cursor: s.cursor, width: s.w, height: s.h }}
                title={s.axis === "x" ? t("gizmo.dragResizeWidth") : t("gizmo.dragResizeHeight")}
              />
            ))}
            {/* External rotate stub: a dot above the top edge connected by a
                thin arm. Sits in the rotated frame so it always points "up"
                relative to the design. Double-click resets rotation to 0. */}
            <div
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 bg-primary/60"
              style={{ top: -ROTATE_HANDLE_OFFSET, width: 1, height: ROTATE_HANDLE_OFFSET }}
            />
            <div
              data-mockup-rotate
              onPointerDown={(e) => startRotateDrag(e, r)}
              onDoubleClick={() => onRotationChange(r.baseId, DEFAULT_MOCKUP_ROTATION)}
              onWheel={forwardWheelToExcalidrawCanvas}
              className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-primary bg-background shadow-md hover:scale-125 active:cursor-grabbing"
              style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET }}
              title={t("gizmo.dragRotate")}
            />
            {/* Delete button — clears the binding (design's file kept,
                undo restores). Sits offset from the top-right corner so it
                doesn't overlap the corner rotate handle. */}
            <button
              type="button"
              data-mockup-remove
              onPointerDown={(e) => { e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); onRemove(r.baseId); }}
              onWheel={forwardWheelToExcalidrawCanvas}
              className="pointer-events-auto absolute flex size-5 -translate-y-1/2 translate-x-1/2 cursor-pointer items-center justify-center rounded-full border-2 border-destructive bg-background text-destructive shadow-md hover:scale-110"
              style={{ left: "100%", top: 0, marginLeft: 8, marginTop: -8 }}
              title={t("mockup.remove")}
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
      {dragGhost && (
        <div
          data-mockup-drag-ghost
          // `fixed` so the ghost can leave the gizmo's bbox + the parent
          // overlay's `overflow-hidden` clip. Cursor coords are viewport-
          // relative, which is exactly what `position: fixed` uses.
          className="pointer-events-none fixed z-50"
          style={{
            left: dragGhost.cursorX,
            top: dragGhost.cursorY,
            width: dragGhost.width,
            height: dragGhost.height,
            transform: `translate(-50%, -50%) rotate(${dragGhost.rotation}rad)`,
            backgroundImage: `url(${dragGhost.designDataURL})`,
            backgroundSize: "contain",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            opacity: 0.85,
            filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.35))",
          }}
        />
      )}
    </div>
    </>
  );
}

// ───── Per-binding Three.js renderer ────────────────────────────────────────

interface SubRendererProps {
  baseId: string;
  baseDataURL: string;
  depthDataURL: string;
  maskDataURL: string | null;
  designDataURL: string;
  binding: Mockup3dBinding;
  width: number;
  height: number;
}

/** baseId → 该 base 的 Three.js GLState. ImageEditBar 下载时按 baseId 查到
 *  scene/renderer/camera, 调 captureMockupAtSize 在 base 原分辨率下临时
 *  resize+render+读取+还原, 拿到不糊的 overlay 用于合成. */
const mockupStateRegistry = new Map<string, GLState>();

// HMR 替换本模块时清空 registry: 旧的 GLState 还会被组件卸载 effect 清掉,
// 但如果 Vite 把模块换了又没重 mount 子组件, 旧 entry 会留着. 兜底清理.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    mockupStateRegistry.clear();
  });
}

/** 在 native (base 原图) 分辨率下抓一帧 mockup overlay, 用于下载合成时的
 *  锐利覆盖. setSize 第三参 false 只改 backing buffer 不动 CSS, 同步执行
 *  且最后还原 + 重渲, 屏幕上看不见任何中间状态. */
export function captureMockupAtSize(
  baseId: string,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const state = mockupStateRegistry.get(baseId);
  if (!state) return null;

  const oldSize = new THREE.Vector2();
  state.renderer.getSize(oldSize);
  const oldDpr = state.renderer.getPixelRatio();
  const oldAspect = state.camera.aspect;

  try {
    state.renderer.setPixelRatio(1);
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    state.renderer.render(state.scene, state.camera);

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(state.renderer.domElement, 0, 0);
    return out;
  } finally {
    state.renderer.setPixelRatio(oldDpr);
    state.renderer.setSize(oldSize.x, oldSize.y, false);
    state.camera.aspect = oldAspect;
    state.camera.updateProjectionMatrix();
    state.renderer.render(state.scene, state.camera);
  }
}

interface GLState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bgMesh: THREE.Mesh | null;
  decalMesh: THREE.Mesh | null;
  baseTexture: THREE.Texture | null;
  designTexture: THREE.Texture | null;
  /** Depth map as a GPU texture — fallback foreground mask when the
   *  dedicated segmentation hasn't been computed for this binding. */
  depthTexture: THREE.Texture | null;
  /** Dedicated foreground mask from RMBG-1.4 — preferred over depth when
   *  available. White = subject, black = background. */
  maskTexture: THREE.Texture | null;
  /** Decoded depth pixels (grayscale, single channel). Used for vertex
   *  displacement on the bg mesh + the JS-side normal estimation at anchor. */
  depthSample: { data: Uint8Array; width: number; height: number } | null;
  /** Decoded foreground mask pixels (RMBG output). When present, multiplied
   *  into depth at each vertex so the background stays flat — only the
   *  subject curves outward. Without this, the bg mesh has a "shelf" behind
   *  the subject and the decal projection drips onto background regions. */
  maskSample: { data: Uint8Array; width: number; height: number } | null;
  /** Aspect ratio of the base image, drives mesh dimensions. */
  baseAspect: number;
  /** Strength used to displace the bg mesh, captured here so the decal
   *  shader can reconstruct the same z = depth × mask × strength × MAX
   *  surface for normal/silhouette computation. */
  bgStrength: number;
  mounted: boolean;
}

// Higher subdivision = smoother surface contour following the depth field.
// 192² ≈ 37k vertices — well within budget for a single mockup at 60fps.
const MESH_SEGMENTS = 192;
// World units of vertex displacement at strength=1. Mirrored as `DEPTH_MAX`
// in the fragment shader for normal/silhouette computation — keep the two
// in sync.
const DEPTH_DISPLACEMENT_MAX = 0.6;

function Mockup3dBaseRenderer({
  baseId,
  baseDataURL,
  depthDataURL,
  maskDataURL,
  designDataURL,
  binding,
  width,
  height,
}: SubRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<GLState | null>(null);

  // Mount Three.js once per renderer lifetime.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const state = initScene(container);
    stateRef.current = state;
    mockupStateRegistry.set(baseId, state);
    return () => {
      mockupStateRegistry.delete(baseId);
      disposeScene(state);
      stateRef.current = null;
    };
  }, [baseId]);

  // Resize on width/height change. Preserves DPR awareness.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    if (width === 0 || height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.renderer.setPixelRatio(dpr);
    state.renderer.setSize(width, height, true);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    renderScene(state);
  }, [width, height]);

  // Pull primitives so deps are stable refs — `binding` itself is a fresh
  // object every parent render, which previously triggered a full Three.js
  // rebuild ~60×/sec on viewport-only ticks.
  const { strength, anchor, scale, rotation } = binding;
  const scaleY = binding.scaleY ?? null;
  const maskThreshold = resolveMaskThreshold(binding);
  const opacity = resolveOpacity(binding);
  const anchorU = anchor[0];
  const anchorV = anchor[1];

  useEffect(() => {
    let cancelled = false;
    void rebuildBackground(stateRef, baseDataURL, depthDataURL, maskDataURL, strength).then(() => {
      if (cancelled) return;
      void rebuildDecal(stateRef, designDataURL, [anchorU, anchorV] as const, scale, scaleY, rotation, maskThreshold, opacity);
    });
    return () => { cancelled = true; };
  }, [baseDataURL, depthDataURL, maskDataURL, strength, designDataURL, anchorU, anchorV, scale, scaleY, rotation, maskThreshold, opacity]);

  return <div ref={containerRef} className="size-full" />;
}

// ───── Three.js scene primitives ────────────────────────────────────────────

function initScene(container: HTMLDivElement): GLState {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    // 必须 true: 不开的话 WebGL 在 swap 后清空 backing buffer, 导致下载
    // (ImageEditBar 里 drawImage(overlay) 合成 PNG) 拿到全透明的 overlay,
    // 用户只下到底图. 一份额外 framebuffer 内存换离屏读取能力, 这种轻量
    // mockup overlay 用例可以忽略不计.
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  // CSS sizing — actual pixel dims set in resize effect.
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";

  const scene = new THREE.Scene();

  // Camera positioned to view the unit-height plane filling the viewport.
  // Aspect set in resize effect.
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 2.4);
  camera.lookAt(0, 0, 0);
  scene.add(camera);

  // Lighting: ambient floor + key directional for surface relief readability.
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 0.5);
  key.position.set(2, 3, 4);
  scene.add(key);

  return {
    renderer,
    scene,
    camera,
    bgMesh: null,
    decalMesh: null,
    baseTexture: null,
    designTexture: null,
    depthTexture: null,
    maskTexture: null,
    depthSample: null,
    maskSample: null,
    baseAspect: 1,
    bgStrength: 0.5,
    mounted: true,
  };
}

function disposeScene(state: GLState | null): void {
  if (!state) return;
  state.mounted = false;
  state.scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose();
    }
  });
  state.baseTexture?.dispose();
  state.designTexture?.dispose();
  state.depthTexture?.dispose();
  state.maskTexture?.dispose();
  state.renderer.dispose();
  state.renderer.domElement.remove();
}

function renderScene(state: GLState): void {
  if (!state.mounted) return;
  state.renderer.render(state.scene, state.camera);
}

// ───── Background mesh: depth-displaced height field ────────────────────────

async function loadTexture(dataURL: string): Promise<{ texture: THREE.Texture; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      dataURL,
      (texture) => {
        const img = texture.image as HTMLImageElement;
        texture.colorSpace = THREE.SRGBColorSpace;
        resolve({ texture, width: img.naturalWidth, height: img.naturalHeight });
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/** Decode a grayscale PNG dataURL to a single-channel Uint8 array via canvas. */
async function loadGrayscale(
  dataURL: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("depth image load failed"));
    img.src = dataURL;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context for depth decode");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = id.data[j];
  return { data: out, width: c.width, height: c.height };
}

function sampleDepth(
  depth: { data: Uint8Array; width: number; height: number },
  u: number,
  v: number,
): number {
  const x = Math.min(depth.width - 1, Math.max(0, Math.floor(u * depth.width)));
  // Note: image y goes top-down; UV v=0 is bottom in our convention,
  // but depth maps come out top-down too. We keep v=0 → image top so
  // the displacement lines up visually with the source photo.
  const y = Math.min(depth.height - 1, Math.max(0, Math.floor(v * depth.height)));
  return depth.data[y * depth.width + x] / 255;
}

async function rebuildBackground(
  ref: RefObject<GLState | null>,
  baseDataURL: string,
  depthDataURL: string,
  maskDataURL: string | null,
  strength: number,
): Promise<void> {
  const state = ref.current;
  if (!state) return;
  const [baseLoaded, depthSample, depthLoaded, maskLoaded, maskSample] = await Promise.all([
    loadTexture(baseDataURL),
    loadGrayscale(depthDataURL),
    loadTexture(depthDataURL),
    maskDataURL ? loadTexture(maskDataURL) : Promise.resolve(null),
    maskDataURL ? loadGrayscale(maskDataURL) : Promise.resolve(null),
  ]);
  if (!ref.current || !ref.current.mounted) {
    baseLoaded.texture.dispose();
    depthLoaded.texture.dispose();
    maskLoaded?.texture.dispose();
    return;
  }
  const aspect = baseLoaded.width / baseLoaded.height;
  state.baseAspect = aspect;
  state.depthSample = depthSample;
  state.maskSample = maskSample;
  state.bgStrength = strength;
  // Depth & mask textures: linear colorSpace because they are data, not color.
  if (state.depthTexture) state.depthTexture.dispose();
  depthLoaded.texture.colorSpace = THREE.NoColorSpace;
  state.depthTexture = depthLoaded.texture;
  if (state.maskTexture) state.maskTexture.dispose();
  if (maskLoaded) {
    maskLoaded.texture.colorSpace = THREE.NoColorSpace;
    state.maskTexture = maskLoaded.texture;
  } else {
    state.maskTexture = null;
  }

  // Replace previous bg mesh
  if (state.bgMesh) {
    state.scene.remove(state.bgMesh);
    state.bgMesh.geometry.dispose();
    (state.bgMesh.material as THREE.Material).dispose();
  }
  if (state.baseTexture) state.baseTexture.dispose();
  state.baseTexture = baseLoaded.texture;

  // Geometry sized to fit the camera view at z=0. Plane height = 2 world units
  // matches camera.position.z=2.4 + FOV=50° giving roughly viewport height.
  const W = 2 * aspect;
  const H = 2;
  const geom = new THREE.PlaneGeometry(W, H, MESH_SEGMENTS, MESH_SEGMENTS);
  const positions = geom.attributes.position as THREE.BufferAttribute;
  // Vertex (i, j) in [0..MESH_SEGMENTS]: corresponds to UV (i/N, j/N)
  for (let i = 0; i < positions.count; i++) {
    // PlaneGeometry vertex order: rows of (MESH_SEGMENTS+1) verts, top row first
    const ix = i % (MESH_SEGMENTS + 1);
    const iy = Math.floor(i / (MESH_SEGMENTS + 1));
    const u = ix / MESH_SEGMENTS;
    const v = iy / MESH_SEGMENTS;
    const d = sampleDepth(depthSample, u, v);
    // Foreground gating: when a segmentation mask is available, multiply
    // depth by mask alpha so background pixels stay flat (z=0). The decal
    // can then only attach to the protruding subject — no shelf behind the
    // model collecting the projection. Without a mask, fall back to plain
    // depth (binding predates segmentation, depth used as coarse mask).
    const m = maskSample ? sampleDepth(maskSample, u, v) : 1;
    positions.setZ(i, d * m * strength * DEPTH_DISPLACEMENT_MAX);
  }
  positions.needsUpdate = true;
  geom.computeVertexNormals();

  // Bg mesh participates in z-buffer (so DecalGeometry can project onto its
  // surface) but doesn't write color — Excalidraw renders the actual base
  // photo underneath, no double-render. Texture binding is kept on the
  // material so DecalGeometry's UV computation still works against the
  // textured surface; only the rasterizer is told not to commit color.
  const mat = new THREE.MeshLambertMaterial({
    map: baseLoaded.texture,
    side: THREE.DoubleSide,
    colorWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  state.bgMesh = mesh;
  state.scene.add(mesh);
  renderScene(state);
}

// ───── Decal: project design onto the displaced background ──────────────────

async function rebuildDecal(
  ref: RefObject<GLState | null>,
  designDataURL: string,
  anchor: readonly [number, number],
  scale: number,
  scaleY: number | null,
  rotation: number,
  maskThreshold: number,
  opacity: number,
): Promise<void> {
  const state = ref.current;
  if (!state || !state.bgMesh || !state.depthSample || !state.depthTexture) return;
  const designLoaded = await loadTexture(designDataURL);
  // decal 着色器把 design.rgb 直接透传给 gl_FragColor —— 不做 linear 空间光照, 且作为
  // 自定义 ShaderMaterial 不带输出端 colorspace 编码。把贴图标成 NoColorSpace, 让 GPU
  // 采样时跳过 sRGB→linear 解码 (默认 SRGBColorSpace 会以 SRGB8_ALPHA8 上传、每次取样硬件
  // 解码)。解码而不回编码正是图案偏暗 + 色相偏移的根因; NoColorSpace 下源字节原样抵达
  // framebuffer → 与素材像素级一致。对齐 rebuildBackground 里的 depth/mask 数据贴图。
  designLoaded.texture.colorSpace = THREE.NoColorSpace;
  if (!ref.current || !ref.current.mounted) {
    designLoaded.texture.dispose();
    return;
  }

  // Drop any previous decal first
  if (state.decalMesh) {
    state.scene.remove(state.decalMesh);
    state.decalMesh.geometry.dispose();
    (state.decalMesh.material as THREE.Material).dispose();
  }
  if (state.designTexture) state.designTexture.dispose();
  state.designTexture = designLoaded.texture;

  // Anchor → world position on the bg plane (before displacement)
  const aspect = state.baseAspect;
  const W = 2 * aspect;
  const H = 2;
  // PlaneGeometry has its top-left at (-W/2, +H/2). UV (0, 0) by Three.js
  // convention is the bottom-left. But we treat (anchor[0]=0, anchor[1]=0)
  // as the IMAGE top-left to match user mental model, so flip v.
  const ax = -W / 2 + anchor[0] * W;
  const ay = H / 2 - anchor[1] * H;

  // Estimate surface normal at anchor by depth-gradient (forward differences)
  const eps = 1 / state.depthSample.width;
  const dzdx =
    (sampleDepth(state.depthSample, Math.min(1, anchor[0] + eps), anchor[1])
      - sampleDepth(state.depthSample, Math.max(0, anchor[0] - eps), anchor[1])) / 2;
  const dzdy =
    (sampleDepth(state.depthSample, anchor[0], Math.min(1, anchor[1] + eps))
      - sampleDepth(state.depthSample, anchor[0], Math.max(0, anchor[1] - eps))) / 2;
  // Normal in mesh local space (z up). Negate dzdy because v-axis flip.
  const normal = new THREE.Vector3(-dzdx, dzdy, 1).normalize();

  // Final anchor position: match the actual displaced surface at this UV.
  // The bg mesh uses depth × mask for its z (foreground curves outward,
  // background stays flat at z=0). Mirror that here so the decal anchor
  // sits on the real surface — without this, anchoring on the background
  // would lift the projection box up by raw depth and miss the flat bg.
  const depthAtAnchor = sampleDepth(state.depthSample, anchor[0], anchor[1]);
  const maskAtAnchor = state.maskSample
    ? sampleDepth(state.maskSample, anchor[0], anchor[1])
    : 1;
  const anchorPos = new THREE.Vector3(
    ax,
    ay,
    depthAtAnchor * maskAtAnchor * state.bgStrength * DEPTH_DISPLACEMENT_MAX + 0.001,
  );

  // Orientation: align decal local +Z to surface normal, with optional rotation
  // about that normal.
  const orientation = new THREE.Euler();
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(0, 0, 0),
    normal.clone().multiplyScalar(-1),
    new THREE.Vector3(0, 1, 0),
  );
  orientation.setFromRotationMatrix(m);
  orientation.z += rotation;

  // Decal size — width = scale × baseWorldWidth.
  // Height: when scaleY is null, derive from design aspect (preserves natural
  // proportions). When scaleY is set, multiply by base width too so the
  // height slider reads in the same units as Width.
  const designAspect = designLoaded.width / designLoaded.height;
  const decalW = scale * W;
  const decalH = scaleY !== null ? scaleY * W : decalW / designAspect;
  // Depth of projection box — must be deep enough to capture the whole curved
  // region. 1.0 is safe for typical relief.
  const size = new THREE.Vector3(decalW, decalH, 1.0);

  const decalGeom = new DecalGeometry(state.bgMesh, anchorPos, orientation, size);
  // Custom shader:
  //   - vUv: decal UV (DecalGeometry's standard) → samples uDesign
  //   - vBaseUv: base UV from world position → samples uMask + uDepth for the
  //     layer gate and N·V silhouette fade
  //   - design.rgb passes through untouched (no luminance shading) so brand
  //     colors stay exact regardless of base hue
  const useSegmentationMask = state.maskTexture !== null;
  // Layer detection: sample mask at the anchor to decide which layer the
  // user is anchoring onto. >0.5 = foreground (subject); <=0.5 = background.
  // Without a mask, fall back to depth (depth-anything also outputs higher
  // values for closer = subject).
  const layerSample = state.maskSample ?? state.depthSample;
  const anchorMaskVal = layerSample
    ? sampleDepth(layerSample, anchor[0], anchor[1])
    : 1; // no data → assume foreground
  const onForeground = anchorMaskVal > 0.5;
  // Texel size of the depth map — the shader needs this to walk neighbour
  // pixels for gradient/normal estimation. Cannot use GLSL textureSize()
  // because Three's default ShaderMaterial uses GLSL ES 1.00.
  const depthTexelSize = state.depthSample
    ? new THREE.Vector2(1 / state.depthSample.width, 1 / state.depthSample.height)
    : new THREE.Vector2(1 / 256, 1 / 256);
  const decalMat = new THREE.ShaderMaterial({
    uniforms: {
      uDesign: { value: designLoaded.texture },
      uMask: { value: state.maskTexture ?? state.depthTexture },
      uDepth: { value: state.depthTexture },
      uBaseSize: { value: new THREE.Vector2(W, H) },
      uMaskThreshold: { value: maskThreshold },
      uOnForeground: { value: onForeground ? 1 : 0 },
      uStrength: { value: state.bgStrength },
      uTexelSize: { value: depthTexelSize },
      uOpacity: { value: opacity },
    },
    defines: {
      USE_SEG_MASK: useSegmentationMask ? 1 : 0,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec2 vBaseUv;
      uniform vec2 uBaseSize;
      void main() {
        vUv = uv;
        // Mesh sits at origin so position.xy is already world-space xy.
        // Map [-W/2..W/2] → [0..1] for x and [-H/2..H/2] → [0..1] for y.
        // No vertical flip: the base/mask textures are uploaded with
        // Three's default flipY=true, so UV (0, 1) already points to the
        // top of the original image. The world y=+H/2 vertex gets vBaseUv.y=1
        // which samples the top — aligned with how the bg mesh paints itself.
        vBaseUv = vec2(
          (position.x + uBaseSize.x * 0.5) / uBaseSize.x,
          (position.y + uBaseSize.y * 0.5) / uBaseSize.y
        );
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vBaseUv;
      uniform sampler2D uDesign;
      uniform sampler2D uMask;
      uniform sampler2D uDepth;
      uniform vec2 uBaseSize;
      uniform vec2 uTexelSize;
      uniform float uMaskThreshold;
      uniform float uStrength;
      uniform float uOpacity;
      uniform int uOnForeground;

      // Same constant as JS-side DEPTH_DISPLACEMENT_MAX. Hard-coded so we
      // don't need yet another uniform for what is effectively a tuning
      // parameter for the whole effect.
      const float DEPTH_MAX = 0.6;

      // Reconstruct mesh world-z at a UV — must match the JS-side
      // displacement formula in rebuildBackground.
      float surfaceZ(vec2 uv) {
        float d = texture2D(uDepth, uv).r;
        float m = texture2D(uMask, uv).r;
        return d * m * uStrength * DEPTH_MAX;
      }

      void main() {
        if (vBaseUv.x < 0.0 || vBaseUv.x > 1.0 || vBaseUv.y < 0.0 || vBaseUv.y > 1.0) discard;

        // Layer-aware gate. uOnForeground=1: anchor was on the subject,
        // discard background pixels. uOnForeground=0: anchor was on the
        // background, discard foreground pixels (invert the mask sample).
        float rawMask = texture2D(uMask, vBaseUv).r;
        float maskVal = uOnForeground == 1 ? rawMask : (1.0 - rawMask);
        // Screen-space adaptive antialiasing: fwidth() = how fast maskVal
        // changes per screen pixel, so a smoothstep band of ±fwidth always
        // covers exactly ~2 pixels of transition no matter the zoom level.
        // Beats a fixed band, which is too wide far away (bleeds) and too
        // narrow up close (jaggies).
        float maskAW = fwidth(maskVal);
        #if USE_SEG_MASK
          float maskAlpha = smoothstep(uMaskThreshold - maskAW, uMaskThreshold + maskAW, maskVal);
        #else
          // Depth fallback edge is fuzzy already — wider fixed band.
          float maskAlpha = smoothstep(uMaskThreshold, uMaskThreshold + 0.10, maskVal);
        #endif
        if (maskAlpha <= 0.001) discard;

        // Silhouette fade — N·V dot product against view direction. With
        // the mask now properly gating depth (background flat, foreground
        // curved), the only sharp depth gradient is at the actual subject
        // silhouette. Sample over an 8-texel window to smooth out depth
        // noise on the subject's interior so we don't false-positive on
        // fabric folds.
        vec2 dx = vec2(uTexelSize.x * 8.0, 0.0);
        vec2 dy = vec2(0.0, uTexelSize.y * 8.0);
        float zL = surfaceZ(vBaseUv - dx);
        float zR = surfaceZ(vBaseUv + dx);
        float zD = surfaceZ(vBaseUv - dy);
        float zU = surfaceZ(vBaseUv + dy);
        float wdx = uBaseSize.x * uTexelSize.x * 8.0 * 2.0;
        float wdy = uBaseSize.y * uTexelSize.y * 8.0 * 2.0;
        float dzdx = (zR - zL) / max(wdx, 1e-5);
        float dzdy = (zU - zD) / max(wdy, 1e-5);
        vec3 normal = normalize(vec3(-dzdx, -dzdy, 1.0));
        float NdotV = max(0.0, normal.z);
        // Permissive fade — only the true silhouette (NdotV near 0) loses
        // opacity. Subject interiors with mild relief stay full opacity.
        float silhouetteFade = smoothstep(0.0, 0.20, NdotV);
        maskAlpha *= silhouetteFade;
        if (maskAlpha <= 0.001) discard;

        vec4 design = texture2D(uDesign, vUv);
        if (design.a < 0.01) discard;

        // Pass design colors through untouched — preserves the source image's
        // exact RGB and brightness. The 3D wrap feel comes from the depth-
        // displaced mesh + N·V silhouette fade, not from color modulation,
        // so a white logo stays white and dark shadows on the base never
        // dim the design's brightness.
        gl_FragColor = vec4(design.rgb, design.a * maskAlpha * uOpacity);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    side: THREE.DoubleSide,
    // fwidth() needs the OES_standard_derivatives extension on WebGL1; three.js
    // dropped the `extensions.derivatives` flag once WebGL2 became default (fwidth
    // is core there). Modern browsers are all WebGL2 — no opt-in needed.
  });
  const decal = new THREE.Mesh(decalGeom, decalMat);
  state.decalMesh = decal;
  state.scene.add(decal);
  renderScene(state);
}
