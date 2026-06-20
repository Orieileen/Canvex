/**
 * Camera-angle discrete steps + display helpers — shared by AngleCube UI and
 * the POST payload builder.
 *
 * 三轴档位 (对齐 fal.ai Qwen-Image-Edit-2511-Multiple-Angles-LoRA 主推角度):
 *   azimuth   0–360°        8 档, 每 45° 一步
 *   elevation −30° to 60°   4 档
 *   distance  0.6 – 1.4     3 档
 *
 * LoRA 内置 camera-move prompt, 调用方只传角度数值即可, 不需要 prompt
 * engineering 层 —— 所以本文件只负责 snap + display label + fal 坐标映射.
 */

export interface CameraAngles {
  azimuth: number;   // 0–360°
  elevation: number; // −30° to 60°
  distance: number;  // 0.6 to 1.4
}

export const AZIMUTH_STEPS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export const ELEVATION_STEPS = [-30, 0, 30, 60] as const;
export const DISTANCE_STEPS = [0.6, 1.0, 1.4] as const;

const AZIMUTH_NAMES: Record<number, string> = {
  0:   "front",
  45:  "front-right ¾",
  90:  "right-side",
  135: "back-right ¾",
  180: "back",
  225: "back-left ¾",
  270: "left-side",
  315: "front-left ¾",
};

const ELEVATION_NAMES: Record<number, string> = {
  "-30": "low-angle",
  0:     "eye-level",
  30:    "elevated",
  60:    "bird's-eye",
};

const DISTANCE_NAMES: Record<string, string> = {
  "0.6": "close-up",
  "1":   "medium",
  "1.4": "wide",
};

export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function snapToNearest(value: number, steps: readonly number[]): number {
  return steps.reduce(
    (best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best),
    steps[0],
  );
}

/** Circular snap — azimuth 0° and 360° are the same position, so pick the
 *  step closest when wrapping around the seam. */
function snapToNearestCircular(
  value: number,
  steps: readonly number[],
  period: number,
): number {
  return steps.reduce((best, s) => {
    const d = Math.min(Math.abs(s - value), period - Math.abs(s - value));
    const bestD = Math.min(Math.abs(best - value), period - Math.abs(best - value));
    return d < bestD ? s : best;
  }, steps[0]);
}

export function snapAngles(angles: CameraAngles): CameraAngles {
  return {
    azimuth: snapToNearestCircular(
      normalizeAzimuth(angles.azimuth),
      AZIMUTH_STEPS,
      360,
    ),
    elevation: snapToNearest(angles.elevation, ELEVATION_STEPS),
    distance: snapToNearest(angles.distance, DISTANCE_STEPS),
  };
}

/** Short human-readable preview of the current camera pose for the HUD. */
export function anglesToDisplayLabel(angles: CameraAngles): string {
  const s = snapAngles(angles);
  const az = AZIMUTH_NAMES[s.azimuth] ?? "front";
  const el = ELEVATION_NAMES[s.elevation] ?? "eye-level";
  const dist = DISTANCE_NAMES[String(s.distance)] ?? "medium";
  return `${az} · ${el} · ${dist}`;
}

/** Cube initial pose. Matches Canvex: front view, eye-level, medium shot —
 *  i.e. "render the source image as-is" so the user sees no immediate change
 *  if they hit Generate without dragging. */
export const DEFAULT_CAMERA_ANGLES: CameraAngles = {
  azimuth: 0,
  elevation: 0,
  distance: 1.0,
};

/**
 * Map the UI's (azimuth, elevation, distance) → the fal.ai LoRA's
 * (horizontal_angle, vertical_angle, zoom).
 *
 * azimuth / elevation pass through (same units). distance is inverted:
 *   distance 0.6 (close-up) → zoom 10
 *   distance 1.0 (medium)   → zoom 5
 *   distance 1.4 (wide)     → zoom 0
 *
 * Uses the snapped pose so the payload always hits one of the 8×4×3 = 96
 * discrete LoRA training points rather than an interpolated value.
 */
export function anglesToFalPayload(angles: CameraAngles): {
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
} {
  const s = snapAngles(angles);
  return {
    horizontal_angle: s.azimuth,
    vertical_angle: s.elevation,
    // 1.4 - 0.6 = 0.8 range, 0-10 output, linear inverse
    zoom: Math.round(((1.4 - s.distance) / 0.8) * 10),
  };
}
