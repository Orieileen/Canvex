/**
 * Angle-to-prompt mapping matching the HuggingFace multi-angle 3D camera
 * space (multimodalart/qwen-image-multiple-angles-3d-camera).
 *
 * Three axes: azimuth (0-360°), elevation (-30 to 60°), distance (0.6-1.4).
 * Each axis snaps to discrete steps and maps to a natural-language token.
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

// ── Elevation: 4 positions ──────────────────────────────────────────────

const ELEVATION_STEPS = [-30, 0, 30, 60] as const

const ELEVATION_NAMES: Record<number, string> = {
  '-30': 'low-angle shot',
  0: 'eye-level shot',
  30: 'elevated shot',
  60: 'high-angle shot',
}

// ── Distance: 3 positions ───────────────────────────────────────────────

const DISTANCE_STEPS = [0.6, 1.0, 1.4] as const

const DISTANCE_NAMES: Record<string, string> = {
  '0.6': 'close-up',
  '1': 'medium shot',
  '1.4': 'wide shot',
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
 * Build the camera prompt string: "<azimuth> <elevation> <distance>"
 * matching the HF space format.
 */
export function buildCameraPromptLabel(angles: CameraAngles): string {
  const s = snapAngles(angles)
  const az = AZIMUTH_NAMES[s.azimuth] ?? 'front view'
  const el = ELEVATION_NAMES[s.elevation] ?? 'eye-level shot'
  const dist = DISTANCE_NAMES[String(s.distance)] ?? 'medium shot'
  return `${az} ${el} ${dist}`
}

/**
 * Build the exact HF LoRA token sequence: "<sks> <azimuth> <elevation> <distance>".
 */
export function buildHfCameraPrompt(angles: CameraAngles): string {
  return `<sks> ${buildCameraPromptLabel(angles)}`
}

/**
 * Build the full prompt sent to the image-edit API.
 *
 * Includes explicit numeric angles so the LLM can unambiguously interpret
 * the camera pose even when the natural-language labels are ambiguous.
 */
export function buildAnglePrompt(angles: CameraAngles, userPrompt?: string): string {
  const s = snapAngles(angles)
  const cameraPrompt = buildHfCameraPrompt(angles)

  // Explicit numeric hint block – helps models that struggle with label-only prompts
  const numericHint = [
    `azimuth ${s.azimuth}° (0°=front, 90°=right, 180°=back, 270°=left)`,
    `elevation ${s.elevation}° (-30°=low angle looking up, 0°=eye level, 30°=elevated, 60°=high angle looking down)`,
    `distance ${s.distance} (0.6=close-up, 1.0=medium, 1.4=wide)`,
  ].join(', ')

  const preserve = [
    'Treat this as the same fixed scene photographed from a different camera position.',
    "Keep the subject's identity, proportions, pose, orientation, expression, outfit or materials, colors, and all visual details exactly the same.",
    'Do not rotate, re-pose, reorient, animate, or otherwise change the subject to face the camera.',
    'If the subject has a face, eyes, or a clear front direction, keep that gaze or facing direction exactly the same as in the source image.',
    'Do not change the lighting direction, shadows, or color temperature.',
    'Maintain the original background and scene environment.',
    'Only the camera viewpoint and framing change; the subject and scene remain fixed.',
  ].join(' ')

  const base = `${cameraPrompt}. Camera parameters: ${numericHint}. ${preserve}`
  const extra = userPrompt?.trim()
  if (extra) {
    return `${base} Additional instructions: ${extra}`
  }
  return base
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
