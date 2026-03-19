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
// 0° is the current source view; non-zero steps are camera orbit offsets.
const AZIMUTH_NAMES: Record<number, string> = {
  0:   'current view',
  45:  'orbit +45°',
  90:  'orbit +90°',
  135: 'orbit +135°',
  180: 'orbit 180°',
  225: 'orbit -135°',
  270: 'orbit -90°',
  315: 'orbit -45°',
}

// Azimuth convention: 0° = current source view; increasing angle = camera
// orbits clockwise around the selected scene when viewed from above.
const AZIMUTH_DESCRIPTIONS: Record<number, string> = {
  0:   'Match the current source view as the baseline orientation.',
  45:  'Orbit the camera 45 degrees clockwise around the selected scene from the source viewpoint.',
  90:  'Orbit the camera 90 degrees clockwise around the selected scene from the source viewpoint for a strong side-on shift.',
  135: 'Orbit the camera 135 degrees clockwise around the selected scene from the source viewpoint, approaching the far side of the scene.',
  180: 'Orbit the camera to the opposite side of the selected scene from the source viewpoint.',
  225: 'Orbit the camera 135 degrees counter-clockwise around the selected scene from the source viewpoint, approaching the far side from the other direction.',
  270: 'Orbit the camera 90 degrees counter-clockwise around the selected scene from the source viewpoint for a strong side-on shift.',
  315: 'Orbit the camera 45 degrees counter-clockwise around the selected scene from the source viewpoint.',
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
    `Re-render the selected scene from a new camera position. Interpret 0 degrees azimuth as the current source view. Target camera: ${azName}, ${elName}, ${distName}.`,
    `Camera move: ${azDesc}; ${elDesc}; ${distDesc}.`,
    'Keep the selected scene fixed in world space while the camera moves around it. Preserve the identity, count, materials, colours, and relative layout of all visible people, objects, text, logos, and graphic elements.',
    'Adjust perspective, foreshortening, parallax, occlusion, cropping, and framing naturally for the new viewpoint and camera distance. Shadows and reflections may shift to match the new camera position.',
    'If a wider framing reveals more of the same environment, extend only that existing environment consistently. Do not introduce unrelated objects, redesign the scene, or replace the background with a different place.',
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
