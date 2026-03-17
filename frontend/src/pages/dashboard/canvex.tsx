import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { DefaultSidebar, Excalidraw, MainMenu, Sidebar } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import '@/styles/canvex-shadcn.css'
import '@/styles/canvex-media-sidebar.css'
import { IconAlertTriangle, IconLoader, IconMessage2, IconHistory, IconCheck, IconX, IconPhoto, IconVideo, IconRefresh, IconFolder, IconChevronRight } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import type { SceneData, PinOrigin, ToolResult, ImagePlaceholder, VideoOverlayItem } from '@/types/canvex'
import { WORKSPACE_KEY, IMAGE_EDIT_SIZE_OPTIONS } from '@/constants/canvex'
import { getLatestElements, isPregeneratedKeyword, sanitizeAppState } from '@/utils/canvex'
import { useCanvexTheme } from '@/hooks/use-canvex-theme'
import { useCanvasElements } from '@/hooks/use-canvas-elements'
import { useScenePersistence } from '@/hooks/use-scene-persistence'
import { usePinning } from '@/hooks/use-pinning'
import { useMediaLibrary } from '@/hooks/use-media-library'
import { useImageEditPipeline } from '@/hooks/use-image-edit-pipeline'
import { useVideoPipeline } from '@/hooks/use-video-pipeline'
import { useChat } from '@/hooks/use-chat'

let _webpSupported: boolean | null = null
function supportsWebp(): boolean {
  if (_webpSupported !== null) return _webpSupported
  try {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    _webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    _webpSupported = false
  }
  return _webpSupported
}

export default function CanvexPage() {
  const { t, i18n } = useTranslation('canvex')
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Shared refs ──────────────────────────────────────────────────────
  const canvexApiRef = useRef<any>(null)
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  const saveStatusRef = useRef<HTMLDivElement | null>(null)
  const sceneIdRef = useRef<string | null>(null)
  const currentSceneRef = useRef<SceneData | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const pendingRef = useRef<SceneData | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const localCacheTimerRef = useRef<number | null>(null)
  const workspaceKeyRef = useRef('canvex:workspace:public')
  const pinOriginRef = useRef<PinOrigin | null>(null)
  const lastPinnedIdRef = useRef<string | null>(null)
  const imagePlaceholderQueueRef = useRef<ImagePlaceholder[]>([])
  const videoOverlayKeyRef = useRef('')
  const createPinnedVideoRef = useRef<null | ((
    sceneId: string | null,
    videoUrl: string,
    thumbnailUrl?: string | null,
    placeholder?: ImagePlaceholder | null,
    videoJobId?: string | null,
  ) => Promise<boolean | void>)>(null)
  const createPinnedImageRef = useRef<null | ((
    sceneId: string | null,
    tool: ToolResult,
    placeholder?: ImagePlaceholder | null,
    meta?: Record<string, any>,
  ) => Promise<boolean | void>)>(null)
  const recoveredVideoScenesRef = useRef<Record<string, boolean>>({})
  const recoveredImageEditScenesRef = useRef<Record<string, boolean>>({})
  const videoEditSelectionByJobRef = useRef<Record<string, string>>({})
  const saveInFlightRef = useRef(false)
  const saveRerunRef = useRef(false)
  const lastMutationAtRef = useRef<number>(Date.now())
  const chatLoadTokenRef = useRef(0)
  const videoPollInFlightRef = useRef<Set<string>>(new Set())
  const imagePollInFlightRef = useRef<Set<string>>(new Set())
  const chatAbortControllersRef = useRef<Record<string, AbortController>>({})
  const chatInterruptedScenesRef = useRef<Set<string>>(new Set())
  const sceneSelectTokenRef = useRef(0)
  const sceneHydrateTokenRef = useRef(0)
  const handleChangeHashRef = useRef('')
  const captureSceneSnapshotRef = useRef<() => void>(() => {})
  // Stable wrapper so hooks don't get a new function ref every render
  const captureSceneSnapshotStable = useCallback(() => captureSceneSnapshotRef.current(), [])

  // ── Selected element pixel size overlay ────────────────────────────
  const [selectedElementInfo, setSelectedElementInfo] = useState<{
    type: 'image' | 'video'
    width: number
    height: number
    viewportRect: { x: number; y: number; width: number; height: number }
  } | null>(null)
  const selectedElementInfoRef = useRef(selectedElementInfo)
  selectedElementInfoRef.current = selectedElementInfo

  // ── Pure utility callbacks (no hook deps) ────────────────────────────
  const loadImageDataUrl = useCallback(async (url: string, maxDim?: number | null) => {
    if (url.startsWith('data:')) {
      return { dataUrl: url, width: null, height: null }
    }
    const res = await fetch(url, { mode: 'cors' })
    const blob = await res.blob()
    const toDataUrl = (input: Blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('Failed to read image'))
      reader.readAsDataURL(input)
    })
    try {
      const bitmap = await createImageBitmap(blob)
      const maxSide = Math.max(bitmap.width, bitmap.height)
      const limit = Number.isFinite(Number(maxDim)) && Number(maxDim) > 0 ? Number(maxDim) : 0
      const needsResize = limit > 0 && maxSide > limit
      const scale = needsResize ? limit / maxSide : 1
      const targetWidth = Math.max(1, Math.round(bitmap.width * scale))
      const targetHeight = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        const dataUrl = await toDataUrl(blob)
        bitmap.close?.()
        return { dataUrl, width: bitmap.width, height: bitmap.height }
      }
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
      bitmap.close?.()
      const dataUrl = supportsWebp()
        ? canvas.toDataURL('image/webp', 0.90)
        : canvas.toDataURL('image/jpeg', 0.92)
      canvas.width = 0
      canvas.height = 0
      return { dataUrl, width: targetWidth, height: targetHeight }
    } catch {
      const dataUrl = await toDataUrl(blob)
      return { dataUrl, width: null, height: null }
    }
  }, [])

  const getRemoteImageUrlFromElement = useCallback((element: any) => {
    if (!element || element.isDeleted || element.type !== 'image') return ''
    const data = element.customData || {}
    if (typeof data.aiVideoThumbnailUrl === 'string' && /^https?:\/\//.test(data.aiVideoThumbnailUrl)) {
      return data.aiVideoThumbnailUrl
    }
    if (typeof data.aiEditImageUrl === 'string' && /^https?:\/\//.test(data.aiEditImageUrl)) {
      return data.aiEditImageUrl
    }
    if (typeof data.aiChatImageUrl === 'string' && /^https?:\/\//.test(data.aiChatImageUrl)) {
      return data.aiChatImageUrl
    }
    return ''
  }, [])

  const getRemoteImageMimeType = useCallback((element: any) => {
    const raw = element?.customData?.aiImageMimeType
    return typeof raw === 'string' && raw ? raw : 'image/png'
  }, [])

  // ── Hook 1: Theme ────────────────────────────────────────────────────
  const theme = useCanvexTheme({ canvasWrapRef })

  // ── Hook 2: Canvas elements ──────────────────────────────────────────
  const canvasElements = useCanvasElements({
    canvexApiRef,
    canvasWrapRef,
    currentSceneRef,
  })

  // ── Hook 3: Scene persistence ────────────────────────────────────────
  const scenePersistence = useScenePersistence({
    sceneIdRef,
    currentSceneRef,
    lastSavedRef,
    pendingRef,
    saveTimerRef,
    localCacheTimerRef,
    workspaceKeyRef,
    saveInFlightRef,
    saveRerunRef,
    lastMutationAtRef,
    sceneSelectTokenRef,
    sceneHydrateTokenRef,
    canvexApiRef,
    lastPinnedIdRef,
    pinOriginRef,
    imagePlaceholderQueueRef,
    videoOverlayKeyRef,
    createPinnedImageRef,
    createPinnedVideoRef,
    searchParams,
    setSearchParams,
    syncCanvexTheme: theme.syncCanvexTheme,
    onVideoOverlayChange: useCallback((_items: VideoOverlayItem[]) => {
      // handled by video pipeline setVideoOverlayItems
    }, []),
    getRemoteImageUrlFromElement,
    getRemoteImageMimeType,
    loadImageDataUrl,
    getSceneElementsSafe: canvasElements.getSceneElementsSafe,
  })

  // ── Derived values ───────────────────────────────────────────────────
  const {
    scenes, activeSceneId, initialData, initialKey, loading, loadError,
    saveState, setSaveState, canvexReady, setCanvexReady,
    normalizeScenePayload, compactScenePayload, queueLocalCacheWrite, queueSave, queueUrgentSave,
    flushSave, hydrateSceneFiles, resolveVideoImageUrls,
    getChatKey, getPinLastKey, getPinOriginKey,
  } = scenePersistence

  const activeScene = useMemo(
    () => scenes.find((scene) => scene.id === activeSceneId) || null,
    [scenes, activeSceneId],
  )

  const isPregeneratedSpace = useMemo(() => {
    if (isPregeneratedKeyword(WORKSPACE_KEY)) return true
    return isPregeneratedKeyword(activeScene?.title)
  }, [activeScene?.title])

  const canShowAiEditBar = !!activeSceneId && !isPregeneratedSpace

  // ── Hook 4: Pinning ──────────────────────────────────────────────────
  const pinning = usePinning({
    sceneIdRef,
    canvexApiRef,
    currentSceneRef,
    pinOriginRef,
    lastPinnedIdRef,
    imagePlaceholderQueueRef,
    getPinLastKey,
    getPinOriginKey,
    getSceneElementsSafe: canvasElements.getSceneElementsSafe,
    createTextElement: canvasElements.createTextElement,
    createRectElement: canvasElements.createRectElement,
    measurePinnedText: canvasElements.measurePinnedText,
    wrapChatText: canvasElements.wrapChatText,
    findNonOverlappingPinPosition: canvasElements.findNonOverlappingPinPosition,
    getElementViewportRect: canvasElements.getElementViewportRect,
    removeElementsById: canvasElements.removeElementsById,
    captureSceneSnapshot: captureSceneSnapshotStable,
  })

  // ── Hook 5: Media library ────────────────────────────────────────────
  const mediaLibrary = useMediaLibrary({
    scenes,
    activeSceneId,
    createPinnedImageRef,
    createPinnedVideoRef,
  })

  // ── Ref for video overlay refresh (declared here so imageEdit can use it) ──
  const scheduleVideoOverlayRefreshRef = useRef<() => void>(() => {})
  const scheduleVideoOverlayRefreshStable = useCallback(() => scheduleVideoOverlayRefreshRef.current(), [])

  // ── Hook 6: Image edit pipeline ──────────────────────────────────────
  const imageEdit = useImageEditPipeline({
    sceneIdRef,
    canvexApiRef,
    createPinnedImageRef,
    recoveredImageEditScenesRef,
    imagePollInFlightRef,
    getSceneElementsSafe: canvasElements.getSceneElementsSafe,
    getSelectedElementsByIds: canvasElements.getSelectedElementsByIds,
    getSelectionBounds: canvasElements.getSelectionBounds,
    getSceneRectViewportRect: canvasElements.getSceneRectViewportRect,
    createRectElement: canvasElements.createRectElement,
    createTextElement: canvasElements.createTextElement,
    createImageElement: canvasElements.createImageElement,
    findNonOverlappingPinPosition: canvasElements.findNonOverlappingPinPosition,
    flashPinnedElement: pinning.flashPinnedElement,
    loadImageDataUrl,
    removeElementsById: canvasElements.removeElementsById,
    updatePlaceholderText: pinning.updatePlaceholderText,
    updatePlaceholderMeta: pinning.updatePlaceholderMeta,
    captureSceneSnapshot: captureSceneSnapshotStable,
    queueUrgentSave,
    isVideoElement: theme.isVideoElement,
    scheduleVideoOverlayRefresh: scheduleVideoOverlayRefreshStable,
    canShowAiEditBar,
  })

  // ── Hook 7: Video pipeline ───────────────────────────────────────────
  const videoPipeline = useVideoPipeline({
    sceneIdRef,
    canvexApiRef,
    videoOverlayKeyRef,
    createPinnedVideoRef,
    recoveredVideoScenesRef,
    videoPollInFlightRef,
    videoEditSelectionByJobRef,
    pinOriginRef,
    getSceneElementsSafe: canvasElements.getSceneElementsSafe,
    getSelectedElementsByIds: canvasElements.getSelectedElementsByIds,
    createImageElement: canvasElements.createImageElement,
    findNonOverlappingPinPosition: canvasElements.findNonOverlappingPinPosition,
    flashPinnedElement: pinning.flashPinnedElement,
    loadImageDataUrl,
    removeElementsById: canvasElements.removeElementsById,
    createImagePlaceholder: pinning.createImagePlaceholder,
    updatePlaceholderText: pinning.updatePlaceholderText,
    updatePlaceholderMeta: pinning.updatePlaceholderMeta,
    captureSceneSnapshot: captureSceneSnapshotStable,
    queueUrgentSave,
    resolveVideoImageUrls,
    buildVideoPosterDataUrl: theme.buildVideoPosterDataUrl,
    persistLastPinnedForScene: pinning.persistLastPinnedForScene,
    persistPinOriginForScene: pinning.persistPinOriginForScene,
    selectedEditKey: imageEdit.selectedEditKey,
    selectedEditIds: imageEdit.selectedEditIds,
    imageEditPrompt: imageEdit.imageEditPrompt,
    setImageEditError: imageEdit.setImageEditError,
  })

  // Wire up scheduleVideoOverlayRefresh ref
  scheduleVideoOverlayRefreshRef.current = videoPipeline.scheduleVideoOverlayRefresh

  // ── Hook 8: Chat ─────────────────────────────────────────────────────
  const chat = useChat({
    sceneIdRef,
    currentSceneRef,
    pendingRef,
    canvexApiRef,
    chatLoadTokenRef,
    chatAbortControllersRef,
    chatInterruptedScenesRef,
    activeSceneId,
    getChatKey,
    flushSave,
    queueUrgentSave,
    getSelectedElementsByIds: canvasElements.getSelectedElementsByIds,
    resolveVideoImageUrls,
    createPinnedNote: pinning.createPinnedNote,
    updatePinnedNoteText: pinning.updatePinnedNoteText,
    createPinnedImage: imageEdit.createPinnedImage,
    createPinnedVideo: videoPipeline.createPinnedVideo,
    createImagePlaceholder: pinning.createImagePlaceholder,
    enqueueImagePlaceholder: pinning.enqueueImagePlaceholder,
    takeNextImagePlaceholder: pinning.takeNextImagePlaceholder,
    markPendingPlaceholdersFailed: pinning.markPendingPlaceholdersFailed,
    updatePlaceholderText: pinning.updatePlaceholderText,
    removeElementsById: canvasElements.removeElementsById,
    insertMermaidFlowchartToCanvas: pinning.insertMermaidFlowchartToCanvas,
    toErrorLabel: imageEdit.toErrorLabel,
    toVideoFailureLabel: videoPipeline.toVideoFailureLabel,
  })

  // ── handleChange & captureSceneSnapshot (main component) ─────────────
  const handleChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      // Use lightweight compactScenePayload instead of normalizeScenePayload
      // to avoid expensive serializeAsJSON on every interaction.
      // The full normalization + fingerprint check happens in flushSave.
      const scene = compactScenePayload({
        elements: elements as any[],
        appState: sanitizeAppState(appState),
        files,
      })
      const nextVideos: VideoOverlayItem[] = []
      for (const element of (elements || []) as any[]) {
        if (!element || element.isDeleted) continue
        const url = element?.customData?.aiVideoUrl
        if (typeof url === 'string' && url) {
          const rawThumb = element?.customData?.aiVideoThumbnailUrl
          const thumbnailUrl = typeof rawThumb === 'string' && /^https?:\/\//.test(rawThumb) ? rawThumb : null
          nextVideos.push({ id: String(element.id), url, thumbnailUrl })
        }
      }
      const nextKey = nextVideos.map((item) => `${item.id}:${item.url}:${item.thumbnailUrl || ''}`).join('|')
      if (nextKey !== videoOverlayKeyRef.current) {
        videoOverlayKeyRef.current = nextKey
        videoPipeline.setVideoOverlayItems(nextVideos)
      }
      currentSceneRef.current = scene
      pendingRef.current = scene

      // Lightweight change detection: element version sum + count + file count.
      // Avoids expensive serializeAsJSON; flushSave does the full fingerprint.
      let versionSum = 0
      for (let i = 0; i < elements.length; i++) {
        versionSum += (elements[i] as any)?.version || 0
      }
      const fileCount = files ? Object.keys(files).length : 0
      const quickHash = `${elements.length}:${versionSum}:${fileCount}`
      const changed = quickHash !== handleChangeHashRef.current
      handleChangeHashRef.current = quickHash

      if (changed) {
        queueLocalCacheWrite()
        if (!lastPinnedIdRef.current) {
          const { latest } = getLatestElements(elements as any[])
          if (latest?.id) {
            lastPinnedIdRef.current = latest.id
            pinning.setLastPinnedId(latest.id)
          }
        }
        lastMutationAtRef.current = Date.now()
        setSaveState('pending')
        queueSave()
      }
      theme.syncCanvexTheme(appState?.theme)
      imageEdit.updateSelectedEditSelection(appState)

      // Update selected element pixel size overlay
      const selectedIds = appState?.selectedElementIds || {}
      const selIds = Object.keys(selectedIds).filter((key) => selectedIds[key])
      let nextInfo: typeof selectedElementInfoRef.current = null
      if (selIds.length === 1) {
        const el = (elements || []).find((item: any) => item && String(item.id) === selIds[0] && !item.isDeleted)
        if (el && el.type === 'image') {
          const isVideo = theme.isVideoElement(el)
          const rect = canvasElements.getElementViewportRect(el, appState)
          if (rect) {
            nextInfo = {
              type: isVideo ? 'video' : 'image',
              width: Math.round(el.width),
              height: Math.round(el.height),
              viewportRect: rect,
            }
          }
        }
      }
      const prev = selectedElementInfoRef.current
      const same = prev === nextInfo || (
        prev && nextInfo
        && prev.type === nextInfo.type
        && prev.width === nextInfo.width
        && prev.height === nextInfo.height
        && Math.abs(prev.viewportRect.x - nextInfo.viewportRect.x) < 0.5
        && Math.abs(prev.viewportRect.y - nextInfo.viewportRect.y) < 0.5
        && Math.abs(prev.viewportRect.width - nextInfo.viewportRect.width) < 0.5
        && Math.abs(prev.viewportRect.height - nextInfo.viewportRect.height) < 0.5
      )
      if (!same) setSelectedElementInfo(nextInfo)
    },
    [compactScenePayload, queueLocalCacheWrite, queueSave, theme.syncCanvexTheme, imageEdit.updateSelectedEditSelection, setSaveState, pinning.setLastPinnedId, videoPipeline.setVideoOverlayItems, canvasElements.getElementViewportRect, theme.isVideoElement],
  )

  const captureSceneSnapshot = useCallback(() => {
    const api = canvexApiRef.current
    if (!api?.getSceneElements || !api?.getAppState || !api?.getFiles) return
    const appState = api.getAppState()
    const { normalized: scene, fingerprint } = normalizeScenePayload({
      elements: api.getSceneElements(),
      appState: sanitizeAppState(appState),
      files: api.getFiles(),
    })
    currentSceneRef.current = scene
    pendingRef.current = scene
    queueLocalCacheWrite()
    if (fingerprint === lastSavedRef.current) {
      setSaveState('saved')
    } else {
      lastMutationAtRef.current = Date.now()
      setSaveState('pending')
      queueSave()
    }
    theme.syncCanvexTheme(appState?.theme)
    imageEdit.updateSelectedEditSelection(appState)
  }, [normalizeScenePayload, queueLocalCacheWrite, queueSave, theme.syncCanvexTheme, imageEdit.updateSelectedEditSelection, setSaveState])

  // Assign ref so hooks can call captureSceneSnapshot
  captureSceneSnapshotRef.current = captureSceneSnapshot

  // ── Derived UI state ─────────────────────────────────────────────────
  const saveStatusMeta = useMemo(() => {
    if (loading || loadError) return null
    if (saveState === 'saving') return { label: t('saveSaving', { defaultValue: 'Saving…' }), tone: 'warn' as const }
    if (saveState === 'pending') return { label: t('savePending', { defaultValue: 'Unsaved changes' }), tone: 'warn' as const }
    if (saveState === 'error') return { label: t('saveFailed', { defaultValue: 'Save failed' }), tone: 'error' as const }
    if (!activeSceneId) return { label: t('saveDraft', { defaultValue: 'Draft · local only' }), tone: 'muted' as const }
    if (saveState === 'saved') return { label: t('saveSaved', { defaultValue: 'Saved' }), tone: 'muted' as const }
    return null
  }, [activeSceneId, loadError, loading, saveState, t])

  const canvexLangCode = useMemo(() => {
    const code = (i18n.language || 'en').toLowerCase()
    return code.startsWith('zh') ? 'zh-CN' : 'en'
  }, [i18n.language])

  const imageEditStyle = useMemo(() => {
    if (!canShowAiEditBar || !imageEdit.selectedEditRect) return null
    return {
      left: Math.max(8, imageEdit.selectedEditRect.x),
      top: Math.max(8, imageEdit.selectedEditRect.y - 44),
    }
  }, [canShowAiEditBar, imageEdit.selectedEditRect])

  const previewFloatingStyle = useMemo(() => {
    if (!imageEdit.previewAnchor || typeof window === 'undefined') return null
    const size = 192
    const padding = 12
    let left = imageEdit.previewAnchor.x
    let top = imageEdit.previewAnchor.y - size - padding
    if (top < 8) top = imageEdit.previewAnchor.y + imageEdit.previewAnchor.height + padding
    if (left + size > window.innerWidth - 8) left = Math.max(8, window.innerWidth - size - 8)
    return { left, top }
  }, [imageEdit.previewAnchor])

  const isEditingSelected = useMemo(() => {
    if (!imageEdit.selectedEditKey) return false
    return imageEdit.imageEditPendingIds.includes(imageEdit.selectedEditKey)
  }, [imageEdit.imageEditPendingIds, imageEdit.selectedEditKey])

  // ── Effects ──────────────────────────────────────────────────────────

  // Save status width CSS variable
  useLayoutEffect(() => {
    const host = canvasWrapRef.current
    if (!host) return
    const root = document.documentElement
    const el = saveStatusRef.current
    if (!el) {
      host.style.setProperty('--save-status-width', '0px')
      host.style.setProperty('--save-status-gap', '0px')
      root.style.setProperty('--save-status-width', '0px')
      root.style.setProperty('--save-status-gap', '0px')
      return
    }
    const update = () => {
      const width = Math.ceil(el.getBoundingClientRect().width)
      host.style.setProperty('--save-status-width', `${width}px`)
      host.style.setProperty('--save-status-gap', '0.5rem')
      root.style.setProperty('--save-status-width', `${width}px`)
      root.style.setProperty('--save-status-gap', '0.5rem')
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [saveStatusMeta?.label, saveStatusMeta?.tone])

  // Scroll-back button positioning
  useEffect(() => {
    const host = canvasWrapRef.current
    if (!host) return
    let raf = 0
    const positionScrollBackButton = () => {
      const zoomActions = host.querySelector('.zoom-actions') as HTMLElement | null
      const scrollBack = host.querySelector('.scroll-back-to-content') as HTMLElement | null
      if (!zoomActions || !scrollBack) return
      const rect = zoomActions.getBoundingClientRect()
      const left = rect.right + 8
      const top = rect.top + rect.height / 2
      scrollBack.classList.add('scroll-back-to-content--inline')
      scrollBack.style.position = 'fixed'
      scrollBack.style.left = `${left}px`
      scrollBack.style.top = `${top}px`
      scrollBack.style.transform = 'translateY(-50%)'
      scrollBack.style.zIndex = '30'
      scrollBack.style.right = 'auto'
      scrollBack.style.bottom = 'auto'
      scrollBack.style.width = 'max-content'
      scrollBack.style.maxWidth = 'none'
      scrollBack.style.whiteSpace = 'nowrap'
      scrollBack.style.display = 'inline-flex'
      scrollBack.style.alignItems = 'center'
      scrollBack.style.justifyContent = 'center'
    }
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(positionScrollBackButton)
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(host, { childList: true, subtree: true })
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(host)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // Load chat/pin when scene changes
  useEffect(() => {
    void chat.loadChatForScene(activeSceneId)
    chat.setChatInput('')
    pinning.loadPinOriginForScene(activeSceneId)
    pinning.loadLastPinnedForScene(activeSceneId)
  }, [activeSceneId, chat.loadChatForScene, pinning.loadLastPinnedForScene, pinning.loadPinOriginForScene])

  // (Reset edit prompt and scroll cleanup are handled inside useImageEditPipeline)

  // Reset recovered scenes on active scene change
  useEffect(() => {
    recoveredVideoScenesRef.current = {}
    recoveredImageEditScenesRef.current = {}
  }, [activeSceneId])

  // Scene sync backlog (recover jobs, reload chat)
  useEffect(() => {
    if (!activeSceneId || loading || loadError || !canvexReady) return
    let cancelled = false
    const intervalMsEnv = Number(import.meta.env.VITE_SCENE_SYNC_INTERVAL_MS ?? 5000)
    const intervalMs = Number.isFinite(intervalMsEnv) && intervalMsEnv > 0 ? Math.floor(intervalMsEnv) : 5000
    const syncSceneBacklog = () => {
      if (cancelled) return
      void chat.loadChatForScene(activeSceneId)
      recoveredVideoScenesRef.current[activeSceneId] = false
      recoveredImageEditScenesRef.current[activeSceneId] = false
      void videoPipeline.recoverVideoJobsForScene(activeSceneId)
      void imageEdit.recoverImageEditJobsForScene(activeSceneId)
    }
    syncSceneBacklog()
    const timer = window.setInterval(syncSceneBacklog, intervalMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [activeSceneId, canvexReady, chat.loadChatForScene, loadError, loading, imageEdit.recoverImageEditJobsForScene, videoPipeline.recoverVideoJobsForScene])


  // ── JSX ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-1 flex-col min-h-0">
      {canShowAiEditBar && imageEdit.selectedEditPreview && imageEdit.previewAnchor && previewFloatingStyle && (
        <div
          className="pointer-events-none fixed z-[60]"
          style={{ left: previewFloatingStyle.left, top: previewFloatingStyle.top }}
        >
          <div className="rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur">
            <img
              src={imageEdit.selectedEditPreview}
              alt={t('editPreviewAlt', { defaultValue: 'Selection preview' })}
              className="h-48 w-48 object-contain"
            />
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0 px-0 pb-0 pt-0">
        <div className="flex flex-1 min-h-0">
          <div ref={canvasWrapRef} className="canvex-host relative isolate h-full min-h-[calc(100vh-180px)] w-full overflow-visible rounded-xl border bg-background shadow-sm">
            {loading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <IconLoader className="mr-2 size-5 animate-spin" />
                {t('loading', { defaultValue: 'Loading…' })}
              </div>
            ) : loadError ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <IconAlertTriangle className="mr-2 size-5" />
                {loadError}
              </div>
            ) : (
              <Excalidraw
                key={initialKey}
                name="Canvex"
                initialData={initialData || undefined}
                onChange={handleChange}
                langCode={canvexLangCode}
                validateEmbeddable={true}
                excalidrawAPI={(api) => {
                  canvexApiRef.current = api
                  setCanvexReady(Boolean(api))
                  const state = api?.getAppState?.()
                  theme.syncCanvexTheme(state?.theme)
                  if (api && initialData) {
                    void hydrateSceneFiles(initialData, api)
                  }
                  if (imageEdit.scrollUnsubRef.current) {
                    imageEdit.scrollUnsubRef.current()
                    imageEdit.scrollUnsubRef.current = null
                  }
                  if (api?.onScrollChange) {
                    imageEdit.scrollUnsubRef.current = api.onScrollChange(() => {
                      imageEdit.updateSelectedEditSelection()
                    })
                  }
                  imageEdit.updateSelectedEditSelection()
                }}
              >
                <DefaultSidebar.Trigger
                  tab="canvex-media"
                  title={t('mediaLibraryTitle', { defaultValue: '媒体素材库' })}
                  aria-label={t('mediaLibraryTitle', { defaultValue: '媒体素材库' })}
                  icon={<IconPhoto size={14} />}
                />
                <DefaultSidebar
                  className="canvex-media-sidebar"
                  onStateChange={(state) => {
                    mediaLibrary.setMediaSidebarOpen(Boolean(
                      state && state.name === 'default' && state.tab === 'canvex-media',
                    ))
                  }}
                >
                  <DefaultSidebar.TabTriggers>
                    <Sidebar.TabTrigger
                      tab="canvex-media"
                      title={t('mediaLibraryTitle', { defaultValue: '媒体素材库' })}
                      aria-label={t('mediaLibraryTitle', { defaultValue: '媒体素材库' })}
                    >
                      <IconPhoto size={13} />
                    </Sidebar.TabTrigger>
                  </DefaultSidebar.TabTriggers>
                  <Sidebar.Tab tab="canvex-media">
                    <div className="canvex-media-sidebar__panel">
                      <div className="canvex-media-sidebar__header">
                        <div className="canvex-media-sidebar__title">
                          <span>{t('mediaLibraryTitle', { defaultValue: '媒体素材库' })}</span>
                        </div>
                        <button
                          type="button"
                          className="canvex-media-sidebar__refresh"
                          title={t('common:refresh', { defaultValue: '刷新' })}
                          onClick={() => mediaLibrary.refreshMediaLibrary()}
                          disabled={mediaLibrary.mediaLibraryLoading}
                        >
                          {mediaLibrary.mediaLibraryLoading ? (
                            <IconLoader className="size-4 animate-spin" />
                          ) : (
                            <IconRefresh className="size-4" />
                          )}
                        </button>
                      </div>
                      {mediaLibrary.mediaLibraryError && (
                        <div className="canvex-media-sidebar__error">{mediaLibrary.mediaLibraryError}</div>
                      )}
                      {mediaLibrary.mediaLibraryLoading && !mediaLibrary.mediaProjectFolders.length ? (
                        <div className="canvex-media-sidebar__loading">
                          <IconLoader className="size-4 animate-spin" />
                        </div>
                      ) : mediaLibrary.mediaProjectFolders.length > 0 ? (
                        <div className="canvex-media-folder-list">
                          {mediaLibrary.mediaProjectFolders.map((folder) => {
                            const folderOpen = Boolean(mediaLibrary.mediaFolderOpenByKey[folder.key])
                            const materialCount = folder.images.length + folder.videos.length
                            return (
                              <div key={folder.key} className="canvex-media-folder">
                                <button
                                  type="button"
                                  className="canvex-media-folder__trigger"
                                  onClick={() => mediaLibrary.toggleMediaProjectFolder(folder.key)}
                                >
                                  <span className={`canvex-media-folder__chevron ${folderOpen ? 'is-open' : ''}`}>
                                    <IconChevronRight size={13} />
                                  </span>
                                  <IconFolder size={13} />
                                  <span className="canvex-media-folder__name">{folder.projectName}</span>
                                  <span className="canvex-media-folder__count">{materialCount}</span>
                                </button>
                                {folderOpen && (
                                  <div className="canvex-media-folder__content">
                                    {folder.images.length > 0 && (
                                      <div className="canvex-media-section">
                                        {(() => {
                                          const imageSectionKey = `${folder.key}:image`
                                          const imageOpen = mediaLibrary.mediaTypeOpenByKey[imageSectionKey] ?? true
                                          return (
                                            <>
                                              <button
                                                type="button"
                                                className="canvex-media-section__trigger"
                                                onClick={() => mediaLibrary.toggleMediaTypeSection(imageSectionKey)}
                                              >
                                                <span className="canvex-media-section__label">
                                                  <span className={`canvex-media-folder__chevron ${imageOpen ? 'is-open' : ''}`}>
                                                    <IconChevronRight size={12} />
                                                  </span>
                                                  <IconPhoto size={12} />
                                                  <span>{t('mediaLibraryImageTab', { defaultValue: '图片' })}</span>
                                                  <span className="canvex-media-section__count">{folder.images.length}</span>
                                                </span>
                                              </button>
                                              {imageOpen && (
                                                <div className="canvex-media-grid">
                                                  {folder.images.map((item) => (
                                                    <button
                                                      key={`${item.id}-${item.url}`}
                                                      type="button"
                                                      className="canvex-media-item"
                                                      onClick={() => void mediaLibrary.insertImageFromMediaLibrary(item)}
                                                    >
                                                      <div className="canvex-media-item__preview">
                                                        <img
                                                          src={item.url}
                                                          alt={item.filename || t('mediaLibraryImageAlt', { defaultValue: '媒体图片' })}
                                                          className="canvex-media-item__thumb"
                                                        />
                                                      </div>
                                                      <div className="canvex-media-item__meta">{item.filename || item.id}</div>
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </>
                                          )
                                        })()}
                                      </div>
                                    )}
                                    {folder.videos.length > 0 && (
                                      <div className="canvex-media-section">
                                        {(() => {
                                          const videoSectionKey = `${folder.key}:video`
                                          const videoOpen = mediaLibrary.mediaTypeOpenByKey[videoSectionKey] ?? true
                                          return (
                                            <>
                                              <button
                                                type="button"
                                                className="canvex-media-section__trigger"
                                                onClick={() => mediaLibrary.toggleMediaTypeSection(videoSectionKey)}
                                              >
                                                <span className="canvex-media-section__label">
                                                  <span className={`canvex-media-folder__chevron ${videoOpen ? 'is-open' : ''}`}>
                                                    <IconChevronRight size={12} />
                                                  </span>
                                                  <IconVideo size={12} />
                                                  <span>{t('mediaLibraryVideoTab', { defaultValue: '视频' })}</span>
                                                  <span className="canvex-media-section__count">{folder.videos.length}</span>
                                                </span>
                                              </button>
                                              {videoOpen && (
                                                <div className="canvex-media-grid">
                                                  {folder.videos.map((item) => (
                                                    <button
                                                      key={`${item.id}-${item.url}`}
                                                      type="button"
                                                      className="canvex-media-item"
                                                      onClick={() => void mediaLibrary.insertVideoFromMediaLibrary(item)}
                                                    >
                                                      <div className="canvex-media-item__preview">
                                                        {item.thumbnailUrl ? (
                                                          <img
                                                            src={item.thumbnailUrl}
                                                            alt={t('mediaLibraryVideoAlt', { defaultValue: '视频封面' })}
                                                            className="canvex-media-item__thumb"
                                                          />
                                                        ) : (
                                                          <div className="canvex-media-item__thumb-placeholder">
                                                            <IconVideo size={18} />
                                                          </div>
                                                        )}
                                                        <span className="canvex-media-item__badge">VIDEO</span>
                                                      </div>
                                                      <div className="canvex-media-item__meta">{item.taskId || item.id}</div>
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </>
                                          )
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="canvex-media-sidebar__empty">
                          {t('mediaLibraryEmpty', { defaultValue: '暂无媒体素材。' })}
                        </div>
                      )}
                    </div>
                  </Sidebar.Tab>
                </DefaultSidebar>
                <MainMenu>
                  <MainMenu.DefaultItems.LoadScene />
                  <MainMenu.DefaultItems.SaveToActiveFile />
                  <MainMenu.DefaultItems.SaveAsImage />
                  <MainMenu.DefaultItems.Export />
                  <MainMenu.DefaultItems.CommandPalette />
                  <MainMenu.DefaultItems.SearchMenu />
                  <MainMenu.DefaultItems.ClearCanvas />
                  <MainMenu.DefaultItems.ChangeCanvasBackground />
                  <MainMenu.DefaultItems.ToggleTheme />
                  <MainMenu.DefaultItems.Help />
                </MainMenu>
              </Excalidraw>
            )}

            {/* Video overlays */}
            {!loading && !loadError && videoPipeline.videoOverlayItems.length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-30">
                {videoPipeline.videoOverlayItems.map((item) => {
                  const api = canvexApiRef.current
                  const element = api?.getSceneElements?.().find((el: any) => el?.id === item.id && !el?.isDeleted)
                  if (!element) return null
                  const rect = canvasElements.getElementViewportRect(element)
                  if (!rect) return null
                  return (
                    <div
                      key={item.id}
                      className="canvex-video-overlay-item absolute"
                      style={{ pointerEvents: 'none', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
                    >
                      {videoPipeline.activeVideoId === item.id ? (
                        <div
                          className="pointer-events-auto absolute inset-0"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <video
                            className="h-full w-full rounded-md border border-border/60 bg-black object-cover shadow-sm"
                            src={item.url}
                            poster={item.thumbnailUrl || theme.buildVideoPosterDataUrl()}
                            controls autoPlay preload="metadata" playsInline
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white shadow-sm"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); videoPipeline.setActiveVideoId(null) }}
                          >
                            {t('common:close', { defaultValue: 'Close' })}
                          </button>
                        </div>
                      ) : (
                        <>
                          <video
                            className="canvex-video-overlay-media h-full w-full rounded-md border border-border/60 bg-black object-cover shadow-sm"
                            src={item.url}
                            poster={item.thumbnailUrl || theme.buildVideoPosterDataUrl()}
                            style={{ pointerEvents: 'none' }}
                            preload="metadata" playsInline muted
                          />
                          <button
                            type="button"
                            aria-label={t('playVideo', { defaultValue: 'Play video' })}
                            className="pointer-events-auto absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition hover:bg-black/70"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); videoPipeline.setActiveVideoId(item.id) }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                              <path d="M8 5.5v13l11-6.5-11-6.5z" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pixel size overlay for selected image/video */}
            {selectedElementInfo && (
              <div
                className="pointer-events-none absolute z-40 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-[11px] font-medium text-white shadow-sm"
                style={{
                  left: selectedElementInfo.viewportRect.x + selectedElementInfo.viewportRect.width / 2,
                  top: selectedElementInfo.viewportRect.y + selectedElementInfo.viewportRect.height + 6,
                  transform: 'translateX(-50%)',
                }}
              >
                {selectedElementInfo.type === 'video' ? (
                  <IconVideo size={14} stroke={1.5} />
                ) : (
                  <IconPhoto size={14} stroke={1.5} />
                )}
                <span>{selectedElementInfo.width} x {selectedElementInfo.height}</span>
              </div>
            )}

            {/* Image edit toolbar */}
            {canShowAiEditBar && imageEdit.selectedEditKey && imageEdit.selectedEditRect && imageEditStyle && (
              <div
                className="absolute z-50 flex flex-col gap-1"
                style={imageEditStyle}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 rounded-lg border bg-background/95 px-2 py-2 shadow-md backdrop-blur">
                  <div
                    className="relative"
                    onMouseEnter={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      imageEdit.setPreviewAnchor({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
                    }}
                    onMouseMove={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      imageEdit.setPreviewAnchor({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
                    }}
                    onMouseLeave={() => imageEdit.setPreviewAnchor(null)}
                  >
                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border bg-muted">
                      {imageEdit.selectedEditPreview ? (
                        <img
                          src={imageEdit.selectedEditPreview}
                          alt={t('editPreviewAlt', { defaultValue: 'Selection preview' })}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="text-[10px] text-muted-foreground">
                          {t('editPreviewLabel', { defaultValue: 'Preview' })}
                        </span>
                      )}
                    </div>
                  </div>
                  <input
                    value={imageEdit.imageEditPrompt}
                    onChange={(e) => {
                      imageEdit.setImageEditPrompt(e.target.value)
                      if (imageEdit.imageEditError) imageEdit.setImageEditError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void imageEdit.handleImageEdit()
                      }
                    }}
                    placeholder={t('editPromptPlaceholder', { defaultValue: 'Describe edits…' })}
                    className="h-8 w-56 rounded-md border px-2 text-xs outline-none"
                    disabled={isEditingSelected}
                  />
                  <Button
                    type="button" size="sm" variant="outline"
                    onClick={() => void imageEdit.handleImageEdit({ cutout: true })}
                    disabled={isEditingSelected}
                  >
                    {t('editCutout', { defaultValue: 'Cutout' })}
                  </Button>
                  <div className="flex items-center">
                    <select
                      value={imageEdit.imageEditSize}
                      onChange={(e) => {
                        imageEdit.setImageEditSize(e.target.value)
                        if (imageEdit.imageEditError) imageEdit.setImageEditError(null)
                      }}
                      className="h-8 w-24 rounded-md border px-2 text-xs outline-none"
                      disabled={isEditingSelected}
                    >
                      <option value="">{t('editSizeAuto', { defaultValue: 'Auto' })}</option>
                      {IMAGE_EDIT_SIZE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center">
                    <select
                      value={String(imageEdit.imageEditCount)}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10)
                        imageEdit.setImageEditCount(Number.isNaN(value) ? 1 : value)
                        if (imageEdit.imageEditError) imageEdit.setImageEditError(null)
                      }}
                      className="h-8 w-16 rounded-md border px-2 text-xs outline-none"
                      disabled={isEditingSelected}
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="4">4</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button" size="sm" variant="outline"
                      onClick={() => void videoPipeline.handleVideoGenerate()}
                      disabled={isEditingSelected}
                    >
                      {videoPipeline.isVideoGeneratingSelected
                        ? t('editVideoContinue', { defaultValue: 'Generate Another' })
                        : t('editVideo', { defaultValue: 'Generate Video' })}
                    </Button>
                    {videoPipeline.videoEditStatus && (
                      <span className={`text-[11px] ${videoPipeline.videoEditStatusTone}`}>
                        {videoPipeline.videoEditStatus}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void imageEdit.handleImageEdit()}
                    disabled={isEditingSelected}
                  >
                    {isEditingSelected
                      ? t('editWorking', { defaultValue: 'Editing…' })
                      : t('editApply', { defaultValue: 'Apply' })}
                  </Button>
                </div>
                {imageEdit.imageEditError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive shadow-sm">
                    {imageEdit.imageEditError}
                  </div>
                )}
                {videoPipeline.videoEditError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive shadow-sm">
                    {videoPipeline.toVideoFailureLabel(videoPipeline.videoEditError)}
                  </div>
                )}
              </div>
            )}

            {/* Pin flash indicator */}
            {pinning.pinFlashRect && (
              <div
                className="pointer-events-none absolute z-40 rounded-md ring-2 ring-primary/50 animate-pulse"
                style={{
                  left: pinning.pinFlashRect.x,
                  top: pinning.pinFlashRect.y,
                  width: pinning.pinFlashRect.width,
                  height: pinning.pinFlashRect.height,
                }}
              />
            )}

            {/* Save status */}
            {saveStatusMeta && (
              <div className="pointer-events-none absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-40">
                <div
                  ref={saveStatusRef}
                  className={`pointer-events-auto rounded-full border px-3 py-1 text-[11px] shadow-sm backdrop-blur ${
                    saveStatusMeta.tone === 'error'
                      ? 'border-destructive/30 bg-destructive/10 text-destructive'
                      : saveStatusMeta.tone === 'warn'
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-border/60 bg-background/90 text-muted-foreground'
                  }`}
                >
                  {saveStatusMeta.label}
                </div>
              </div>
            )}

            {/* Back to latest button */}
            {pinning.lastPinnedId && (
              <div className="pointer-events-none absolute left-28 bottom-[63px] z-40">
                <Button
                  type="button" size="icon" variant="ghost"
                  className="canvex-back-to-latest pointer-events-auto size-8 rounded-full shadow-none"
                  onClick={() => pinning.jumpToLatestPinned(activeSceneId)}
                  title={t('backToLatest', { defaultValue: 'Back to latest element' })}
                >
                  <IconHistory className="size-5" />
                </Button>
              </div>
            )}

            {/* Chat input */}
            {!loading && !loadError && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
                <form
                  className="pointer-events-auto w-full max-w-xl"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (chat.chatLoading) chat.stopMessage()
                    else chat.sendMessage()
                  }}
                >
                  {(chat.chatLoading || chat.chatStatus !== 'idle') && (
                    <div
                      className={`mb-2 flex items-center gap-1.5 text-xs transition-all duration-300 ${
                        chat.chatStatus === 'exiting'
                          ? 'translate-y-2 opacity-0'
                          : 'translate-y-0 opacity-100'
                      } ${
                        chat.chatLoading
                          ? 'text-muted-foreground'
                          : (chat.chatStatus === 'success' || chat.exitingStatus === 'success')
                            ? 'text-green-600 dark:text-green-400'
                            : (chat.chatStatus === 'interrupted' || chat.exitingStatus === 'interrupted')
                              ? 'text-amber-600 dark:text-amber-400'
                              : (chat.chatStatus === 'error' || chat.exitingStatus === 'error')
                                ? 'text-red-500 dark:text-red-400'
                                : 'text-muted-foreground'
                      }`}
                    >
                      {chat.chatLoading ? (
                        <>
                          <IconLoader className="size-3 animate-spin" />
                          <span>{t('aiThinking', { defaultValue: '思考中...' })}</span>
                        </>
                      ) : (chat.chatStatus === 'success' || (chat.chatStatus === 'exiting' && chat.exitingStatus === 'success')) ? (
                        <>
                          <IconCheck className="size-3" />
                          <span>{t('aiCompleted', { defaultValue: '已回复', time: chat.chatElapsedTime })}</span>
                        </>
                      ) : (chat.chatStatus === 'interrupted' || (chat.chatStatus === 'exiting' && chat.exitingStatus === 'interrupted')) ? (
                        <>
                          <IconX className="size-3" />
                          <span>{t('aiInterrupted', { defaultValue: '已中断' })}</span>
                        </>
                      ) : (
                        <>
                          <IconX className="size-3" />
                          <span>{t('aiFailed', { defaultValue: '回复失败' })}</span>
                        </>
                      )}
                    </div>
                  )}
                  <div className="relative flex items-center">
                    <textarea
                      value={chat.chatInput}
                      onChange={(e) => chat.setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (chat.chatLoading) chat.stopMessage()
                          else chat.sendMessage()
                        }
                      }}
                      placeholder={t('aiPlaceholder')}
                      className="min-h-[42px] w-full resize-none rounded-xl border bg-background/95 px-4 py-2.5 pr-11 text-sm shadow-lg backdrop-blur outline-none transition-all duration-200 placeholder:text-muted-foreground/50 hover:border-border focus:border-primary/40 focus:shadow-[0_0_0_2px_hsl(var(--primary)/0.08)]"
                      rows={1}
                    />
                    <Button
                      type="submit" size="icon"
                      variant={chat.chatLoading ? 'secondary' : chat.chatInput.trim() ? 'default' : 'ghost'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 size-8 rounded-lg transition-all duration-150"
                      disabled={!chat.chatInput.trim() && !chat.chatLoading}
                      title={chat.chatLoading ? t('aiStop', { defaultValue: '中断' }) : t('aiSend', { defaultValue: '发送' })}
                      aria-label={chat.chatLoading ? t('aiStop', { defaultValue: '中断' }) : t('aiSend', { defaultValue: '发送' })}
                    >
                      <span className="relative size-4">
                        <IconMessage2
                          className={`absolute inset-0 size-4 transition-all duration-300 ${
                            chat.chatLoading ? 'opacity-0 scale-50' : 'opacity-100 scale-100'
                          }`}
                        />
                        {chat.loadingIcons.map((Icon, index) => (
                          <Icon
                            key={index}
                            className={`absolute inset-0 size-4 transition-all duration-300 ${
                              chat.chatLoading && chat.loadingIconIndex === index
                                ? 'opacity-100 scale-100'
                                : 'opacity-0 scale-75'
                            }`}
                          />
                        ))}
                      </span>
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
