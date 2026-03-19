/**
 * Camera-angle → prompt for general-purpose image-edit models (Gemini, GPT-Image, etc.).
 *
 * Strategy: snap continuous camera values to discrete positions, then emit
 * concise, scene-level camera-move instructions that instruction-tuned
 * models reliably follow — no LoRA trigger tokens needed.
 *
 * Three axes:
 *   azimuth   0–360°        (8 positions, 45° apart)
 *   elevation −30° to 60°   (4 positions)
 *   distance  0.6 – 1.4     (3 positions)
 */

// ── Azimuth: 8 positions ─────────────────────────────────────────────────────

const AZIMUTH_STEPS = [0, 45, 90, 135, 180, 225, 270, 315] as const

// Short label used in the prompt headline and UI.
// 0° is the current source view; non-zero steps are relative viewpoints.
const AZIMUTH_NAMES: Record<number, string> = {
  0:   'front view',
  45:  'front-right three-quarter view',
  90:  'right-side view',
  135: 'back-right three-quarter view',
  180: 'back view',
  225: 'back-left three-quarter view',
  270: 'left-side view',
  315: 'front-left three-quarter view',
}

// Azimuth convention: 0° = current source view. Prompt text should describe
// the target side naturally relative to the source image, not with angles.
const AZIMUTH_DESCRIPTIONS: Record<number, string> = {
  0:   'Match the source image as the baseline front view.',
  45:  'Move the camera to the front-right three-quarter view of the selected scene relative to the source image.',
  90:  'Move the camera to the exact right side of the selected scene relative to the source image.',
  135: 'Move the camera to the back-right three-quarter view of the selected scene relative to the source image.',
  180: 'Move the camera to the exact back side of the selected scene relative to the source image.',
  225: 'Move the camera to the back-left three-quarter view of the selected scene relative to the source image.',
  270: 'Move the camera to the exact left side of the selected scene relative to the source image.',
  315: 'Move the camera to the front-left three-quarter view of the selected scene relative to the source image.',
}

// ── Elevation: 4 positions ───────────────────────────────────────────────────

const ELEVATION_STEPS = [-30, 0, 30, 60] as const

const ELEVATION_NAMES: Record<number, string> = {
  '-30': 'low-angle shot',
  0:    'eye-level shot',
  30:   'elevated shot',
  60:   'high-angle / bird\'s-eye shot',
}

const ELEVATION_DESCRIPTIONS: Record<number, string> = {
  '-30': 'camera below the selected scene, tilted upward',
  0:    'camera at a neutral horizontal height relative to the selected scene',
  30:   'camera above the selected scene, tilted slightly downward',
  60:   'camera high above the selected scene, looking steeply down',
}

// ── Distance: 3 positions ────────────────────────────────────────────────────

const DISTANCE_STEPS = [0.6, 1.0, 1.4] as const

const DISTANCE_NAMES: Record<string, string> = {
  '0.6': 'close-up',
  '1':   'medium shot',
  '1.4': 'wide shot',
}

const DISTANCE_DESCRIPTIONS: Record<string, string> = {
  '0.6': 'move the camera closer for a tighter framing while keeping the same scene identity',
  '1':   'keep a neutral medium framing',
  '1.4': 'move the camera farther back for a wider framing; if more of the same environment becomes visible, extend only that environment consistently',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapToNearest(value: number, steps: readonly number[]): number {
  return steps.reduce((best, s) =>
    Math.abs(s - value) < Math.abs(best - value) ? s : best
  , steps[0])
}

function snapToNearestCircular(value: number, steps: readonly number[], period: number): number {
  return steps.reduce((best, s) => {
    const d = Math.min(Math.abs(s - value), period - Math.abs(s - value))
    const bestD = Math.min(Math.abs(best - value), period - Math.abs(best - value))
    return d < bestD ? s : best
  }, steps[0])
}

/** Normalise azimuth to [0, 360). */
export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CameraAngles {
  azimuth:   number   // 0–360°
  elevation: number   // −30° to 60°
  distance:  number   // 0.6 to 1.4
}

/** Snap continuous camera values to the nearest discrete step. */
export function snapAngles(angles: CameraAngles): CameraAngles {
  return {
    azimuth:   snapToNearestCircular(normalizeAzimuth(angles.azimuth), AZIMUTH_STEPS, 360),
    elevation: snapToNearest(angles.elevation, ELEVATION_STEPS),
    distance:  snapToNearest(angles.distance,  DISTANCE_STEPS),
  }
}

/**
 * Build the instruction prompt sent to the image-edit model.
 *
 * Designed for general-purpose instruction-tuned image-edit models (Gemini,
 * GPT-Image, etc.) — no LoRA trigger tokens.  The prompt has three layers:
 *   1. A short headline specifying the target camera position.
 *   2. A precise description of how the camera should move relative to the
 *      current source view.
 *   3. Hard constraints that prevent content/identity drift.
 */
export function buildAnglePrompt(angles: CameraAngles, userPrompt?: string): string {
  const s = snapAngles(angles)

  const azName   = AZIMUTH_NAMES[s.azimuth]        ?? 'current view'
  const elName   = ELEVATION_NAMES[s.elevation]     ?? 'eye-level shot'
  const distName = DISTANCE_NAMES[String(s.distance)] ?? 'medium shot'

  const azDesc   = AZIMUTH_DESCRIPTIONS[s.azimuth]        ?? 'match the current source view as the baseline orientation'
  const elDesc   = ELEVATION_DESCRIPTIONS[s.elevation]     ?? 'camera at a neutral horizontal height relative to the selected scene'
  const distDesc = DISTANCE_DESCRIPTIONS[String(s.distance)] ?? 'standard medium framing'

  const lines = [
    `Re-render the selected scene from a new camera position. Treat the source image as the front-view reference. Target camera: ${azName}, ${elName}, ${distName}.`,
    `Camera move: ${azDesc}; ${elDesc}; ${distDesc}.`,
    'This must read as the exact same frozen moment captured by the same shoot, with only the camera position and framing changed.',
    'Keep the entire scene fixed in world space while the camera moves around it. The only allowed changes are viewpoint, perspective, cropping, and framing caused by the new camera position and distance.',
    'Do not change any person or animal in any way: preserve exact pose, gesture, facial expression, gaze direction, head angle, body orientation, limb placement, hand placement, clothing, hair, and all interactions exactly as in the source image.',
    'Do not move, rotate, resize, restyle, add, remove, or replace any object, prop, product, furniture, accessory, text, logo, or background element. Preserve exact identity, count, materials, colours, proportions, and spatial layout.',
    'Keep the lighting setup and scene state unchanged. Only viewpoint-dependent perspective, foreshortening, parallax, occlusion, reflections, and visibility may change naturally with the new camera position.',
    'If a wider framing reveals more of the same environment, extend only that already-existing environment consistently. Do not introduce unrelated content, redesign the scene, or replace the background with a different place.',
    'IMPORTANT — do not mirror or horizontally flip any content. Text and logos must remain correctly readable. Left/right anatomical sides, object handedness, and layout relationships must stay consistent with the source image even though their position in the frame may change.',
  ]

  const extra = userPrompt?.trim()
  if (extra) {
    lines.push(`Additional instruction (must stay consistent with the selected-scene camera move): ${extra}`)
  }

  return lines.join(' ')
}

export function anglesToDisplayLabel(angles: CameraAngles): string {
  const s = snapAngles(angles)
  const az   = AZIMUTH_NAMES[s.azimuth]          ?? 'current view'
  const el   = (ELEVATION_NAMES[s.elevation]       ?? 'eye-level shot').replace(' shot', '')
  const dist = (DISTANCE_NAMES[String(s.distance)] ?? 'medium shot').replace(' shot', '')
    return `${az} · ${el} · ${dist}`
}

export { AZIMUTH_STEPS, ELEVATION_STEPS, DISTANCE_STEPS }
