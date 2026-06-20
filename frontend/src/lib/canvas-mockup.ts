import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

/**
 * 3D Mockup binding stored on a base image element's `customData.mockup3d`.
 *
 * 把 design 像 decal 一样投影到 base 的 3D 高度场上 —— depth map 由
 * Depth-Anything (transformers.js) 推断,缓存为 scene 的另一个 file.
 *
 * - design 元素被吸收 (isDeleted=true), 文件保留 (canvas-scene-files.ts 修过)
 * - anchor: 用户拖 design 释放在 base 上时的 UV 位置 [0..1]²
 * - scale: decal 占 base 宽的比例 (0..1)
 * - rotation: 绕 Z 轴 (radians)
 * - strength: depth 高度场振幅,影响曲面凹凸感 (0..1)
 */

export interface Mockup3dBinding {
  designFileId: FileId;
  depthFileId: FileId;
  /** Cached foreground/background segmentation mask file. Optional for
   *  backward compat with bindings created before segmentation was added —
   *  the renderer falls back to using depth as a coarse mask in that case. */
  maskFileId?: FileId;
  anchor: readonly [number, number];
  /** Width as a fraction of the base's width (0..1). Historically called
   *  "scale" — kept for backward compat, but semantically the X axis. */
  scale: number;
  /** Optional independent Y-axis scale (height as fraction of base width).
   *  When undefined, the decal preserves the design's natural aspect ratio
   *  (height = scale / designAspect). When set, lets the user squash/stretch
   *  the decal independently. */
  scaleY?: number;
  rotation: number;
  strength: number;
  /** 0..1 — alpha cutoff applied to the (segmentation OR depth) mask.
   *  Higher = more aggressive background trimming. */
  maskThreshold?: number;
  /** 0..1 — overall design opacity. 1 = fully visible (default), 0 = invisible.
   *  Optional for backward compat with bindings created before this knob existed. */
  opacity?: number;
}

export const DEFAULT_MOCKUP_ANCHOR: Mockup3dBinding["anchor"] = [0.5, 0.5];
export const DEFAULT_MOCKUP_SCALE = 0.4;
export const DEFAULT_MOCKUP_ROTATION = 0;
export const DEFAULT_MOCKUP_STRENGTH = 0.5;
// 0.5 = RMBG soft-edge midpoint. Lower lets the antialiased silhouette
// bleed into the design (visible as the design "leaking" past the subject's
// edge onto the background). 0.5 gives a clean anti-aliased silhouette
// without spillover.
export const DEFAULT_MOCKUP_MASK_THRESHOLD = 0.5;
export const DEFAULT_MOCKUP_OPACITY = 1;

export const MOCKUP_CUSTOM_DATA_KEY = "mockup3d" as const;
export const MOCKUP_SOURCE_FOR_KEY = "mockupSourceFor" as const;

/** Defensive read — customData is `Record<string, unknown>` per Excalidraw,
 *  any persisted scene data could be malformed. Returns null on shape mismatch. */
export function getMockupBinding(el: ExcalidrawElement): Mockup3dBinding | null {
  const cd = el.customData;
  if (!cd || typeof cd !== "object") return null;
  const raw = (cd as Record<string, unknown>)[MOCKUP_CUSTOM_DATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<Mockup3dBinding>;
  if (typeof m.designFileId !== "string") return null;
  if (typeof m.depthFileId !== "string") return null;
  if (!Array.isArray(m.anchor) || m.anchor.length !== 2) return null;
  if (typeof m.anchor[0] !== "number" || typeof m.anchor[1] !== "number") return null;
  if (typeof m.scale !== "number") return null;
  if (typeof m.rotation !== "number") return null;
  if (typeof m.strength !== "number") return null;
  // Optional fields — keep older bindings valid.
  if (m.maskThreshold !== undefined && typeof m.maskThreshold !== "number") return null;
  if (m.maskFileId !== undefined && typeof m.maskFileId !== "string") return null;
  if (m.opacity !== undefined && typeof m.opacity !== "number") return null;
  return m as Mockup3dBinding;
}

/** Resolve opacity with default — single source of truth. */
export function resolveOpacity(b: Mockup3dBinding): number {
  return b.opacity ?? DEFAULT_MOCKUP_OPACITY;
}

/** Resolve the Y-axis scale, falling back to X (`scale`) when absent.
 *  Old bindings with no scaleY field treat it as a square gizmo / aspect
 *  preserved decal — see Mockup3dBinding.scaleY. */
export function resolveScaleY(b: Mockup3dBinding): number {
  return b.scaleY ?? b.scale;
}

/** Resolve the mask threshold with default — single source of truth so
 *  callers don't litter `?? DEFAULT_MOCKUP_MASK_THRESHOLD` everywhere. */
export function resolveMaskThreshold(b: Mockup3dBinding): number {
  return b.maskThreshold ?? DEFAULT_MOCKUP_MASK_THRESHOLD;
}

/** Build the customData patch for an element gaining/updating a mockup binding.
 *  Preserves any other customData keys already on the element. */
export function withMockupBinding(
  existingCustomData: ExcalidrawElement["customData"],
  binding: Mockup3dBinding,
): Record<string, unknown> {
  return {
    ...((existingCustomData as Record<string, unknown> | undefined) ?? {}),
    [MOCKUP_CUSTOM_DATA_KEY]: binding,
  };
}

/** Build the customData patch for clearing a binding (drop the mockup3d key,
 *  keep the rest). */
export function withoutMockupBinding(
  existingCustomData: ExcalidrawElement["customData"],
): Record<string, unknown> {
  const cd = (existingCustomData as Record<string, unknown> | undefined) ?? {};
  const { [MOCKUP_CUSTOM_DATA_KEY]: _drop, ...rest } = cd;
  void _drop;
  return rest;
}

/** Drop the source-marker key from a revived design's customData. */
export function withoutMockupSourceFor(
  existingCustomData: ExcalidrawElement["customData"],
): Record<string, unknown> {
  const cd = (existingCustomData as Record<string, unknown> | undefined) ?? {};
  const { [MOCKUP_SOURCE_FOR_KEY]: _drop, ...rest } = cd;
  void _drop;
  return rest;
}

/** Convert base-local UV [0..1]² to world-space (x, y).
 *  Note: ignores base.angle — most images aren't rotated. */
export function anchorToWorld(
  base: ExcalidrawImageElement,
  anchor: readonly [number, number],
): [number, number] {
  return [base.x + anchor[0] * base.width, base.y + anchor[1] * base.height];
}

/** Inverse: world point on base → UV. Used when user clicks on canvas to
 *  re-position the anchor. */
export function worldPointToBaseUv(
  base: ExcalidrawImageElement,
  worldX: number,
  worldY: number,
): [number, number] {
  if (base.width === 0 || base.height === 0) return [0.5, 0.5];
  return [
    Math.max(0, Math.min(1, (worldX - base.x) / base.width)),
    Math.max(0, Math.min(1, (worldY - base.y) / base.height)),
  ];
}
