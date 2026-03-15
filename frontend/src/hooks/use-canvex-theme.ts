import { useCallback, useRef } from 'react'

export function useCanvexTheme({ canvasWrapRef }: {
  canvasWrapRef: React.MutableRefObject<HTMLDivElement | null>
}) {
  const canvexThemeRef = useRef<'light' | 'dark'>('light')

  const resolveCanvexTheme = useCallback((theme?: string) => {
    if (theme === 'dark') return 'dark'
    if (theme === 'light') return 'light'
    if (theme === 'system') {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
    }
    return 'light'
  }, [])

  const syncCanvexTheme = useCallback((theme?: string) => {
    const host = canvasWrapRef.current
    if (!host) return
    const resolved = resolveCanvexTheme(theme)
    if (canvexThemeRef.current !== resolved) {
      canvexThemeRef.current = resolved
      host.classList.toggle('dark', resolved === 'dark')
    }
  }, [canvasWrapRef, resolveCanvexTheme])

  const buildVideoPosterDataUrl = useCallback(() => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0f172a"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
        </defs>
        <rect width="640" height="360" fill="url(#bg)"/>
      </svg>
    `
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }, [])

  const isVideoElement = useCallback((item: any) => {
    if (!item || item.type !== 'image') return false
    const data = item.customData || {}
    return data.aiChatType === 'note-video' || Boolean(data.aiVideoUrl)
  }, [])

  return {
    canvexThemeRef,
    resolveCanvexTheme,
    syncCanvexTheme,
    buildVideoPosterDataUrl,
    isVideoElement,
  }
}
