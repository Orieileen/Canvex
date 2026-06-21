import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";

import { getElementBounds, type ElementBounds } from "@/lib/excalidraw-bounds";

/**
 * Turn a marquee selection's arrows/shapes + text labels into a *textual*
 * spatial editing prompt — the "plan B" annotation strategy.
 *
 * The image the model edits stays CLEAN (see `selectionToCleanSourceFile`):
 * annotation shapes are never rasterized into the source, so they can't bleed
 * into the output. Instead each shape is projected into the image's coordinate
 * space and described in words — an arrow as its tip point ("top-right
 * (x≈72%, y≈18%)"), a box/ellipse as the region it encloses ("top-right region
 * (x≈60–90%, y≈10–30%)") — paired with the nearest text label and folded into
 * the prompt as a numbered region edit.
 *
 * Pairing is greedy nearest (text-center → shape). Texts with no shape become
 * general instructions; shapes with no text get a generic note.
 *
 * Type-only import boundary (like `excalidraw-bounds`) — reads element fields,
 * never touches the `@excalidraw/excalidraw` runtime, so it's cheap and pure.
 *
 * NOTE: image rotation is ignored (normalized against the image's AABB) —
 * product images on the canvas are effectively never rotated, and a region
 * word + percentage is coarse enough that the small skew wouldn't matter.
 */

// Folded into i18n alongside the rest of ImageEditBar's hardcoded-English
// strings when the canvas string merge lands (see ImageEditBar's i18n note).
const REGION_HEADER =
  "Apply the following region-specific edits (coordinates are percentages from the image's top-left corner):";
const REGION_FOOTER =
  "Only modify the regions described above; keep everything else unchanged.";
const GENERIC_REGION_NOTE = "apply the requested change here";

interface Pt {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function rotate(p: Pt, c: Pt, angle: number): Pt {
  if (!angle) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function isLinear(el: ExcalidrawElement): el is ExcalidrawLinearElement {
  return el.type === "arrow" || el.type === "line";
}

/** World-space polyline vertices of a linear element, with element rotation
 *  applied (points are stored in the element's un-rotated local frame). */
function linearWorldPoints(el: ExcalidrawLinearElement): Pt[] {
  const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  return el.points.map(([px, py]) =>
    rotate({ x: el.x + px, y: el.y + py }, center, el.angle),
  );
}

/** The "pointing end" of an arrow in world space: the vertex carrying the
 *  arrowhead. Excalidraw arrows default to a head on the LAST point; if only
 *  the start has a head, use the first. Lines (no head) fall back to last. */
function arrowTip(el: ExcalidrawLinearElement): Pt | null {
  const pts = linearWorldPoints(el);
  if (pts.length === 0) return null;
  const useStart = !el.endArrowhead && !!el.startArrowhead;
  return useStart ? pts[0] : pts[pts.length - 1];
}

const COLS = ["left", "center", "right"] as const;
const ROWS = ["top", "center", "bottom"] as const;

/** 3×3 grid label for a normalized (nx, ny) in [0,1]². "center" for the middle
 *  cell, otherwise "{row}-{col}" (e.g. "top-right", "center-left"). */
function regionLabel(nx: number, ny: number): string {
  const col = nx < 1 / 3 ? 0 : nx < 2 / 3 ? 1 : 2;
  const row = ny < 1 / 3 ? 0 : ny < 2 / 3 ? 1 : 2;
  const v = ROWS[row];
  const h = COLS[col];
  if (v === "center" && h === "center") return "center";
  return `${v}-${h}`;
}

/** Locate an annotation shape inside the image as a normalized text description.
 *  Arrows/lines → a POINT at the arrowhead tip ("top-right (x≈72%, y≈18%)").
 *  Closed shapes (rect/ellipse/diamond/frame/freedraw) → the REGION they
 *  enclose, as a bounding span ("top-right region (x≈60–90%, y≈10–30%)") — a box
 *  drawn around an area conveys that whole area, not a single point. */
function describeShapeLocation(
  shape: ExcalidrawElement,
  imgB: ElementBounds,
  iw: number,
  ih: number,
): { region: string; coord: string } | null {
  const pct = (v: number) => Math.round(v * 100);
  const nx = (x: number) => clamp((x - imgB.left) / iw, 0, 1);
  const ny = (y: number) => clamp((y - imgB.top) / ih, 0, 1);

  if (isLinear(shape)) {
    const tip = arrowTip(shape);
    if (!tip) return null;
    const x = nx(tip.x);
    const y = ny(tip.y);
    return { region: regionLabel(x, y), coord: `x≈${pct(x)}%, y≈${pct(y)}%` };
  }

  const b = getElementBounds(shape);
  if (!b) return null;
  const x1 = nx(b.left);
  const y1 = ny(b.top);
  const x2 = nx(b.right);
  const y2 = ny(b.bottom);
  return {
    region: `${regionLabel((x1 + x2) / 2, (y1 + y2) / 2)} region`,
    coord: `x≈${pct(x1)}–${pct(x2)}%, y≈${pct(y1)}–${pct(y2)}%`,
  };
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from a text's center to an annotation shape. Arrows/lines → min
 *  distance to the polyline (text labels sit anywhere along the arrow, usually
 *  near its tail); other shapes → distance to the AABB (0 if inside). */
function textToShapeDistance(textCenter: Pt, shape: ExcalidrawElement): number {
  if (isLinear(shape)) {
    const pts = linearWorldPoints(shape);
    if (pts.length === 0) return Infinity;
    if (pts.length === 1) return Math.hypot(textCenter.x - pts[0].x, textCenter.y - pts[0].y);
    let min = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      min = Math.min(min, pointToSegment(textCenter, pts[i], pts[i + 1]));
    }
    return min;
  }
  const b = getElementBounds(shape);
  if (!b) return Infinity;
  const cx = clamp(textCenter.x, b.left, b.right);
  const cy = clamp(textCenter.y, b.top, b.bottom);
  return Math.hypot(textCenter.x - cx, textCenter.y - cy);
}

function elementCenter(el: ExcalidrawElement): Pt | null {
  const b = getElementBounds(el);
  return b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : null;
}

/** Greedily pair each shape with its nearest text (one-to-one, smallest
 *  distance wins first). Returns shapeIndex → textIndex. */
function pairShapesToTexts(
  shapes: readonly ExcalidrawElement[],
  texts: readonly ExcalidrawTextElement[],
): Map<number, number> {
  const centers = texts.map(elementCenter);
  const pairs: { s: number; t: number; d: number }[] = [];
  shapes.forEach((shape, si) => {
    centers.forEach((center, ti) => {
      if (!center) return;
      const d = textToShapeDistance(center, shape);
      if (Number.isFinite(d)) pairs.push({ s: si, t: ti, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const usedShapes = new Set<number>();
  const usedTexts = new Set<number>();
  const map = new Map<number, number>();
  for (const { s, t } of pairs) {
    if (usedShapes.has(s) || usedTexts.has(t)) continue;
    map.set(s, t);
    usedShapes.add(s);
    usedTexts.add(t);
  }
  return map;
}

export interface SpatialPromptInput {
  /** The image the edits target — coordinates are normalized against its AABB. */
  image: ExcalidrawImageElement;
  /** Non-text annotation shapes (arrows/lines/rects). Empty for single-image. */
  shapes: readonly ExcalidrawElement[];
  /** Text labels — the instruction content for each region. */
  texts: readonly ExcalidrawTextElement[];
}

/**
 * Build the image-edit prompt. `userText` is the toolbar input (prepended as a
 * general instruction). With no shapes it degrades to the legacy flat join
 * (`userText` + each text on its own line), so single-image behaviour is
 * unchanged.
 */
/** Image AABB + width/height for normalizing shape coordinates into the image.
 *  Null when the image has no valid bounds or is degenerate (0 / NaN size).
 *  Shared by buildSpatialPrompt and subjectRegionClause. */
function imageNormBox(
  image: ExcalidrawImageElement,
): { imgB: ElementBounds; iw: number; ih: number } | null {
  const imgB = getElementBounds(image);
  if (!imgB) return null;
  const iw = imgB.right - imgB.left;
  const ih = imgB.bottom - imgB.top;
  return iw > 0 && ih > 0 ? { imgB, iw, ih } : null;
}

export function buildSpatialPrompt(
  { image, shapes, texts }: SpatialPromptInput,
  userText = "",
): string {
  const head = userText.trim();
  const textContent = texts.map((t) => t.text.trim());
  const nb = imageNormBox(image);

  // No shapes, or no usable image bounds (missing / degenerate) → flat join (legacy).
  if (!nb || shapes.length === 0) {
    return [head, ...textContent].filter(Boolean).join("\n");
  }
  const { imgB, iw, ih } = nb;

  const assignment = pairShapesToTexts(shapes, texts);
  const consumedTexts = new Set<number>();
  const regionLines: string[] = [];

  shapes.forEach((shape, si) => {
    const loc = describeShapeLocation(shape, imgB, iw, ih);
    if (!loc) return; // un-locatable shape → its paired text falls back to general
    const ti = assignment.get(si);
    let instruction = "";
    if (ti != null && textContent[ti]) {
      instruction = textContent[ti];
      consumedTexts.add(ti);
    }
    regionLines.push(
      `${regionLines.length + 1}. ${loc.region} (${loc.coord}): ${instruction || GENERIC_REGION_NOTE}`,
    );
  });

  // Texts not consumed by a located region are general instructions.
  const generalTexts = textContent.filter((c, ti) => c && !consumedTexts.has(ti));
  const general = [head, ...generalTexts].filter(Boolean).join("\n");

  if (regionLines.length === 0) return general;

  const block = [REGION_HEADER, ...regionLines, REGION_FOOTER].join("\n");
  return [general, block].filter(Boolean).join("\n\n");
}

/**
 * Subject-region locator for cutout / Split — the SAME geometry as
 * buildSpatialPrompt's shapes, but framed as "which subject to act on" rather
 * than "edits to apply". Plan B keeps the source clean, so the drawn box (which
 * used to be baked into the pixels as the subject hint) is conveyed to the
 * cutout/inpaint prompts as text coordinates instead. Empty when nothing is
 * drawn → the backend prompts fall back to "the most prominent subject".
 */
export function subjectRegionClause(
  { image, shapes }: { image: ExcalidrawImageElement; shapes: readonly ExcalidrawElement[] },
): string {
  const nb = imageNormBox(image);
  if (!nb || shapes.length === 0) return "";
  const { imgB, iw, ih } = nb;
  const locs = shapes
    .map((s) => describeShapeLocation(s, imgB, iw, ih))
    .filter((l): l is { region: string; coord: string } => l !== null)
    .map((l) => `${l.region} (${l.coord})`);
  if (locs.length === 0) return "";
  return (
    "Target region (coordinates are percentages from the image's top-left corner): "
    + `the foreground subject to act on is within ${locs.join("; ")}.`
  );
}
