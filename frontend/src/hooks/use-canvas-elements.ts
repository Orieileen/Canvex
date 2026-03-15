import { useCallback, useRef } from 'react'
import { CaptureUpdateAction, getCommonBounds } from '@excalidraw/excalidraw'
import { getFontFamilyName } from '@/utils/canvex'

export function useCanvasElements({ canvexApiRef, canvasWrapRef, currentSceneRef }: {
  canvexApiRef: React.MutableRefObject<any>
  canvasWrapRef: React.MutableRefObject<HTMLDivElement | null>
  currentSceneRef: React.MutableRefObject<any>
}) {
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const createBaseElement = useCallback((overrides: Record<string, any>) => {
    const now = Date.now()
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
    return {
      id,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      seed: Math.floor(Math.random() * 2 ** 31),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      index: null,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: [],
      updated: now,
      link: null,
      locked: false,
      ...overrides,
    }
  }, [])

  const createTextElement = useCallback((overrides: Record<string, any>) => {
    return createBaseElement({
      type: 'text',
      text: '',
      fontSize: 18,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: '',
      autoResize: true,
      lineHeight: 1.3,
      ...overrides,
    })
  }, [createBaseElement])

  const createRectElement = useCallback((overrides: Record<string, any>) => {
    return createBaseElement({
      type: 'rectangle',
      strokeColor: '#94a3b8',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'dashed',
      roughness: 0,
      roundness: null,
      ...overrides,
    })
  }, [createBaseElement])

  const createImageElement = useCallback((overrides: Record<string, any>) => {
    return createBaseElement({
      type: 'image',
      fileId: null,
      status: 'saved',
      scale: [1, 1],
      crop: null,
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
      ...overrides,
    })
  }, [createBaseElement])

  const getElementViewportRect = useCallback((element: any, appStateOverride?: any) => {
    const api = canvexApiRef.current
    const appState = appStateOverride || api?.getAppState?.()
    const containerRect = canvasWrapRef.current?.getBoundingClientRect()
    if (!appState || !containerRect) return null
    const zoom = appState.zoom?.value || 1
    const scrollX = appState.scrollX || 0
    const scrollY = appState.scrollY || 0
    const offsetLeft = appState.offsetLeft ?? 0
    const offsetTop = appState.offsetTop ?? 0
    const offsetX = offsetLeft - containerRect.left
    const offsetY = offsetTop - containerRect.top
    const rect = {
      x: (element.x + scrollX) * zoom + offsetX,
      y: (element.y + scrollY) * zoom + offsetY,
      width: (element.width || 0) * zoom,
      height: (element.height || 0) * zoom,
    }
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || rect.width <= 0 || rect.height <= 0) return null
    return rect
  }, [canvexApiRef, canvasWrapRef])

  const getSceneRectViewportRect = useCallback((rect: { x: number; y: number; width: number; height: number }, appStateOverride?: any) => {
    const api = canvexApiRef.current
    const appState = appStateOverride || api?.getAppState?.()
    const containerRect = canvasWrapRef.current?.getBoundingClientRect()
    if (!appState || !containerRect) return null
    const zoom = appState.zoom?.value || 1
    const scrollX = appState.scrollX || 0
    const scrollY = appState.scrollY || 0
    const offsetLeft = appState.offsetLeft ?? 0
    const offsetTop = appState.offsetTop ?? 0
    const offsetX = offsetLeft - containerRect.left
    const offsetY = offsetTop - containerRect.top
    const viewRect = {
      x: (rect.x + scrollX) * zoom + offsetX,
      y: (rect.y + scrollY) * zoom + offsetY,
      width: rect.width * zoom,
      height: rect.height * zoom,
    }
    if (!Number.isFinite(viewRect.x) || !Number.isFinite(viewRect.y) || viewRect.width <= 0 || viewRect.height <= 0) return null
    return viewRect
  }, [canvexApiRef, canvasWrapRef])

  const getSelectedElementsByIds = useCallback((ids: string[]) => {
    if (!ids.length) return []
    const api = canvexApiRef.current
    const elements = api?.getSceneElements?.()
    if (!Array.isArray(elements)) return []
    return elements.filter((item: any) => ids.includes(item?.id) && !item?.isDeleted)
  }, [canvexApiRef])

  const getSelectionBounds = useCallback((elements: any[]) => {
    if (!elements.length) return null
    try {
      const [minX, minY, maxX, maxY] = getCommonBounds(elements)
      const width = Math.max(1, maxX - minX)
      const height = Math.max(1, maxY - minY)
      return { x: minX, y: minY, width, height }
    } catch {
      return null
    }
  }, [])

  const getSceneElementsSafe = useCallback(() => {
    const api = canvexApiRef.current
    const fromApi = api?.getSceneElements?.()
    const fromRef = currentSceneRef.current?.elements
    if (Array.isArray(fromApi) && Array.isArray(fromRef)) {
      if (fromRef.length > fromApi.length) return fromRef
      return fromApi
    }
    if (Array.isArray(fromApi)) return fromApi
    if (Array.isArray(fromRef)) return fromRef
    return []
  }, [canvexApiRef, currentSceneRef])

  const getElementSceneBounds = useCallback((element: any) => {
    if (!element || element.isDeleted) return null
    const rawX = Number(element.x)
    const rawY = Number(element.y)
    const rawWidth = Number(element.width)
    const rawHeight = Number(element.height)
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) {
      return null
    }
    const width = Math.abs(rawWidth)
    const height = Math.abs(rawHeight)
    if (width <= 0 || height <= 0) return null
    const left = rawWidth >= 0 ? rawX : rawX + rawWidth
    const top = rawHeight >= 0 ? rawY : rawY + rawHeight
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
    }
  }, [])

  const findNonOverlappingPinPosition = useCallback((
    elements: any[],
    x: number,
    startY: number,
    width: number,
    height: number,
    gap = 16,
  ) => {
    const safeGap = Number.isFinite(gap) && gap > 0 ? gap : 16
    const rectWidth = Math.max(1, Number(width) || 1)
    const rectHeight = Math.max(1, Number(height) || 1)
    const left = Number.isFinite(Number(x)) ? Number(x) : 0
    const right = left + rectWidth
    let y = Number.isFinite(Number(startY)) ? Number(startY) : 0

    for (let step = 0; step < 400; step += 1) {
      const top = y
      const bottom = y + rectHeight
      let collided = false
      let nextY = y
      for (const element of elements || []) {
        const bounds = getElementSceneBounds(element)
        if (!bounds) continue
        const overlapsX = left < (bounds.right + safeGap) && right > (bounds.left - safeGap)
        if (!overlapsX) continue
        const overlapsY = top < (bounds.bottom + safeGap) && bottom > (bounds.top - safeGap)
        if (!overlapsY) continue
        collided = true
        nextY = Math.max(nextY, bounds.bottom + safeGap)
      }
      if (!collided) break
      y = nextY > y ? nextY : y + safeGap
    }
    return { x: left, y }
  }, [getElementSceneBounds])

  const wrapChatText = useCallback((text: string, maxWidth: number, fontSize: number, fontFamily: number) => {
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas')
    }
    const ctx = measureCanvasRef.current.getContext('2d')
    if (!ctx) return text
    ctx.font = `${fontSize}px ${getFontFamilyName(fontFamily)}`

    const lines: string[] = []
    const paragraphs = text.split('\n')
    for (const paragraph of paragraphs) {
      if (!paragraph) {
        lines.push('')
        continue
      }
      let current = ''
      for (const char of paragraph) {
        const next = current + char
        if (ctx.measureText(next).width > maxWidth && current.length > 0) {
          lines.push(current)
          current = char
        } else {
          current = next
        }
      }
      if (current.length > 0) lines.push(current)
    }
    return lines.join('\n')
  }, [])

  const measurePinnedText = useCallback((content: string, width: number, fontSize = 18, fontFamily = 5) => {
    const lineHeight = 1.3
    const horizontalPadding = 8
    const wrappedText = wrapChatText(content, Math.max(24, width - horizontalPadding * 2), fontSize, fontFamily)
    const lineCount = Math.max(1, wrappedText.split('\n').length)
    const textHeight = Math.max(fontSize + 4, Math.round(lineCount * fontSize * lineHeight))
    return {
      wrappedText,
      textHeight,
      lineHeight,
    }
  }, [wrapChatText])

  const removeElementsById = useCallback((ids: string[]) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return
    const existing = getSceneElementsSafe()
    const now = Date.now()
    const nextElements = existing.map((item: any) => {
      if (!item || !ids.includes(item.id)) return item
      return {
        ...item,
        isDeleted: true,
        updated: now,
        version: (item.version || 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      }
    })
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }, [canvexApiRef, getSceneElementsSafe])

  return {
    measureCanvasRef,
    createBaseElement,
    createTextElement,
    createRectElement,
    createImageElement,
    getElementViewportRect,
    getSceneRectViewportRect,
    getSelectedElementsByIds,
    getSelectionBounds,
    getSceneElementsSafe,
    getElementSceneBounds,
    findNonOverlappingPinPosition,
    wrapChatText,
    measurePinnedText,
    removeElementsById,
  }
}
