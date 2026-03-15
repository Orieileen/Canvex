export const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8000' : '')
export const WORKSPACE_KEY = import.meta.env.VITE_WORKSPACE_KEY || 'public'
export const MAX_VIDEO_POSTER_DIM = 512

export const parsePositiveIntEnv = (raw: unknown, fallback: number) => {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

export const SCENE_SAVE_DEBOUNCE_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_DEBOUNCE_MS, 600)
export const SCENE_SAVE_URGENT_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_URGENT_MS, 180)
export const SCENE_SAVE_FORCE_FLUSH_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_FORCE_FLUSH_MS, 1600)
export const SCENE_SAVE_WATCH_INTERVAL_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_WATCH_INTERVAL_MS, 700)
export const SCENE_LOCAL_CACHE_DEBOUNCE_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_LOCAL_CACHE_DEBOUNCE_MS, 400)
export const MAX_CANVAS_IMAGE_DIM = parsePositiveIntEnv(import.meta.env.VITE_CANVEX_MAX_SCENE_IMAGE_DIM, 1600)

export const IMAGE_EDIT_SIZE_OPTIONS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
export const IMAGE_EDIT_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
  '4:5': '1024x1536',
  '5:4': '1536x1024',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
  '21:9': '1536x1024',
}

export const resolveImageEditSize = (value: string) => IMAGE_EDIT_SIZE_MAP[value] || value
