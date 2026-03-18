/**
 * Camera-angle → prompt for general-purpose image-edit models (Gemini, GPT-Image, etc.).
 *
 * Strategy: snap continuous camera values to discrete positions, then emit
 * concise, photographic natural-language instructions that instruction-tuned
 * models reliably follow — no LoRA trigger tokens needed.
 *
 * Three axes:
 *   azimuth   0–360°        (8 positions, 45° apart)
 *   elevation −30° to 60°   (4 positions)
 *   distance  0.6 – 1.4     (3 positions)
 */

// ── Azimuth: 8 positions ─────────────────────────────────────────────────────

const AZIMUTH_STEPS = [0, 45, 90, 135, 180, 225, 270, 315] as const

// Short label used in the prompt headline and UI
const AZIMUTH_NAMES: Record<number, string> = {
  0:   'front view',
  45:  'front-right quarter view',
  90:  'right side view',
  135: 'back-right quarter view',
  180: 'back view',
  225: 'back-left quarter view',
  270: 'left side view',
  315: 'front-left quarter view',
}

// Longer description with TWO anchors per position:
//   (a) which body side faces the camera — determines what is visible
//   (b) which direction the subject's face/front points in the output frame —
//       determines image-space left/right so the model does not mirror.
//
// Azimuth convention: 0° = subject faces camera; increasing angle = camera
// moves clockwise when viewed from above (camera goes to subject's left,
// so subject's right side becomes visible, and face turns left in the frame).
const AZIMUTH_DESCRIPTIONS: Record<number, string> = {
  0:   'The subject faces the camera directly; their face points straight toward the viewer. ' +
       'Neither left nor right side has rotated away.',

  45:  'The subject has rotated so their right side angles toward the camera. ' +
       'Their face now points toward the left side of the frame (not toward the viewer). ' +
       'The subject\'s right shoulder/arm is closer to the camera; their left side recedes.',

  90:  'The subject is in pure right-side profile: their right shoulder faces the camera, ' +
       'their left shoulder is hidden behind them. ' +
       'The subject\'s face points to the left side of the frame.',

  135: 'The subject\'s back is mostly visible, with the right shoulder still slightly toward camera. ' +
       'The subject\'s face points away from the camera and toward the left-back of the frame. ' +
       'Only a sliver of the right cheek may be visible.',

  180: 'The subject\'s back faces the camera entirely; their face points directly away. ' +
       'The subject\'s right side is on the left of the frame; their left side is on the right of the frame.',

  225: 'The subject\'s back is mostly visible, with the left shoulder slightly toward camera. ' +
       'The subject\'s face points away from the camera and toward the right-back of the frame.',

  270: 'The subject is in pure left-side profile: their left shoulder faces the camera, ' +
       'their right shoulder is hidden behind them. ' +
       'The subject\'s face points to the right side of the frame.',

  315: 'The subject has rotated so their left side angles toward the camera. ' +
       'Their face now points toward the right side of the frame (not toward the viewer). ' +
       'The subject\'s left shoulder/arm is closer to the camera; their right side recedes.',
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
  '-30': 'camera below the subject, tilted upward',
  0:    'camera at the subject\'s eye level, horizontal',
  30:   'camera above the subject, tilted slightly downward',
  60:   'camera high above, looking steeply down',
}

// ── Distance: 3 positions ────────────────────────────────────────────────────

const DISTANCE_STEPS = [0.6, 1.0, 1.4] as const

const DISTANCE_NAMES: Record<string, string> = {
  '0.6': 'close-up',
  '1':   'medium shot',
  '1.4': 'wide shot',
}

const DISTANCE_DESCRIPTIONS: Record<string, string> = {
  '0.6': 'tightly framed close-up — subject fills most of the frame',
  '1':   'standard medium framing',
  '1.4': 'wide framing — more surrounding environment visible',
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
 *   2. A precise description of what the viewer should see.
 *   3. Hard constraints that prevent content/identity drift.
 */
export function buildAnglePrompt(angles: CameraAngles, userPrompt?: string): string {
  const s = snapAngles(angles)

  const azName   = AZIMUTH_NAMES[s.azimuth]        ?? 'front view'
  const elName   = ELEVATION_NAMES[s.elevation]     ?? 'eye-level shot'
  const distName = DISTANCE_NAMES[String(s.distance)] ?? 'medium shot'

  const azDesc   = AZIMUTH_DESCRIPTIONS[s.azimuth]        ?? 'the subject faces the viewer'
  const elDesc   = ELEVATION_DESCRIPTIONS[s.elevation]     ?? 'camera at eye level'
  const distDesc = DISTANCE_DESCRIPTIONS[String(s.distance)] ?? 'standard medium framing'

  const lines = [
    // Headline: target viewpoint
    `Re-render this scene from a new camera position — ${azName}, ${elName}, ${distName}.`,
    // Precise visual outcome
    `In the result: ${azDesc}; ${elDesc}; ${distDesc}.`,
    // Viewpoint-only constraint
    'This is a camera move only — do not change any objects, people, clothing, expressions, materials, or colours in the scene.',
    // Geometry / physics consistency
    'Adjust perspective, foreshortening, and occlusion naturally for the new angle. Shadows and reflections may shift to match the new viewpoint.',
    // Chirality / laterality guard — explicitly separates body-space from frame-space.
    'IMPORTANT — do not mirror or horizontally flip any content. ' +
    'The *position in the frame* of features will shift as the camera rotates — that is expected and correct. ' +
    'What must never change: which anatomical side a detail belongs to. ' +
    'If the source shows a watch on the subject\'s left wrist, it must stay on their left wrist (even if it now appears on the right side of the frame). ' +
    'Text must never become mirror-reversed. Logos, badges, and scars must stay on the same body side.',
  ]

  const extra = userPrompt?.trim()
  if (extra) {
    lines.push(`Additional instruction (must not override the camera-only rule): ${extra}`)
  }

  return lines.join(' ')
}

export function anglesToDisplayLabel(angles: CameraAngles): string {
  const s = snapAngles(angles)
  const az   = AZIMUTH_NAMES[s.azimuth]          ?? 'front view'
  const el   = (ELEVATION_NAMES[s.elevation]       ?? 'eye-level shot').replace(' shot', '')
  const dist = (DISTANCE_NAMES[String(s.distance)] ?? 'medium shot').replace(' shot', '')
    return `${az} · ${el} · ${dist}`
}

export { AZIMUTH_STEPS, ELEVATION_STEPS, DISTANCE_STEPS }
