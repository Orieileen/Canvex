/**
 * 调色 (color adjustment) — shared types, defaults, slider groups, and the GLSL
 * shader used by `ImageAdjustOverlay` (live preview) and its native-res capture.
 * Pure module: no React / Three imports.
 *
 * Scope (本轮核心两组): 光线 Light (7) + 颜色 Color (4). The effects group
 * (锐化/清晰度/颗粒/晕影/柔光/辉光) is deferred — adding it later = append one
 * `AdjustGroupSpec` + its fields/uniforms/shader lines; the panel UI is data-driven.
 */

export interface ImageAdjustments {
  // 光线 Light
  light: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  // 颜色 Color
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  // 细节 Detail
  sharpen: number;
  clarity: number;
  grain: number;
  // 效果 Effects
  vignette: number;
  soft: number;
  glow: number;
}

export type AdjustKey = keyof ImageAdjustments;

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  light: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  clarity: 0,
  grain: 0,
  vignette: 0,
  soft: 0,
  glow: 0,
};

/** Every slider shares one symmetric range, centered at 0 (neutral). */
export const ADJUST_MIN = -100;
export const ADJUST_MAX = 100;

export interface AdjustSliderSpec {
  key: AdjustKey;
  /** Lower bound; defaults to ADJUST_MIN (-100, bidirectional/centered).
   *  Unidirectional effect sliders (sharpen/clarity/grain/soft/glow) set 0. */
  min?: number;
  /** Color sliders render a gradient track behind the thumb. */
  gradient?: "temperature" | "tint";
}

export interface AdjustGroupSpec {
  /** Matches the i18n key `edit.adjust.group_<id>` and the sub-tab value. */
  id: "light" | "color" | "detail" | "effects";
  sliders: AdjustSliderSpec[];
}

/** Data-driven groups — the panel loops this list, so adding the deferred
 *  效果 group later needs no JSX change beyond one entry here + the shader. */
export const ADJUST_GROUPS: AdjustGroupSpec[] = [
  {
    id: "light",
    sliders: [
      { key: "light" },
      { key: "exposure" },
      { key: "contrast" },
      { key: "highlights" },
      { key: "shadows" },
      { key: "whites" },
      { key: "blacks" },
    ],
  },
  {
    id: "color",
    sliders: [
      { key: "vibrance" },
      { key: "saturation" },
      { key: "temperature", gradient: "temperature" },
      { key: "tint", gradient: "tint" },
    ],
  },
  {
    id: "detail",
    sliders: [
      { key: "sharpen", min: 0 },
      { key: "clarity", min: 0 },
      { key: "grain", min: 0 },
    ],
  },
  {
    id: "effects",
    sliders: [
      { key: "vignette" },
      { key: "soft", min: 0 },
      { key: "glow", min: 0 },
    ],
  },
];

// ─── 颜色混合器 / per-color HSL (Photoshop Hue-Saturation style) ───────────────

export const COLOR_BANDS = [
  "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta",
] as const;
export type ColorBand = (typeof COLOR_BANDS)[number];

/** Per-band Hue / Saturation / Luminance shift, each -100..100 (0 = neutral). */
export interface BandHSL {
  h: number;
  s: number;
  l: number;
}
export type ColorMix = Record<ColorBand, BandHSL>;
export type BandChannel = keyof BandHSL; // "h" | "s" | "l"

export const DEFAULT_COLOR_MIX: ColorMix = {
  red: { h: 0, s: 0, l: 0 },
  orange: { h: 0, s: 0, l: 0 },
  yellow: { h: 0, s: 0, l: 0 },
  green: { h: 0, s: 0, l: 0 },
  aqua: { h: 0, s: 0, l: 0 },
  blue: { h: 0, s: 0, l: 0 },
  purple: { h: 0, s: 0, l: 0 },
  magenta: { h: 0, s: 0, l: 0 },
};

/** Band center hue (normalized [0,1]) for the shader's hue-distance weighting,
 *  plus a CSS swatch color for the picker UI. Order matches COLOR_BANDS. */
export const COLOR_BAND_META: Record<ColorBand, { center: number; swatch: string }> = {
  red: { center: 0 / 360, swatch: "#e23b3b" },
  orange: { center: 30 / 360, swatch: "#e0832b" },
  yellow: { center: 60 / 360, swatch: "#e3c93b" },
  green: { center: 120 / 360, swatch: "#46c14e" },
  aqua: { center: 180 / 360, swatch: "#2bc4c4" },
  blue: { center: 240 / 360, swatch: "#3b7de0" },
  purple: { center: 280 / 360, swatch: "#8b5cf6" },
  magenta: { center: 320 / 360, swatch: "#e23b9b" },
};

/** True when any band differs from neutral — gates the (round-trip-lossy) HSL
 *  pass so the all-zero passthrough identity is preserved. */
export function isColorMixActive(mix: ColorMix): boolean {
  return COLOR_BANDS.some((b) => mix[b].h !== 0 || mix[b].s !== 0 || mix[b].l !== 0);
}

export const ADJUST_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * GLSL ES 1.00 fragment shader (precision highp, no #version — Three injects).
 * The source texture is tagged NoColorSpace so `texture2D` returns the raw sRGB
 * bytes, and a custom ShaderMaterial gets no `colorspace_fragment` output encode
 * → bytes pass straight through (same lesson as the mockup decal fix). Tone math
 * runs in gamma space; exposure alone round-trips through linear locally.
 *
 * INVARIANT: with every uniform 0 each block is an exact identity → the output
 * is bit-identical to the source. The "original unchanged" smoke test relies on
 * it; flipping the texture to SRGBColorSpace or adding an output encode breaks it.
 *
 * Order: exposure → light → whites/blacks endpoints → shadows/highlights →
 * contrast → saturation → vibrance → temperature/tint → sharpen/clarity/grain
 * → soft/glow/vignette (Lightroom-style).
 */
export const ADJUST_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uImage;
  uniform float uLight, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
  uniform float uVibrance, uSaturation, uTemperature, uTint;
  uniform float uSharpen, uClarity, uGrain, uVignette, uSoft, uGlow;
  uniform float uBandHue[8];
  uniform float uMixHue[8];
  uniform float uMixSat[8];
  uniform float uMixLum[8];
  uniform float uColorMixActive;

  const vec3 LUMA = vec3(0.2125, 0.7154, 0.0721);
  float luma(vec3 c) { return dot(c, LUMA); }
  vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
  vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

  // Static hash noise for grain (rendered on demand, never animated).
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // ~17-tap two-ring blur of the SOURCE at a UV radius. UV-space (not texels)
  // so preview and native-res capture look proportionally identical.
  vec3 blurSrc(vec2 uv, float r) {
    vec3 sum = texture2D(uImage, uv).rgb * 2.0;
    float total = 2.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) / 8.0 * 6.2831853;
      vec2 d = vec2(cos(a), sin(a));
      sum += texture2D(uImage, uv + d * r).rgb;
      sum += texture2D(uImage, uv + d * r * 0.5).rgb;
      total += 2.0;
    }
    return sum / total;
  }

  vec3 rgb2hsl(vec3 c) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float l = (mx + mn) * 0.5;
    float h = 0.0;
    float s = 0.0;
    float d = mx - mn;
    if (d > 1e-5) {
      s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
      if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
      else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
      else h = (c.r - c.g) / d + 4.0;
      h /= 6.0;
    }
    return vec3(h, s, l);
  }
  float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0 / 2.0) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
  }
  vec3 hsl2rgb(vec3 hsl) {
    float h = hsl.x;
    float s = hsl.y;
    float l = hsl.z;
    if (s < 1e-5) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    return vec3(hue2rgb(p, q, h + 1.0 / 3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0 / 3.0));
  }

  void main() {
    vec4 src = texture2D(uImage, vUv);   // NoColorSpace -> sampled bytes == sRGB
    vec3 c = src.rgb;
    vec3 raw = src.rgb;                   // original, for detail / effect terms

    // Exposure — photometric gain in linear light, re-encoded.
    if (uExposure != 0.0) c = toSrgb(toLin(c) * exp2(uExposure));

    // Light — gentle overall additive lift.
    c += uLight * 0.15;

    // Whites / Blacks — endpoint stretch (whites+ brighter, blacks+ lifted).
    float wp = 1.0 - uWhites * 0.30;
    float bp = -uBlacks * 0.30;
    c = (c - bp) / max(wp - bp, 1e-3);

    // Shadows / Highlights — smooth luma-masked lift / recover.
    float L = luma(c);
    c += uShadows * 0.50 * (1.0 - smoothstep(0.0, 0.5, L));
    c -= uHighlights * 0.50 * smoothstep(0.5, 1.0, L);

    // Contrast about the 0.5 pivot.
    c = (c - 0.5) * (1.0 + 0.75 * uContrast) + 0.5;

    // Saturation — mix toward luma.
    c = mix(vec3(luma(c)), c, 1.0 + uSaturation);

    // Vibrance — weighted by inverse of current chroma (protects saturated px).
    float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(luma(c)), c, 1.0 + uVibrance * (1.0 - chroma));

    // Temperature (blue<->yellow) + Tint (magenta<->green) white-balance shifts.
    c.r += uTemperature * 0.12;
    c.b -= uTemperature * 0.12;
    c.g += uTint * 0.12;
    c.r -= uTint * 0.06;
    c.b -= uTint * 0.06;

    // ----- 颜色混合器 / per-color HSL (skip when neutral -> passthrough preserved) -----
    if (uColorMixActive > 0.5) {
      vec3 hsl = rgb2hsl(c);
      float oh = hsl.x;
      float hueAdd = 0.0;
      float satMul = 1.0;
      float lumAdd = 0.0;
      for (int i = 0; i < 8; i++) {
        float dh = abs(oh - uBandHue[i]);
        dh = min(dh, 1.0 - dh);                  // wrap around the hue circle
        float w = 1.0 - smoothstep(0.0, 0.125, dh);
        hueAdd += uMixHue[i] * w * 0.08;         // up to ~+/-29 degrees
        satMul *= 1.0 + uMixSat[i] * w;
        lumAdd += uMixLum[i] * w * 0.25;
      }
      hsl.x = fract(hsl.x + hueAdd);
      hsl.y = clamp(hsl.y * satMul, 0.0, 1.0);
      hsl.z = clamp(hsl.z + lumAdd, 0.0, 1.0);
      c = hsl2rgb(hsl);
    }

    // ----- 细节 Detail -----
    // Sharpen — unsharp mask against a tight blur of the source.
    if (uSharpen > 0.0) c += (raw - blurSrc(vUv, 0.0016)) * uSharpen * 1.2;

    // Medium blur reused by clarity / soft / glow (computed once, only if needed).
    vec3 blurM = vec3(0.0);
    if (uClarity > 0.0 || uSoft > 0.0 || uGlow > 0.0) blurM = blurSrc(vUv, 0.012);

    // Clarity — local midtone contrast, weighted toward mid gray.
    if (uClarity > 0.0) {
      float midMask = max(1.0 - abs(luma(raw) - 0.5) * 2.0, 0.0);
      c += (raw - blurM) * uClarity * 1.5 * midMask;
    }
    // Grain — static luma-neutral noise.
    if (uGrain > 0.0) c += (hash(vUv * 1024.0) - 0.5) * uGrain * 0.12;

    // ----- 效果 Effects -----
    // Soft light — dreamy soft focus via screen blend with the medium blur.
    if (uSoft > 0.0) c = mix(c, 1.0 - (1.0 - c) * (1.0 - blurM), uSoft * 0.7);
    // Glow — bloom: add blurred highlights.
    if (uGlow > 0.0) c += blurM * smoothstep(0.55, 1.0, luma(blurM)) * uGlow * 0.9;
    // Vignette — darken (or brighten if negative) toward the edges.
    if (uVignette != 0.0) c *= 1.0 - uVignette * smoothstep(0.30, 0.80, distance(vUv, vec2(0.5))) * 0.7;

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
  }
`;
