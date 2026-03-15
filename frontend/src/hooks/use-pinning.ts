import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaptureUpdateAction, convertToExcalidrawElements, getCommonBounds } from '@excalidraw/excalidraw'
import type { ChatMessage, ImagePlaceholder, MermaidInsertResult, PinOrigin, PinRect, PlaceholderOptions } from '@/types/canvex'
import { getLatestElements, normalizeMermaidForCanvasParser } from '@/utils/canvex'

export function usePinning({
  sceneIdRef,
  canvexApiRef,
  currentSceneRef: _currentSceneRef,
  pinOriginRef,
  lastPinnedIdRef,
  imagePlaceholderQueueRef,
  getPinLastKey,
  getPinOriginKey,
  getSceneElementsSafe,
  createTextElement,
  createRectElement,
  measurePinnedText,
  wrapChatText,
  findNonOverlappingPinPosition,
  getElementViewportRect,
  removeElementsById: _removeElementsById,
  captureSceneSnapshot,
  persistLastPinnedForScene: _persistLastPinnedForSceneExternal,
  persistPinOriginForScene: _persistPinOriginForSceneExternal,
}: {
  sceneIdRef: React.MutableRefObject<string | null>
  canvexApiRef: React.MutableRefObject<any>
  currentSceneRef: React.MutableRefObject<any>
  pinOriginRef: React.MutableRefObject<PinOrigin | null>
  lastPinnedIdRef: React.MutableRefObject<string | null>
  imagePlaceholderQueueRef: React.MutableRefObject<ImagePlaceholder[]>
  getPinLastKey: (id?: string | null) => string
  getPinOriginKey: (id?: string | null) => string
  getSceneElementsSafe: () => any[]
  createTextElement: (overrides: Record<string, any>) => any
  createRectElement: (overrides: Record<string, any>) => any
  measurePinnedText: (content: string, width: number, fontSize?: number, fontFamily?: number) => { wrappedText: string; textHeight: number; lineHeight: number }
  wrapChatText: (text: string, maxWidth: number, fontSize: number, fontFamily: number) => string
  findNonOverlappingPinPosition: (elements: any[], x: number, startY: number, width: number, height: number, gap?: number) => { x: number; y: number }
  getElementViewportRect: (element: any, appStateOverride?: any) => PinRect | null
  removeElementsById: (ids: string[]) => void
  captureSceneSnapshot: () => void
  persistLastPinnedForScene?: (sceneId: string | null, elementId: string | null) => void
  persistPinOriginForScene?: (sceneId: string | null, origin: PinOrigin | null) => void
}) {
  const { t: _t } = useTranslation('canvex')
  const [lastPinnedId, setLastPinnedId] = useState<string | null>(null)
  const [pinFlashRect, setPinFlashRect] = useState<PinRect | null>(null)

  const loadLastPinnedForScene = useCallback((sceneId: string | null) => {
    const key = getPinLastKey(sceneId)
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        lastPinnedIdRef.current = raw
        setLastPinnedId(raw)
        return
      }
    } catch {}
    lastPinnedIdRef.current = null
    setLastPinnedId(null)
  }, [getPinLastKey, lastPinnedIdRef])

  const persistLastPinnedForScene = useCallback((sceneId: string | null, elementId: string | null) => {
    const key = getPinLastKey(sceneId)
    try {
      if (elementId) {
        localStorage.setItem(key, elementId)
      } else {
        localStorage.removeItem(key)
      }
    } catch {}
  }, [getPinLastKey])

  const migrateDraftLastPinnedToScene = useCallback((sceneId: string) => {
    const draftKey = getPinLastKey(null)
    const targetKey = getPinLastKey(sceneId)
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) {
        localStorage.setItem(targetKey, raw)
        localStorage.removeItem(draftKey)
      }
    } catch {}
  }, [getPinLastKey])

  const loadPinOriginForScene = useCallback((sceneId: string | null) => {
    const key = getPinOriginKey(sceneId)
    try {
      const raw = localStorage.getItem(key)
      if (!raw) {
        pinOriginRef.current = null
        return
      }
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        pinOriginRef.current = parsed
        return
      }
    } catch {}
    pinOriginRef.current = null
  }, [getPinOriginKey, pinOriginRef])

  const persistPinOriginForScene = useCallback((sceneId: string | null, origin: PinOrigin | null) => {
    const key = getPinOriginKey(sceneId)
    try {
      if (origin) {
        localStorage.setItem(key, JSON.stringify(origin))
      } else {
        localStorage.removeItem(key)
      }
    } catch {}
  }, [getPinOriginKey])

  const migrateDraftPinOriginToScene = useCallback((sceneId: string) => {
    const draftKey = getPinOriginKey(null)
    const targetKey = getPinOriginKey(sceneId)
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) {
        localStorage.setItem(targetKey, raw)
        localStorage.removeItem(draftKey)
      }
    } catch {}
  }, [getPinOriginKey])

  const flashPinnedElement = useCallback((element: any) => {
    const rect = getElementViewportRect(element)
    if (!rect) return
    setPinFlashRect(rect)
    window.setTimeout(() => {
      setPinFlashRect(null)
    }, 700)
  }, [getElementViewportRect])

  const createPinnedNote = useCallback((sceneId: string | null, message: ChatMessage) => {
    if (sceneId !== sceneIdRef.current) return
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState) return
    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    const gap = 16
    let origin = pinOriginRef.current
    if (!origin) {
      origin = {
        x: -(appState.scrollX || 0) + 32,
        y: -(appState.scrollY || 0) + 32,
      }
      pinOriginRef.current = origin
      persistPinOriginForScene(sceneId, origin)
    }
    const baseX = origin.x
    const baseY = origin.y
    const fontSize = 18
    const fixedWidth = 320
    const layout = measurePinnedText(message.content, fixedWidth, fontSize, 5)
    const placement = findNonOverlappingPinPosition(
      existing,
      baseX,
      baseY,
      fixedWidth,
      Math.max(20, layout.textHeight),
      gap,
    )
    const x = placement.x
    const y = placement.y
    const groupId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const palette = { stroke: '#000000' }
    const text = createTextElement({
      text: layout.wrappedText,
      x,
      y,
      fontSize,
      textAlign: 'left',
      verticalAlign: 'top',
      strokeColor: palette.stroke,
      backgroundColor: 'transparent',
      groupIds: [groupId],
      width: fixedWidth,
      height: Math.max(20, layout.textHeight),
      originalText: layout.wrappedText,
      lineHeight: layout.lineHeight,
      autoResize: false,
      customData: {
        aiChatType: 'note-text',
        aiChatRole: message.role,
        aiChatMessageId: message.id,
        aiChatCreatedAt: message.created_at,
      },
    })
    api.updateScene({
      elements: [...(existing || []), text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent([text], { fitToViewport: false })
      } catch {}
    }
    lastPinnedIdRef.current = text.id
    setLastPinnedId(text.id)
    persistLastPinnedForScene(sceneId, text.id)
    try {
      api.updateScene({
        appState: {
          selectedElementIds: { [text.id]: true },
          selectedGroupIds: {},
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      window.setTimeout(() => {
        api.updateScene({
          appState: {
            selectedElementIds: {},
            selectedGroupIds: {},
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      }, 800)
    } catch {}
    window.setTimeout(() => {
      flashPinnedElement(text)
    }, 120)
    if (typeof api.refresh === 'function') {
      api.refresh()
    }
    return text.id
  }, [canvexApiRef, captureSceneSnapshot, createTextElement, findNonOverlappingPinPosition, flashPinnedElement, getSceneElementsSafe, lastPinnedIdRef, measurePinnedText, persistLastPinnedForScene, persistPinOriginForScene, pinOriginRef, sceneIdRef])

  const updatePinnedNoteText = useCallback((noteId: string, content: string) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return
    const existing = getSceneElementsSafe()
    const target = existing.find((item: any) => item?.id === noteId && !item?.isDeleted)
    if (!target) return
    const fontSize = 18
    const fixedWidth = 320
    const layout = measurePinnedText(content, fixedWidth, fontSize, 5)
    const updated = {
      ...target,
      text: layout.wrappedText,
      originalText: layout.wrappedText,
      width: fixedWidth,
      height: Math.max(20, layout.textHeight),
      autoResize: false,
      lineHeight: layout.lineHeight,
      updated: Date.now(),
      version: (target.version || 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
    }
    const nextElements = existing.map((item: any) => (item.id === noteId ? updated : item))
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
  }, [canvexApiRef, captureSceneSnapshot, getSceneElementsSafe, measurePinnedText])

  const updatePinnedNoteMeta = useCallback((noteId: string, content: string, meta?: Record<string, any>) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return
    const existing = getSceneElementsSafe()
    const target = existing.find((item: any) => item?.id === noteId && !item?.isDeleted)
    if (!target) return
    const fontSize = 18
    const fixedWidth = 320
    const layout = measurePinnedText(content, fixedWidth, fontSize, 5)
    const updated = {
      ...target,
      text: layout.wrappedText,
      originalText: layout.wrappedText,
      width: fixedWidth,
      height: Math.max(20, layout.textHeight),
      autoResize: false,
      lineHeight: layout.lineHeight,
      customData: {
        ...(target.customData || {}),
        ...(meta || {}),
      },
      updated: Date.now(),
      version: (target.version || 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
    }
    const nextElements = existing.map((item: any) => (item.id === noteId ? updated : item))
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
  }, [canvexApiRef, captureSceneSnapshot, getSceneElementsSafe, measurePinnedText])

  const createImagePlaceholder = useCallback((sceneId: string | null, label: string, options?: PlaceholderOptions) => {
    if (sceneId !== sceneIdRef.current) return null
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState) return null
    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    const gap = 16
    let origin = pinOriginRef.current
    if (!origin) {
      origin = {
        x: -(appState.scrollX || 0) + 32,
        y: -(appState.scrollY || 0) + 32,
      }
      pinOriginRef.current = origin
      persistPinOriginForScene(sceneId, origin)
    }
    const baseX = origin.x
    const baseY = origin.y

    const width = 400
    const height = 400
    const placement = findNonOverlappingPinPosition(existing, baseX, baseY, width, height, gap)
    const groupId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    const placeholderType = options?.kind === 'video' ? 'note-video-placeholder' : 'note-image-placeholder'
    const jobId = options?.jobId ? String(options.jobId) : null

    const rect = createRectElement({
      x: placement.x,
      y: placement.y,
      width,
      height,
      groupIds: [groupId],
      customData: {
        aiChatType: placeholderType,
        aiChatStatus: 'pending',
        aiChatCreatedAt: new Date().toISOString(),
        ...(jobId ? { aiVideoJobId: jobId } : {}),
      },
    })
    const fontSize = 16
    const text = createTextElement({
      x: placement.x + 12,
      y: placement.y + 12,
      width: width - 24,
      height: 24,
      fontSize,
      textAlign: 'left',
      verticalAlign: 'top',
      strokeColor: '#64748b',
      backgroundColor: 'transparent',
      text: label,
      originalText: label,
      groupIds: [groupId],
      customData: {
        aiChatType: placeholderType,
        aiChatStatus: 'pending',
        aiChatCreatedAt: new Date().toISOString(),
        ...(jobId ? { aiVideoJobId: jobId } : {}),
      },
    })

    api.updateScene({
      elements: [...(existing || []), rect, text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent([rect], { fitToViewport: false })
      } catch {}
    }
    lastPinnedIdRef.current = rect.id
    setLastPinnedId(rect.id)
    persistLastPinnedForScene(sceneId, rect.id)
    window.setTimeout(() => {
      flashPinnedElement(rect)
    }, 120)
    return { sceneId, groupId, rectId: rect.id, textId: text.id } as ImagePlaceholder
  }, [canvexApiRef, createRectElement, createTextElement, findNonOverlappingPinPosition, flashPinnedElement, getSceneElementsSafe, lastPinnedIdRef, persistLastPinnedForScene, persistPinOriginForScene, pinOriginRef, sceneIdRef])

  const updatePlaceholderText = useCallback((placeholder: ImagePlaceholder, content: string) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return
    const existing = getSceneElementsSafe()
    const target = existing.find((item: any) => item?.id === placeholder.textId && !item?.isDeleted)
    if (!target) return
    const fontSize = target.fontSize || 16
    const lineHeight = target.lineHeight || 1.3
    const width = target.width || 240
    const wrappedText = wrapChatText(content, width - 8, fontSize, target.fontFamily || 5)
    const lineCount = wrappedText.split('\n').length
    const textHeight = Math.max(24, Math.round(lineCount * fontSize * lineHeight + fontSize))
    const currentText = typeof target.text === 'string' ? target.text : ''
    const currentOriginalText = typeof target.originalText === 'string' ? target.originalText : ''
    const currentHeight = Number(target.height) || 0
    if (
      currentText === wrappedText
      && currentOriginalText === wrappedText
      && Math.abs(currentHeight - textHeight) < 0.5
    ) {
      return
    }
    const updated = {
      ...target,
      text: wrappedText,
      originalText: wrappedText,
      width,
      height: textHeight,
      updated: Date.now(),
      version: (target.version || 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
    }
    const nextElements = existing.map((item: any) => (item.id === placeholder.textId ? updated : item))
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }, [canvexApiRef, getSceneElementsSafe, wrapChatText])

  const updatePlaceholderMeta = useCallback((placeholder: ImagePlaceholder, meta: Record<string, any>) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return
    const existing = getSceneElementsSafe()
    const now = Date.now()
    const nextElements = existing.map((item: any) => {
      if (!item || item.isDeleted) return item
      if (item.id !== placeholder.rectId && item.id !== placeholder.textId) return item
      return {
        ...item,
        customData: {
          ...(item.customData || {}),
          ...(meta || {}),
        },
        updated: now,
        version: (item.version || 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      }
    })
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
  }, [canvexApiRef, captureSceneSnapshot, getSceneElementsSafe])

  const enqueueImagePlaceholder = useCallback((placeholder: ImagePlaceholder | null) => {
    if (!placeholder) return
    imagePlaceholderQueueRef.current = [...imagePlaceholderQueueRef.current, placeholder]
  }, [imagePlaceholderQueueRef])

  const takeNextImagePlaceholder = useCallback((sceneId: string | null) => {
    if (!sceneId) return null
    const queue = imagePlaceholderQueueRef.current
    const index = queue.findIndex((item) => item.sceneId === sceneId)
    if (index === -1) return null
    const next = queue[index]
    imagePlaceholderQueueRef.current = [...queue.slice(0, index), ...queue.slice(index + 1)]
    return next
  }, [imagePlaceholderQueueRef])

  const markPendingPlaceholdersFailed = useCallback((sceneId: string | null, message = '生成失败') => {
    if (!sceneId) return
    const queue = imagePlaceholderQueueRef.current
    if (!queue.length) return
    const remaining: ImagePlaceholder[] = []
    for (const item of queue) {
      if (item.sceneId === sceneId) {
        updatePlaceholderText(item, message)
      } else {
        remaining.push(item)
      }
    }
    imagePlaceholderQueueRef.current = remaining
  }, [imagePlaceholderQueueRef, updatePlaceholderText])

  const insertMermaidFlowchartToCanvas = useCallback(async (
    sceneId: string | null,
    mermaidText: string,
  ): Promise<MermaidInsertResult> => {
    if (!sceneId || sceneId !== sceneIdRef.current) {
      return { ok: false, error: 'scene_mismatch' }
    }
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState) {
      return { ok: false, error: 'canvas_api_unavailable' }
    }
    const source = String(mermaidText || '').trim()
    if (!source) {
      return { ok: false, error: 'empty_mermaid' }
    }

    let parsed: any = null
    let sourceForInsert = source
    const parseOptions = {
      flowchart: { curve: 'linear' as const },
    }
    try {
      const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw')
      try {
        parsed = await parseMermaidToExcalidraw(source, parseOptions)
      } catch (error) {
        const fallbackSource = normalizeMermaidForCanvasParser(source)
        if (!fallbackSource || fallbackSource === source) {
          return { ok: false, error: (error as Error)?.message || 'parse_failed' }
        }
        sourceForInsert = fallbackSource
        parsed = await parseMermaidToExcalidraw(fallbackSource, parseOptions)
      }
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || 'parse_failed' }
    }

    const skeleton = Array.isArray(parsed?.elements) ? parsed.elements : []
    if (!skeleton.length) {
      return { ok: false, error: 'no_elements_generated' }
    }

    let importedElements: any[] = []
    try {
      importedElements = convertToExcalidrawElements(skeleton, { regenerateIds: true }) as any[]
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || 'convert_failed' }
    }
    if (!importedElements.length) {
      return { ok: false, error: 'no_elements_converted' }
    }

    const now = Date.now()
    if (api?.addFiles && parsed?.files && typeof parsed.files === 'object') {
      const fileList = Object.values(parsed.files)
        .filter((item: any) => item && typeof item.id === 'string' && typeof item.dataURL === 'string')
        .map((item: any) => ({
          ...item,
          created: Number(item.created) || now,
          lastRetrieved: now,
        }))
      if (fileList.length) {
        api.addFiles(fileList)
      }
    }

    let minX = 0
    let minY = 0
    let maxX = 0
    let maxY = 0
    try {
      ;[minX, minY, maxX, maxY] = getCommonBounds(importedElements)
    } catch {
      return { ok: false, error: 'bounds_failed' }
    }
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)

    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    let origin = pinOriginRef.current
    if (!origin) {
      origin = {
        x: -(appState.scrollX || 0) + 32,
        y: -(appState.scrollY || 0) + 32,
      }
      pinOriginRef.current = origin
      persistPinOriginForScene(sceneId, origin)
    }
    const placement = findNonOverlappingPinPosition(existing, origin.x, origin.y, width, height, 24)
    const offsetX = placement.x - minX
    const offsetY = placement.y - minY
    const createdAt = new Date().toISOString()

    const shiftedElements = importedElements.map((element: any) => ({
      ...element,
      x: (Number(element.x) || 0) + offsetX,
      y: (Number(element.y) || 0) + offsetY,
      index: null,
      customData: {
        ...(element.customData || {}),
        aiChatType: 'mermaid-flowchart',
        aiChatCreatedAt: createdAt,
        aiMermaidSource: sourceForInsert,
      },
    }))

    api.updateScene({
      elements: [...(existing || []), ...shiftedElements],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()

    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent(shiftedElements, { fitToViewport: false })
      } catch {}
    }

    const latestInserted = shiftedElements[shiftedElements.length - 1]
    if (latestInserted?.id) {
      lastPinnedIdRef.current = latestInserted.id
      setLastPinnedId(latestInserted.id)
      persistLastPinnedForScene(sceneId, latestInserted.id)
      window.setTimeout(() => {
        flashPinnedElement(latestInserted)
      }, 120)
    }

    return {
      ok: true,
      insertedCount: shiftedElements.length,
    }
  }, [canvexApiRef, captureSceneSnapshot, findNonOverlappingPinPosition, flashPinnedElement, getSceneElementsSafe, lastPinnedIdRef, persistLastPinnedForScene, persistPinOriginForScene, pinOriginRef, sceneIdRef])

  const jumpToLatestPinned = useCallback((activeSceneId: string | null) => {
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return
    const elements = api.getSceneElements()
    const { latest, previous } = getLatestElements(elements)
    if (!latest) return
    const currentId = lastPinnedIdRef.current
    let element = latest
    if (previous) {
      if (currentId === latest.id) {
        element = previous
      } else if (currentId === previous.id) {
        element = latest
      } else {
        element = latest
      }
    }
    lastPinnedIdRef.current = element.id
    setLastPinnedId(element.id)
    persistLastPinnedForScene(activeSceneId, element.id)
    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent([element], { fitToViewport: false })
      } catch {}
    }
    window.setTimeout(() => {
      flashPinnedElement(element)
    }, 120)
  }, [canvexApiRef, flashPinnedElement, lastPinnedIdRef, persistLastPinnedForScene])

  return {
    lastPinnedId,
    setLastPinnedId,
    pinFlashRect,
    loadLastPinnedForScene,
    persistLastPinnedForScene,
    migrateDraftLastPinnedToScene,
    loadPinOriginForScene,
    persistPinOriginForScene,
    migrateDraftPinOriginToScene,
    flashPinnedElement,
    createPinnedNote,
    updatePinnedNoteText,
    updatePinnedNoteMeta,
    createImagePlaceholder,
    updatePlaceholderText,
    updatePlaceholderMeta,
    enqueueImagePlaceholder,
    takeNextImagePlaceholder,
    markPendingPlaceholdersFailed,
    insertMermaidFlowchartToCanvas,
    jumpToLatestPinned,
  }
}
