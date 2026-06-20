/**
 * Predict the pixel size an image generation / edit job will produce, so the
 * pre-generation placeholder can reserve a box the size of the RESULT, not the
 * source. The result is standardized to the chosen resolution tier — a 1000²
 * source edited at 2K comes back ~2048², not 1000² — and the agent's
 * generate_image (text-to-image) likewise produces a tier-sized image.
 *
 * `resolution` is a quality tier (2K → 1:1 2048², 4K → 1:1 4096², ≈4× the area;
 * case-insensitive). `size` is an aspect ("1:1", "16:9"), a pixel string
 * ("1024x1024"), "auto", undefined, or anything unparseable — the last three
 * fall back to the `source` aspect (pass a 1:1 source when there is no source,
 * e.g. agent text-to-image). We keep the tier's pixel-area budget and split it to
 * the aspect.
 *
 * APPROXIMATION for a transient loading box (the provider's exact non-square
 * rounding may differ); the real result later replaces the box at its true
 * native size, so only the reserved box is affected. Exact for 1:1.
 *
 * Takes plain strings (not the ImageEditSize/Resolution unions) so it serves both
 * the toolbar edit path and the agent tool-call path, and stays free of any
 * hook / service / React runtime import.
 */
export function imageEditOutputSize(
  size: string | undefined,
  resolution: string | undefined,
  source: { width: number; height: number },
): { width: number; height: number } {
  const edge = (resolution ?? "").toUpperCase() === "4K" ? 4096 : 2048; // tier edge
  const budget = edge * edge; // pixel-area budget, kept constant across aspects

  const aspect = parseAspect(size);
  let aw = aspect ? aspect.w : source.width;
  let ah = aspect ? aspect.h : source.height;
  // Degenerate (0 / negative / NaN / Infinity) → fall back to square.
  if (!Number.isFinite(aw) || aw <= 0 || !Number.isFinite(ah) || ah <= 0) {
    aw = 1;
    ah = 1;
  }

  // Clamp the aspect so a hallucinated / absurd agent size (e.g. "1000:1" or
  // "1e308:1") can't produce an Infinity / 0 / giant box — Infinity geometry
  // would corrupt the placeholder element (and the scene on save). The bound
  // covers every real aspect (≤ 21:9 ≈ 2.33), and the box is transient anyway.
  const ratio = Math.min(16, Math.max(1 / 16, aw / ah));
  return {
    width: Math.round(Math.sqrt(budget * ratio)),
    height: Math.round(Math.sqrt(budget / ratio)),
  };
}

/** Parse an aspect ("W:H") or pixel ("WxH", case-insensitive) size string into a
 *  width/height ratio. Returns null for "auto" / undefined / unparseable (the
 *  caller then uses the source aspect). Accepts the same W:H / WxH forms as the
 *  backend's `_canvas_size_to_ratio`, but yields a numeric ratio (not a reduced
 *  string) and also handles "auto"/undefined. */
function parseAspect(size: string | undefined): { w: number; h: number } | null {
  if (!size || size === "auto") return null;
  const lower = size.toLowerCase();
  const sep = lower.includes(":") ? ":" : lower.includes("x") ? "x" : null;
  if (!sep) return null;
  const parts = lower.split(sep);
  if (parts.length !== 2) return null; // malformed (e.g. "1x2x3") → source fallback
  const [w, h] = parts.map(Number);
  return w > 0 && h > 0 ? { w, h } : null;
}
