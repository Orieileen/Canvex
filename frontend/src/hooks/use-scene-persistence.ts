import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { serializeAsJSON } from '@excalidraw/excalidraw'
import { toast } from 'sonner'
import { request } from '@/utils/request'
import type { SceneData, SceneRecord, LocalCache, VideoOverlayItem } from '@/types/canvex'
import {
  WORKSPACE_KEY,
  SCENE_SAVE_DEBOUNCE_MS,
  SCENE_SAVE_URGENT_MS,
  SCENE_SAVE_FORCE_FLUSH_MS,
  SCENE_SAVE_WATCH_INTERVAL_MS,
  SCENE_LOCAL_CACHE_DEBOUNCE_MS,
  MAX_CANVAS_IMAGE_DIM,
} from '@/constants/canvex'
import {
  toSceneSummary,
  sanitizeAppState,
  getLatestElements,
} from '@/utils/canvex'

export function useScenePersistence({
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
  pinOriginRef: _pinOriginRef,
  imagePlaceholderQueueRef: _imagePlaceholderQueueRef,
  videoOverlayKeyRef,
  createPinnedImageRef: _createPinnedImageRef,
  createPinnedVideoRef: _createPinnedVideoRef,
  searchParams,
  setSearchParams,
  syncCanvexTheme,
  onVideoOverlayChange,
  getRemoteImageUrlFromElement,
  getRemoteImageMimeType,
  loadImageDataUrl,
  getSceneElementsSafe,
  hasUnsavedChangesExternal: _hasUnsavedChangesExternal,
  getSceneFingerprintExternal: _getSceneFingerprintExternal,
}: {
  sceneIdRef: React.MutableRefObject<string | null>
  currentSceneRef: React.MutableRefObject<SceneData | null>
  lastSavedRef: React.MutableRefObject<string | null>
  pendingRef: React.MutableRefObject<SceneData | null>
  saveTimerRef: React.MutableRefObject<number | null>
  localCacheTimerRef: React.MutableRefObject<number | null>
  workspaceKeyRef: React.MutableRefObject<string>
  saveInFlightRef: React.MutableRefObject<boolean>
  saveRerunRef: React.MutableRefObject<boolean>
  lastMutationAtRef: React.MutableRefObject<number>
  sceneSelectTokenRef: React.MutableRefObject<number>
  sceneHydrateTokenRef: React.MutableRefObject<number>
  canvexApiRef: React.MutableRefObject<any>
  lastPinnedIdRef: React.MutableRefObject<string | null>
  pinOriginRef: React.MutableRefObject<any>
  imagePlaceholderQueueRef: React.MutableRefObject<any[]>
  videoOverlayKeyRef: React.MutableRefObject<string>
  createPinnedImageRef: React.MutableRefObject<any>
  createPinnedVideoRef: React.MutableRefObject<any>
  searchParams: URLSearchParams
  setSearchParams: (params: URLSearchParams, opts?: { replace?: boolean }) => void
  syncCanvexTheme: (theme?: string) => void
  onVideoOverlayChange: (items: VideoOverlayItem[]) => void
  getRemoteImageUrlFromElement: (element: any) => string
  getRemoteImageMimeType: (element: any) => string
  loadImageDataUrl: (url: string, maxDim?: number | null) => Promise<{ dataUrl: string; width: number | null; height: number | null }>
  getSceneElementsSafe: () => any[]
  hasUnsavedChangesExternal?: () => boolean
  getSceneFingerprintExternal?: (scene: SceneData) => string
}) {
  const { t, i18n } = useTranslation('canvex')
  const untitledRef = useRef('Untitled')
  const [scenes, setScenes] = useState<SceneRecord[]>([])
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const [initialData, setInitialData] = useState<SceneData | null>(null)
  const [initialKey, setInitialKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const [canvexReady, setCanvexReady] = useState(false)

  useEffect(() => {
    untitledRef.current = t('untitled', { defaultValue: 'Untitled' })
  }, [i18n.language, t])

  const sceneParam = searchParams.get('scene')

  // Stabilise searchParams behind a ref so updateSceneParam identity doesn't
  // change every render (URLSearchParams is a new object each time).
  const searchParamsRef = useRef(searchParams)
  searchParamsRef.current = searchParams

  const setSceneIdSafe = useCallback((id: string | null) => {
    sceneIdRef.current = id
    setActiveSceneId(id)
  }, [sceneIdRef])

  const updateSceneParam = useCallback((id: string | null, replace = true) => {
    const next = new URLSearchParams(searchParamsRef.current)
    if (id) {
      next.set('scene', id)
    } else {
      next.delete('scene')
    }
    setSearchParams(next, { replace })
  }, [setSearchParams])

  const getSceneKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:scene:${id || 'draft'}`,
    [workspaceKeyRef]
  )

  const getLastKey = useCallback(() => `${workspaceKeyRef.current}:last`, [workspaceKeyRef])

  const getChatKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat:${id || 'draft'}`,
    [workspaceKeyRef]
  )

  const getPinLastKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat-pin-last:${id || 'draft'}`,
    [workspaceKeyRef]
  )

  const getPinOriginKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat-pin-origin:${id || 'draft'}`,
    [workspaceKeyRef]
  )

  const writeLocalCache = useCallback(
    (sceneId: string | null, data: SceneData, updatedAt?: string | null) => {
      try {
        const payload: LocalCache = {
          sceneId,
          data,
          updatedAt: typeof updatedAt === 'string' && updatedAt
            ? updatedAt
            : new Date().toISOString(),
        }
        localStorage.setItem(getSceneKey(sceneId), JSON.stringify(payload))
      } catch {}
    },
    [getSceneKey]
  )

  const readLocalCache = useCallback(
    (sceneId: string | null): LocalCache | null => {
      try {
        const raw = localStorage.getItem(getSceneKey(sceneId))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed?.data) return parsed
        if (parsed && typeof parsed === 'object') return { data: parsed }
        return null
      } catch {
        return null
      }
    },
    [getSceneKey]
  )

  const clearLocalCache = useCallback((sceneId: string | null) => {
    try {
      localStorage.removeItem(getSceneKey(sceneId))
    } catch {}
  }, [getSceneKey])

  const flushLocalCacheWrite = useCallback((sceneId?: string | null, data?: SceneData | null) => {
    const nextSceneId = sceneId ?? sceneIdRef.current
    const nextData = data ?? currentSceneRef.current
    if (!nextData) return
    writeLocalCache(nextSceneId, nextData)
  }, [currentSceneRef, sceneIdRef, writeLocalCache])

  const queueLocalCacheWrite = useCallback(() => {
    if (localCacheTimerRef.current) {
      window.clearTimeout(localCacheTimerRef.current)
    }
    localCacheTimerRef.current = window.setTimeout(() => {
      localCacheTimerRef.current = null
      flushLocalCacheWrite()
    }, SCENE_LOCAL_CACHE_DEBOUNCE_MS)
  }, [flushLocalCacheWrite, localCacheTimerRef])

  const compactScenePayload = useCallback((scene?: SceneData | null): SceneData => {
    const baseElements = Array.isArray(scene?.elements) ? scene.elements : []
    const baseAppState = scene?.appState && typeof scene.appState === 'object'
      ? sanitizeAppState(scene.appState)
      : {}
    const baseFiles = scene?.files && typeof scene.files === 'object' ? scene.files : {}
    const referencedFileIds = new Set<string>()

    for (const element of baseElements) {
      if (!element || element.type !== 'image') continue
      if (typeof element.fileId !== 'string' || !element.fileId) continue
      referencedFileIds.add(element.fileId)
    }

    const files = Object.fromEntries(
      Object.entries(baseFiles).filter(([fileId]) => referencedFileIds.has(fileId))
    )

    return {
      elements: baseElements,
      appState: baseAppState,
      files,
    }
  }, [])

  const normalizeScenePayload = useCallback((scene?: SceneData | null): { normalized: SceneData; fingerprint: string } => {
    const compacted = compactScenePayload(scene)
    const baseElements = compacted.elements || []
    const baseAppState = compacted.appState || {}
    const baseFiles = compacted.files || {}

    try {
      const fingerprint = serializeAsJSON(baseElements, baseAppState, baseFiles, 'local')
      const parsed = JSON.parse(fingerprint)
      const normalized: SceneData = {
        elements: Array.isArray(parsed?.elements) ? parsed.elements : baseElements,
        appState: parsed?.appState && typeof parsed.appState === 'object' ? parsed.appState : baseAppState,
        files: parsed?.files && typeof parsed.files === 'object' ? parsed.files : baseFiles,
      }
      return { normalized, fingerprint }
    } catch {
      const normalized: SceneData = {
        elements: baseElements,
        appState: baseAppState,
        files: baseFiles,
      }
      return {
        normalized,
        fingerprint: JSON.stringify(normalized),
      }
    }
  }, [compactScenePayload])

  const getSceneFingerprint = useCallback((scene: SceneData) => {
    return normalizeScenePayload(scene).fingerprint
  }, [normalizeScenePayload])

  const applyScene = useCallback((scene?: SceneData | null) => {
    if (!scene) return
    sceneHydrateTokenRef.current += 1
    setInitialData(scene)
    setInitialKey((k) => k + 1)
    currentSceneRef.current = scene
    const nextVideos: VideoOverlayItem[] = []
    for (const element of scene.elements || []) {
      if (!element || element.isDeleted) continue
      const url = element?.customData?.aiVideoUrl
      if (typeof url === 'string' && url) {
        const rawThumb = element?.customData?.aiVideoThumbnailUrl
        const thumbnailUrl = typeof rawThumb === 'string' && /^https?:\/\//.test(rawThumb) ? rawThumb : null
        nextVideos.push({
          id: String(element.id),
          url,
          thumbnailUrl,
        })
      }
    }
    const nextKey = nextVideos.map((item) => `${item.id}:${item.url}:${item.thumbnailUrl || ''}`).join('|')
    if (nextKey !== videoOverlayKeyRef.current) {
      videoOverlayKeyRef.current = nextKey
      onVideoOverlayChange(nextVideos)
    }
    if (!lastPinnedIdRef.current) {
      const { latest } = getLatestElements(scene.elements || [])
      if (latest?.id) {
        lastPinnedIdRef.current = latest.id
      }
    }
    syncCanvexTheme(scene.appState?.theme)
  }, [currentSceneRef, lastPinnedIdRef, onVideoOverlayChange, sceneHydrateTokenRef, syncCanvexTheme, videoOverlayKeyRef])

  const persistSceneToList = useCallback((
    sceneId: string,
    title?: string,
    timestamps?: { createdAt?: string | null; updatedAt?: string | null },
  ) => {
    setScenes((prev) => {
      const existing = prev.find((scene) => scene.id === sceneId)
      const nextTitle = title ?? existing?.title ?? untitledRef.current
      const updated = {
        ...existing,
        id: sceneId,
        title: nextTitle,
        created_at: timestamps?.createdAt ?? existing?.created_at,
        updated_at: timestamps?.updatedAt ?? new Date().toISOString(),
      }
      const filtered = prev.filter((scene) => scene.id !== sceneId)
      return [updated as SceneRecord, ...filtered]
    })
  }, [])

  const hasUnsavedChanges = useCallback(() => {
    const rawData = pendingRef.current
    if (!rawData) return false
    try {
      const { fingerprint } = normalizeScenePayload(rawData)
      return fingerprint !== lastSavedRef.current
    } catch {
      return true
    }
  }, [lastSavedRef, normalizeScenePayload, pendingRef])

  const activeScene = scenes.find((scene) => scene.id === activeSceneId) || null
  const activeSceneTitleRef = useRef(activeScene?.title || '')
  activeSceneTitleRef.current = activeScene?.title || ''

  const flushSave = useCallback(async () => {
    if (saveInFlightRef.current) {
      saveRerunRef.current = true
      return
    }

    saveInFlightRef.current = true
    try {
      do {
        saveRerunRef.current = false
        const rawData = pendingRef.current
        if (!rawData) {
          setSaveState('saved')
          continue
        }

        const { normalized: data, fingerprint } = normalizeScenePayload(rawData)
        pendingRef.current = data
        currentSceneRef.current = data
        if (fingerprint === lastSavedRef.current) {
          setSaveState('saved')
          continue
        }

        setSaveState('saving')
        if (localCacheTimerRef.current) {
          window.clearTimeout(localCacheTimerRef.current)
          localCacheTimerRef.current = null
        }
        writeLocalCache(sceneIdRef.current, data)

        try {
          if (sceneIdRef.current) {
            const res = await request.patch(`/api/v1/excalidraw/scenes/${sceneIdRef.current}/`, { data })
            const serverUpdatedAt = typeof res.data?.updated_at === 'string' ? res.data.updated_at : null
            writeLocalCache(sceneIdRef.current, data, serverUpdatedAt)
            persistSceneToList(sceneIdRef.current, undefined, {
              createdAt: typeof res.data?.created_at === 'string' ? res.data.created_at : undefined,
              updatedAt: serverUpdatedAt,
            })
          } else {
            const title = (activeSceneTitleRef.current || '').trim() || untitledRef.current
            const payload = { title, data }
            const res = await request.post('/api/v1/excalidraw/scenes/', payload)
            const newId = res.data?.id ? String(res.data.id) : null
            if (newId) {
              setSceneIdSafe(newId)
              writeLocalCache(newId, data, typeof res.data?.updated_at === 'string' ? res.data.updated_at : null)
              persistSceneToList(newId, title, {
                createdAt: typeof res.data?.created_at === 'string' ? res.data.created_at : undefined,
                updatedAt: typeof res.data?.updated_at === 'string' ? res.data.updated_at : undefined,
              })
              window.dispatchEvent(new CustomEvent('canvex:scenes-changed'))
              try {
                localStorage.setItem(getLastKey(), newId)
              } catch {}
            }
          }
          lastSavedRef.current = fingerprint
          setSaveState('saved')
        } catch {
          setSaveState('error')
        }
      } while (saveRerunRef.current)
    } finally {
      saveInFlightRef.current = false
    }
  }, [currentSceneRef, getLastKey, lastSavedRef, localCacheTimerRef, normalizeScenePayload, pendingRef, persistSceneToList, saveInFlightRef, saveRerunRef, sceneIdRef, setSceneIdSafe, writeLocalCache])

  const queueUrgentSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave()
    }, SCENE_SAVE_URGENT_MS)
  }, [flushSave, saveTimerRef])

  const queueSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave()
    }, SCENE_SAVE_DEBOUNCE_MS)
  }, [flushSave, saveTimerRef])

  // Force-flush save interval
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (saveInFlightRef.current) return
      if (saveState !== 'pending' && saveState !== 'error') return
      if (!hasUnsavedChanges()) return
      if (Date.now() - lastMutationAtRef.current < SCENE_SAVE_FORCE_FLUSH_MS) return
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      void flushSave()
    }, SCENE_SAVE_WATCH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [flushSave, hasUnsavedChanges, lastMutationAtRef, saveInFlightRef, saveState, saveTimerRef])

  // Visibility/unload flushing
  useEffect(() => {
    const flushLocalNow = () => {
      if (!hasUnsavedChanges()) return
      if (localCacheTimerRef.current) {
        window.clearTimeout(localCacheTimerRef.current)
        localCacheTimerRef.current = null
      }
      flushLocalCacheWrite()
    }
    const flushNow = () => {
      if (!hasUnsavedChanges()) return
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      void flushSave()
    }
    const queueNow = () => {
      if (!hasUnsavedChanges()) return
      queueUrgentSave()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushLocalNow()
        flushNow()
        return
      }
      if (document.visibilityState === 'visible') {
        queueNow()
      }
    }
    const handleBeforeUnload = () => {
      if (!hasUnsavedChanges()) return
      flushLocalNow()
      flushNow()
    }
    const handlePageHide = () => {
      flushLocalNow()
      flushNow()
    }
    const handleWindowBlur = () => queueNow()
    const handleOnline = () => queueNow()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('online', handleOnline)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('online', handleOnline)
    }
  }, [flushLocalCacheWrite, flushSave, hasUnsavedChanges, localCacheTimerRef, queueUrgentSave, saveTimerRef])

  const selectScene = useCallback(
    async (scene: SceneRecord, opts?: { skipFlush?: boolean; skipUrl?: boolean }) => {
      if (!scene?.id) return
      if (scene.id === sceneIdRef.current) return
      const selectionToken = ++sceneSelectTokenRef.current
      setLoadError(null)

      if (!opts?.skipFlush) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
        await flushSave()
      }
      if (selectionToken !== sceneSelectTokenRef.current) return

      const local = readLocalCache(scene.id)
      const serverUpdated = scene.updated_at ? new Date(scene.updated_at).getTime() : 0
      const localUpdated = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0

      if (local && local.data && localUpdated >= serverUpdated) {
        const localData = normalizeScenePayload(local.data).normalized
        if (selectionToken !== sceneSelectTokenRef.current) return
        setSceneIdSafe(scene.id)
        applyScene(localData)
        if (localUpdated > serverUpdated) {
          pendingRef.current = localData
          lastSavedRef.current = null
          lastMutationAtRef.current = Date.now()
          setSaveState('pending')
          queueSave()
        } else {
          pendingRef.current = null
          lastSavedRef.current = getSceneFingerprint(localData)
          setSaveState('saved')
        }
      } else {
        let detail = scene
        if (!detail.data) {
          try {
            const res = await request.get(`/api/v1/excalidraw/scenes/${scene.id}/`)
            detail = res.data
          } catch (e: any) {
            const errorMessage = e?.response?.data?.detail || e?.message || 'Failed to load scene'
            if (selectionToken === sceneSelectTokenRef.current) {
              if (currentSceneRef.current) {
                toast.error(errorMessage)
              } else {
                setLoadError(errorMessage)
              }
            }
            return
          }
        }
        if (selectionToken !== sceneSelectTokenRef.current) return
        const serverData = normalizeScenePayload(detail.data || {}).normalized
        setSceneIdSafe(scene.id)
        applyScene(serverData)
        pendingRef.current = null
        lastSavedRef.current = getSceneFingerprint(serverData)
        writeLocalCache(scene.id, serverData, detail.updated_at)
        setSaveState('saved')
        setScenes((prev) => {
          const summary = toSceneSummary(detail)
          if (!prev.some((item) => item.id === scene.id)) {
            return [summary, ...prev]
          }
          return prev.map((item) => (item.id === scene.id ? { ...item, ...summary } : item))
        })
      }

      try {
        localStorage.setItem(getLastKey(), scene.id)
      } catch {}

      if (!opts?.skipUrl) {
        updateSceneParam(scene.id)
      }
    },
    [applyScene, currentSceneRef, flushSave, getLastKey, getSceneFingerprint, lastMutationAtRef, lastSavedRef, normalizeScenePayload, pendingRef, queueSave, readLocalCache, saveTimerRef, sceneIdRef, sceneSelectTokenRef, setSceneIdSafe, updateSceneParam, writeLocalCache]
  )

  const loadScene = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    workspaceKeyRef.current = `canvex:workspace:${WORKSPACE_KEY}`

    const localDraft = readLocalCache(null)
    // Read sceneParam from ref so loadScene identity doesn't change on URL updates
    const currentSceneParam = searchParamsRef.current.get('scene')

    try {
      const res = await request.get('/api/v1/excalidraw/scenes/')
      let list: SceneRecord[] = Array.isArray(res.data?.results)
        ? res.data.results
        : Array.isArray(res.data)
          ? res.data
          : []

      if (list.length === 0 && localDraft?.data) {
        try {
          const normalizedDraft = normalizeScenePayload(localDraft.data).normalized
          const created = await request.post('/api/v1/excalidraw/scenes/', {
            title: untitledRef.current,
            data: normalizedDraft,
          })
          list = created?.data ? [created.data] : list
          clearLocalCache(null)
        } catch {
          // keep local draft fallback
        }
      }

      setScenes(list.map((scene) => toSceneSummary(scene)))

      const lastId = (() => {
        try {
          return localStorage.getItem(getLastKey())
        } catch {
          return null
        }
      })()

      const preferredFromParam = currentSceneParam && list.find(scene => scene.id === currentSceneParam)
      const preferred = preferredFromParam
        || (lastId && list.find((scene) => scene.id === lastId))
        || list[0]

      if (preferred) {
        await selectScene(preferred, { skipFlush: true, skipUrl: !!preferredFromParam })
        if (!preferredFromParam) updateSceneParam(preferred.id)
      } else if (localDraft?.data) {
        const normalizedDraft = normalizeScenePayload(localDraft.data).normalized
        setSceneIdSafe(null)
        applyScene(normalizedDraft)
        lastMutationAtRef.current = Date.now()
        setSaveState('pending')
        updateSceneParam(null)
      } else {
        setSceneIdSafe(null)
        applyScene({})
        setSaveState('saved')
        updateSceneParam(null)
      }
    } catch (e: any) {
      if (localDraft?.data) {
        const normalizedDraft = normalizeScenePayload(localDraft.data).normalized
        applyScene(normalizedDraft)
        lastMutationAtRef.current = Date.now()
        setSaveState('pending')
      } else {
        setLoadError(e?.response?.data?.detail || e?.message || 'Failed to load scene')
      }
    } finally {
      setLoading(false)
    }
  }, [applyScene, clearLocalCache, getLastKey, lastMutationAtRef, normalizeScenePayload, readLocalCache, selectScene, setSceneIdSafe, updateSceneParam, workspaceKeyRef])

  // Load scene on mount + listen for external changes
  useEffect(() => {
    loadScene()
    const handler = () => loadScene()
    window.addEventListener('canvex:scenes-changed', handler)
    return () => {
      window.removeEventListener('canvex:scenes-changed', handler)
      if (localCacheTimerRef.current) {
        window.clearTimeout(localCacheTimerRef.current)
        localCacheTimerRef.current = null
      }
      if (hasUnsavedChanges()) {
        flushLocalCacheWrite()
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [flushLocalCacheWrite, hasUnsavedChanges, loadScene, localCacheTimerRef, saveTimerRef])

  // Scene URL sync — runs when sceneParam changes; reads activeSceneId from
  // ref to avoid re-triggering when selectScene updates the state.
  useEffect(() => {
    if (loading) return
    if (!sceneParam) return
    if (sceneParam === sceneIdRef.current) return
    const target = scenes.find(scene => scene.id === sceneParam)
    if (target) {
      void selectScene(target, { skipUrl: true })
      return
    }
    let cancelled = false
    request.get(`/api/v1/excalidraw/scenes/${sceneParam}/`).then(res => {
      if (cancelled) return
      const record: SceneRecord = res.data
      if (record?.id) {
        setScenes(prev => {
          const filtered = prev.filter(scene => scene.id !== record.id)
          return [toSceneSummary(record), ...filtered]
        })
        void selectScene(record, { skipUrl: true })
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loading, sceneParam, sceneIdRef, scenes, selectScene])

  const hydrateSceneFiles = useCallback(async (scene?: SceneData | null, apiOverride?: any) => {
    const api = apiOverride || canvexApiRef.current
    if (!api?.addFiles || !scene) return
    const hydrationToken = ++sceneHydrateTokenRef.current
    const existingFiles = scene.files && typeof scene.files === 'object' ? scene.files : {}
    const hydratedFiles = { ...existingFiles }
    const hydratedFileList: Array<{
      id: string
      dataURL: string
      mimeType: string
      created: number
      lastRetrieved: number
    }> = []
    const tasks: Array<{ fileId: string; url: string; mimeType: string }> = []
    const seen = new Set<string>()

    for (const element of scene.elements || []) {
      if (!element || element.isDeleted || element.type !== 'image') continue
      const fileId = typeof element.fileId === 'string' ? element.fileId : ''
      if (!fileId || seen.has(fileId)) continue
      seen.add(fileId)
      if (existingFiles[fileId]?.dataURL) continue
      const url = getRemoteImageUrlFromElement(element)
      if (!url) continue
      tasks.push({
        fileId,
        url,
        mimeType: getRemoteImageMimeType(element),
      })
    }

    const HYDRATE_CONCURRENCY = 4
    for (let i = 0; i < tasks.length; i += HYDRATE_CONCURRENCY) {
      const batch = tasks.slice(i, i + HYDRATE_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((task) => loadImageDataUrl(task.url, MAX_CANVAS_IMAGE_DIM).then((loaded) => ({ task, loaded })))
      )
      if (hydrationToken !== sceneHydrateTokenRef.current) return
      for (const result of results) {
        if (result.status !== 'fulfilled') {
          console.warn('[canvex] hydrateSceneFiles: failed to load image', result.reason)
          continue
        }
        const { task, loaded } = result.value
        const hydratedFile = {
          id: task.fileId,
          dataURL: loaded.dataUrl,
          mimeType: task.mimeType,
          created: Date.now(),
          lastRetrieved: Date.now(),
        }
        hydratedFiles[task.fileId] = hydratedFile
        hydratedFileList.push(hydratedFile)
      }
    }
    if (!hydratedFileList.length) return
    if (hydrationToken !== sceneHydrateTokenRef.current) return
    const sceneId = sceneIdRef.current
    const hydratedScene: SceneData = {
      elements: Array.isArray(scene.elements) ? scene.elements : [],
      appState: scene.appState && typeof scene.appState === 'object' ? scene.appState : {},
      files: hydratedFiles,
    }
    if (!hasUnsavedChanges()) {
      currentSceneRef.current = hydratedScene
      pendingRef.current = null
      lastSavedRef.current = getSceneFingerprint(hydratedScene)
      writeLocalCache(sceneId, hydratedScene, readLocalCache(sceneId)?.updatedAt)
    }
    api.addFiles(hydratedFileList)
  }, [canvexApiRef, currentSceneRef, getRemoteImageMimeType, getRemoteImageUrlFromElement, getSceneFingerprint, hasUnsavedChanges, lastSavedRef, loadImageDataUrl, pendingRef, readLocalCache, sceneHydrateTokenRef, sceneIdRef, writeLocalCache])

  const resolveVideoImageUrls = useCallback(async (sceneId: string, imageElements: any[]) => {
    const api = canvexApiRef.current
    if (!api?.getFiles || !api?.getSceneElements || !api?.updateScene) {
      return { urls: [] as string[], allResolved: false }
    }
    const { CaptureUpdateAction } = await import('@excalidraw/excalidraw')
    const files = api.getFiles() || {}
    const existing = getSceneElementsSafe()
    const elementMap = new Map(existing.map((item: any) => [item?.id, item]))
    const urls: string[] = []
    let allResolved = true
    let didUpdate = false

    const uploadDataUrl = async (dataUrl: string, filename: string) => {
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const form = new FormData()
      form.append('file', blob, filename)
      form.append('filename', filename)
      form.append('is_public', 'true')
      const uploadRes = await request.post('/api/v1/library/assets/', form)
      const url = uploadRes.data?.url
      return typeof url === 'string' && url.startsWith('http') ? url : ''
    }

    for (const element of imageElements) {
      const data = element?.customData || {}
      const directUrl = data.aiEditImageUrl || data.aiChatImageUrl || data.aiVideoSourceUrl || ''
      if (typeof directUrl === 'string' && directUrl.startsWith('http')) {
        urls.push(directUrl)
        continue
      }

      const fileId = element?.fileId
      const file = fileId ? files[fileId] : null
      const dataUrl = file?.dataURL
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        const suffix = Math.random().toString(36).slice(2, 6)
        const filename = `canvex_${fileId || element?.id || Date.now()}_${suffix}.png`
        try {
          const uploadedUrl = await uploadDataUrl(dataUrl, filename)
          if (uploadedUrl) {
            urls.push(uploadedUrl)
            const target = elementMap.get(element.id)
            if (target) {
              elementMap.set(element.id, {
                ...target,
                customData: {
                  ...(target.customData || {}),
                  aiVideoSourceUrl: uploadedUrl,
                },
                updated: Date.now(),
                version: (target.version || 0) + 1,
                versionNonce: Math.floor(Math.random() * 2 ** 31),
              })
              didUpdate = true
            }
            continue
          }
        } catch (error) {
          console.warn('Upload image for video failed', error)
        }
      }

      urls.push('')
      allResolved = false
    }

    if (didUpdate && sceneId === sceneIdRef.current) {
      api.updateScene({
        elements: Array.from(elementMap.values()),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
    }

    return { urls, allResolved }
  }, [canvexApiRef, getSceneElementsSafe, sceneIdRef])

  return {
    scenes,
    setScenes,
    activeSceneId,
    setActiveSceneId,
    initialData,
    initialKey,
    loading,
    loadError,
    saveState,
    setSaveState,
    canvexReady,
    setCanvexReady,
    untitledRef,
    sceneParam,
    setSceneIdSafe,
    updateSceneParam,
    getSceneKey,
    getLastKey,
    getChatKey,
    getPinLastKey,
    getPinOriginKey,
    writeLocalCache,
    readLocalCache,
    clearLocalCache,
    flushLocalCacheWrite,
    queueLocalCacheWrite,
    compactScenePayload,
    normalizeScenePayload,
    getSceneFingerprint,
    applyScene,
    persistSceneToList,
    hasUnsavedChanges,
    flushSave,
    queueUrgentSave,
    queueSave,
    selectScene,
    loadScene,
    hydrateSceneFiles,
    resolveVideoImageUrls,
  }
}
