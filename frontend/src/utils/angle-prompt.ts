/**
 * Angle-to-prompt mapping for image-edit models (e.g. gpt-image-1.5).
 *
 * Three axes: azimuth (0-360°), elevation (-30 to 60°), distance (0.6-1.4).
 * Each axis snaps to discrete steps and maps to natural-language descriptions
 * that general-purpose image-edit models can reliably interpret.
 */

// ── Azimuth: 8 positions at 45° increments ──────────────────────────────

const AZIMUTH_STEPS = [0, 45, 90, 135, 180, 225, 270, 315] as const

const AZIMUTH_NAMES: Record<number, string> = {
  0: 'front view',
  45: 'front-right quarter view',
  90: 'right side view',
  135: 'back-right quarter view',
  180: 'back view',
  225: 'back-left quarter view',
  270: 'left side view',
  315: 'front-left quarter view',
}

/**
 * Richer descriptions anchored on the subject's anatomical left / right.
 *
 * For image-edit models, "camera moves left/right" is easy to misread and
 * often causes mirrored outputs. Describing which side of the subject should
 * become visible is more stable.
 */
const AZIMUTH_DESCRIPTIONS: Record<number, string> = {
  0: 'seen directly from the front, facing the viewer',
  45: 'a front three-quarter view where more of the subject\'s right side is visible',
  90: 'a full right-side profile view, with the subject\'s right side facing the camera',
  135: 'seen mostly from behind, with more of the subject\'s right side visible',
  180: 'seen from directly behind, the subject\'s back faces the camera',
  225: 'seen mostly from behind, with more of the subject\'s left side visible',
  270: 'a full left-side profile view, with the subject\'s left side facing the camera',
  315: 'a front three-quarter view where more of the subject\'s left side is visible',
}

// ── Elevation: 4 positions ──────────────────────────────────────────────

const ELEVATION_STEPS = [-30, 0, 30, 60] as const

const ELEVATION_NAMES: Record<number, string> = {
  '-30': 'low-angle shot',
  0: 'eye-level shot',
  30: 'elevated shot',
  60: 'high-angle shot',
}

const ELEVATION_DESCRIPTIONS: Record<number, string> = {
  '-30': 'camera placed low, looking upward at the subject',
  0: 'camera at eye level, looking straight ahead',
  30: 'camera elevated above the subject, looking slightly downward',
  60: 'camera high above, looking steeply down at the subject',
}

// ── Distance: 3 positions ───────────────────────────────────────────────

const DISTANCE_STEPS = [0.6, 1.0, 1.4] as const

const DISTANCE_NAMES: Record<string, string> = {
  '0.6': 'close-up',
  '1': 'medium shot',
  '1.4': 'wide shot',
}

const DISTANCE_DESCRIPTIONS: Record<string, string> = {
  '0.6': 'framed tightly as a close-up',
  '1': 'framed at a standard medium distance',
  '1.4': 'framed wide to show more of the surroundings',
}

// ── Helpers ─────────────────────────────────────────────────────────────

function snapToNearest(value: number, steps: readonly number[]): number {
  let best = steps[0]
  let bestDist = Math.abs(value - best)
  for (let i = 1; i < steps.length; i++) {
    const d = Math.abs(value - steps[i])
    if (d < bestDist) {
      best = steps[i]
      bestDist = d
    }
  }
  return best
}

function snapToNearestCircular(value: number, steps: readonly number[], period: number): number {
  let best = steps[0]
  let bestDist = Math.min(Math.abs(value - best), period - Math.abs(value - best))
  for (let i = 1; i < steps.length; i++) {
    const directDist = Math.abs(value - steps[i])
    const d = Math.min(directDist, period - directDist)
    if (d < bestDist) {
      best = steps[i]
      bestDist = d
    }
  }
  return best
}

/** Normalise azimuth to [0, 360) range. */
export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ── Public API ──────────────────────────────────────────────────────────

export interface CameraAngles {
  azimuth: number   // 0-360
  elevation: number // -30 to 60
  distance: number  // 0.6 to 1.4
}

/**
 * Snap continuous camera values to the nearest discrete steps.
 */
export function snapAngles(angles: CameraAngles): CameraAngles {
  return {
    azimuth: snapToNearestCircular(normalizeAzimuth(angles.azimuth), AZIMUTH_STEPS as unknown as number[], 360),
    elevation: snapToNearest(angles.elevation, ELEVATION_STEPS as unknown as number[]),
    distance: snapToNearest(angles.distance, DISTANCE_STEPS as unknown as number[]),
  }
}

/**
 * Build a short camera label: "front view eye-level shot medium shot".
 */
export function buildCameraPromptLabel(angles: CameraAngles): string {
  const s = snapAngles(angles)
  const az = AZIMUTH_NAMES[s.azimuth] ?? 'front view'
  const el = ELEVATION_NAMES[s.elevation] ?? 'eye-level shot'
  const dist = DISTANCE_NAMES[String(s.distance)] ?? 'medium shot'
  return `${az} ${el} ${dist}`
}

/**
 * Build the full prompt sent to the image-edit API.
 *
 * Strategy: use clear, natural-language photography direction that
 * general-purpose image-edit models (e.g. gpt-image-1.5) can follow,
 * rather than LoRA trigger tokens or raw numeric parameters.
 */
export function buildAnglePrompt(angles: CameraAngles, userPrompt?: string): string {
  const s = snapAngles(angles)

  const azDesc = AZIMUTH_DESCRIPTIONS[s.azimuth] ?? 'seen from the front'
  const elDesc = ELEVATION_DESCRIPTIONS[s.elevation] ?? 'camera at eye level'
  const distDesc = DISTANCE_DESCRIPTIONS[String(s.distance)] ?? 'framed at a standard medium distance'

  // Lead with a concise camera direction, then elaborate
  const azName = AZIMUTH_NAMES[s.azimuth] ?? 'front view'
  const elName = ELEVATION_NAMES[s.elevation] ?? 'eye-level shot'
  const distName = DISTANCE_NAMES[String(s.distance)] ?? 'medium shot'

  const parts = [
    'Re-photograph the entire image as the same scene from a different camera position.',
    `Target camera: ${azName}, ${elName}, ${distName}.`,
    `Target view details: ${azDesc}; ${elDesc}; ${distDesc}.`,
    'This is a full-scene camera change, not a subject-only edit.',
    'Treat the source image as the same real scene in a fixed physical state.',
    'Only the camera angle and focal length / framing may change.',
    'All objects, surfaces, and the background must shift consistently to the new viewpoint.',
    'Keep the physical arrangement of the whole scene unchanged. Only the camera moves.',
    'Keep left and right consistent with the source image; any label, logo, pattern, damage, or unique feature must stay on the same physical side of the same object.',
    'If any person or animal appears in the scene, keep the exact same pose and action, and do not let the head, face, or eyes turn to follow the camera.',
  ]

  const extra = userPrompt?.trim()
  if (extra) {
    parts.push(`Additional request that must not override the camera-only and physical-state-unchanged rules: ${extra}`)
  }

  return parts.join(' ')
}

/**
 * Short display label for the toolbar (e.g. "front view · eye-level · medium").
 */
export function anglesToDisplayLabel(angles: CameraAngles): string {
  const s = snapAngles(angles)
  const az = AZIMUTH_NAMES[s.azimuth] ?? 'front view'
  const el = (ELEVATION_NAMES[s.elevation] ?? 'eye-level shot').replace(' shot', '')
  const dist = (DISTANCE_NAMES[String(s.distance)] ?? 'medium shot').replace(' shot', '')
  return `${az} · ${el} · ${dist}`
}

export { AZIMUTH_STEPS, ELEVATION_STEPS, DISTANCE_STEPS }
