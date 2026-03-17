import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { request } from '@/utils/request'
import type { ImagePlaceholder, VideoJobListItem, VideoOverlayItem } from '@/types/canvex'
import { MAX_VIDEO_POSTER_DIM, MAX_CANVAS_IMAGE_DIM } from '@/constants/canvex'

export function useVideoPipeline({
  sceneIdRef,
  canvexApiRef,
  videoOverlayKeyRef,
  createPinnedVideoRef,
  recoveredVideoScenesRef,
  videoPollInFlightRef,
  videoEditSelectionByJobRef,
  pinOriginRef,
  getSceneElementsSafe,
  getSelectedElementsByIds,
  createImageElement,
  findNonOverlappingPinPosition,
  flashPinnedElement,
  loadImageDataUrl,
  removeElementsById,
  createImagePlaceholder,
  updatePlaceholderText,
  updatePlaceholderMeta,
  captureSceneSnapshot,
  queueUrgentSave,
  resolveVideoImageUrls,
  buildVideoPosterDataUrl,
  persistLastPinnedForScene,
  persistPinOriginForScene,
  selectedEditKey: selectedEditKeyExternal,
  selectedEditIds: selectedEditIdsExternal,
  imageEditPrompt: imageEditPromptExternal,
  setImageEditError: setImageEditErrorExternal,
}: {
  sceneIdRef: React.MutableRefObject<string | null>
  canvexApiRef: React.MutableRefObject<any>
  videoOverlayKeyRef: React.MutableRefObject<string>
  createPinnedVideoRef: React.MutableRefObject<any>
  recoveredVideoScenesRef: React.MutableRefObject<Record<string, boolean>>
  videoPollInFlightRef: React.MutableRefObject<Set<string>>
  videoEditSelectionByJobRef: React.MutableRefObject<Record<string, string>>
  pinOriginRef: React.MutableRefObject<any>
  getSceneElementsSafe: () => any[]
  getSelectedElementsByIds: (ids: string[]) => any[]
  createImageElement: (overrides: Record<string, any>) => any
  findNonOverlappingPinPosition: (elements: any[], x: number, startY: number, width: number, height: number, gap?: number) => { x: number; y: number }
  flashPinnedElement: (element: any) => void
  loadImageDataUrl: (url: string, maxDim?: number | null) => Promise<{ dataUrl: string; width: number | null; height: number | null }>
  removeElementsById: (ids: string[]) => void
  createImagePlaceholder: (sceneId: string | null, label: string, options?: any) => ImagePlaceholder | null
  updatePlaceholderText: (placeholder: ImagePlaceholder, content: string) => void
  updatePlaceholderMeta: (placeholder: ImagePlaceholder, meta: Record<string, any>) => void
  captureSceneSnapshot: () => void
  queueUrgentSave: () => void
  resolveVideoImageUrls: (sceneId: string, imageElements: any[]) => Promise<{ urls: string[]; allResolved: boolean }>
  buildVideoPosterDataUrl: () => string
  persistLastPinnedForScene: (sceneId: string | null, elementId: string | null) => void
  persistPinOriginForScene: (sceneId: string | null, origin: any) => void
  selectedEditKey: string | null
  selectedEditIds: string[]
  imageEditPrompt: string
  setImageEditError: (error: string | null) => void
}) {
  const { t } = useTranslation('canvex')

  // Parse video duration options from env once (comma-separated seconds, first = default)
  const videoDurationOptions = useMemo(() => {
    const raw = import.meta.env.VITE_VIDEO_DURATION_OPTIONS ?? '10'
    const parsed = String(raw)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    return parsed.length ? parsed : [10]
  }, [])

  const [videoOverlayItems, setVideoOverlayItems] = useState<VideoOverlayItem[]>([])
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [videoEditPendingCountByKey, setVideoEditPendingCountByKey] = useState<Record<string, number>>({})
  const [videoEditStatusByKey, setVideoEditStatusByKey] = useState<Record<string, string | null>>({})
  const [videoEditErrorByKey, setVideoEditErrorByKey] = useState<Record<string, string | null>>({})
  const [videoDuration, setVideoDuration] = useState<number>(videoDurationOptions[0])
  const [videoAspectRatio, setVideoAspectRatio] = useState<string>('16:9')
  const [, forceVideoOverlayRefresh] = useReducer((value: number) => (value + 1) % 1000000, 0)
  const videoOverlayRafRef = useRef<number | null>(null)
  const lastPinnedIdRef = useRef<string | null>(null)

  const toVideoFailureLabel = useCallback((value: any) => {
    const fallback = t('editVideoRequestFailed', { defaultValue: '视频生成失败' })
    let detail = String(value ?? '').trim()
    if (!detail) return fallback

    for (let i = 0; i < 3; i += 1) {
      const stripped = detail
        .replace(/^video generation failed\s*[:：-]?\s*/i, '')
        .replace(/^视频生成失败\s*[:：-]?\s*/i, '')
        .trim()
      if (stripped === detail) break
      detail = stripped
    }

    const normalized = detail.toLowerCase().trim()
    if (
      !normalized
      || normalized === 'video generation failed'
      || normalized === 'video generation failed.'
      || normalized === '视频生成失败'
      || normalized === '视频生成失败。'
    ) {
      return fallback
    }

    return t('editVideoFailedWithReason', {
      defaultValue: '视频生成失败：{{error}}',
      error: detail,
    })
  }, [t])

  const toRequestErrorDetail = useCallback((error: any) => {
    const detail = error?.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
      return detail.trim()
    }
    const message = error?.message
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
    return t('editVideoRequestFailed', { defaultValue: '视频生成失败' })
  }, [t])

  const scheduleVideoOverlayRefresh = useCallback(() => {
    if (!videoOverlayKeyRef.current) return
    if (videoOverlayRafRef.current) return
    videoOverlayRafRef.current = window.requestAnimationFrame(() => {
      videoOverlayRafRef.current = null
      forceVideoOverlayRefresh()
    })
  }, [forceVideoOverlayRefresh, videoOverlayKeyRef])

  useEffect(() => {
    if (!activeVideoId) return
    const exists = videoOverlayItems.some((item) => item.id === activeVideoId)
    if (!exists) {
      setActiveVideoId(null)
    }
  }, [activeVideoId, videoOverlayItems])

  useEffect(() => {
    return () => {
      if (videoOverlayRafRef.current) {
        window.cancelAnimationFrame(videoOverlayRafRef.current)
        videoOverlayRafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const handleResize = () => scheduleVideoOverlayRefresh()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [scheduleVideoOverlayRefresh])

  const isVideoGeneratingSelected = useMemo(() => {
    if (!selectedEditKeyExternal) return false
    return (videoEditPendingCountByKey[selectedEditKeyExternal] || 0) > 0
  }, [selectedEditKeyExternal, videoEditPendingCountByKey])

  const videoEditStatus = useMemo(() => {
    if (!selectedEditKeyExternal) return null
    return videoEditStatusByKey[selectedEditKeyExternal] || null
  }, [selectedEditKeyExternal, videoEditStatusByKey])

  const videoEditError = useMemo(() => {
    if (!selectedEditKeyExternal) return null
    return videoEditErrorByKey[selectedEditKeyExternal] || null
  }, [selectedEditKeyExternal, videoEditErrorByKey])

  const videoEditStatusTone = useMemo(() => {
    if (!videoEditStatus) return 'text-muted-foreground'
    if (videoEditError || videoEditStatus === t('editVideoFailed', { defaultValue: '失败' })) return 'text-destructive'
    if (videoEditStatus === t('editVideoDone', { defaultValue: '已完成' })) return 'text-emerald-600'
    return 'text-muted-foreground'
  }, [t, videoEditError, videoEditStatus])

  const updateVideoEditStatus = useCallback((selectionKey: string, status?: string | null, error?: string | null) => {
    if (!selectionKey || !status) return
    const normalized = String(status).toUpperCase()
    if (normalized === 'QUEUED') {
      setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoQueued', { defaultValue: '排队中…' }) }))
      setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: null }))
      return
    }
    if (normalized === 'RUNNING') {
      setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoWorking', { defaultValue: '生成中…' }) }))
      setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: null }))
      return
    }
    if (normalized === 'SUCCEEDED') {
      setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoDone', { defaultValue: '已完成' }) }))
      setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: null }))
      return
    }
    if (normalized === 'FAILED') {
      setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoFailed', { defaultValue: '失败' }) }))
      setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: error ? String(error) : null }))
      return
    }
    setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: normalized }))
  }, [t])

  const decrementVideoPending = useCallback((selectionKey: string) => {
    if (!selectionKey) return
    setVideoEditPendingCountByKey(prev => {
      const current = Number(prev[selectionKey] || 0)
      if (current <= 1) {
        if (!(selectionKey in prev)) return prev
        const next = { ...prev }
        delete next[selectionKey]
        return next
      }
      return { ...prev, [selectionKey]: current - 1 }
    })
  }, [])

  const findVideoPlaceholderByJobId = useCallback((sceneId: string | null, jobId: string | null) => {
    if (!sceneId || !jobId) return null
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return null
    const elements = api.getSceneElements()
    if (!Array.isArray(elements)) return null

    let groupId: string | null = null
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const data = element.customData || {}
      if (data.aiChatType !== 'note-video-placeholder') continue
      if (data.aiVideoJobId !== jobId) continue
      const groups = Array.isArray(element.groupIds) ? element.groupIds : []
      if (groups.length) {
        groupId = String(groups[0])
        break
      }
    }

    if (!groupId) return null
    let rectId: string | null = null
    let textId: string | null = null
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const groups = Array.isArray(element.groupIds) ? element.groupIds : []
      if (!groups.includes(groupId)) continue
      const data = element.customData || {}
      if (data.aiChatType !== 'note-video-placeholder') continue
      if (element.type === 'rectangle') rectId = element.id
      if (element.type === 'text') textId = element.id
    }
    if (!rectId || !textId) return null
    return { sceneId, groupId, rectId, textId }
  }, [canvexApiRef])

  const findOrphanVideoPlaceholder = useCallback((sceneId: string | null, minAgeMs: number = 0) => {
    if (!sceneId) return null
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return null
    const elements = api.getSceneElements()
    if (!Array.isArray(elements)) return null
    const groups: Record<string, { rectId?: string; textId?: string; hasJobId?: boolean; isVideo?: boolean; createdAt?: number }> = {}
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const data = element.customData || {}
      const isVideoType = data.aiChatType === 'note-video-placeholder'
      const groupIds = Array.isArray(element.groupIds) ? element.groupIds : []
      if (!groupIds.length) continue
      const gid = String(groupIds[0])
      if (!groups[gid]) {
        groups[gid] = {}
      }
      if (isVideoType) {
        groups[gid].isVideo = true
      }
      if (data.aiVideoJobId) {
        groups[gid].hasJobId = true
      }
      if (data.aiChatCreatedAt) {
        const createdAtTs = Date.parse(String(data.aiChatCreatedAt))
        if (Number.isFinite(createdAtTs)) {
          const prevCreatedAt = groups[gid].createdAt
          if (!prevCreatedAt || createdAtTs < prevCreatedAt) {
            groups[gid].createdAt = createdAtTs
          }
        }
      }
      if (element.type === 'rectangle') {
        groups[gid].rectId = element.id
      } else if (element.type === 'text') {
        groups[gid].textId = element.id
        if (!groups[gid].isVideo && typeof element.text === 'string' && element.text.includes('视频')) {
          groups[gid].isVideo = true
        }
      }
    }
    const candidates = Object.entries(groups)
      .filter(([, value]) => {
        if (value.hasJobId || !value.rectId || !value.textId || !value.isVideo) return false
        if (!minAgeMs) return true
        if (!value.createdAt || !Number.isFinite(value.createdAt)) return true
        return Date.now() - value.createdAt >= minAgeMs
      })
    if (candidates.length !== 1) return null
    const [gid, value] = candidates[0]
    return {
      sceneId,
      groupId: gid,
      rectId: value.rectId!,
      textId: value.textId!,
    }
  }, [canvexApiRef])

  const findExistingVideoElement = useCallback((jobId: string | null, url?: string | null) => {
    const elements = getSceneElementsSafe()
    return elements.find((element: any) => {
      if (!element || element.isDeleted || element.type !== 'image') return false
      const data = element.customData || {}
      if (jobId && data.aiVideoJobId === jobId) return true
      if (url && data.aiVideoUrl === url) return true
      return false
    }) || null
  }, [getSceneElementsSafe])

  const collectVideoPlaceholders = useCallback(() => {
    const elements = getSceneElementsSafe()
    const groups = new Map<string, {
      rectId?: string
      textId?: string
      jobId?: string | null
      createdAt?: string | null
      ids: string[]
    }>()
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const data = element.customData || {}
      if (data.aiChatType !== 'note-video-placeholder') continue
      const groupIds = Array.isArray(element.groupIds) ? element.groupIds : []
      const groupKey = groupIds.length ? String(groupIds[0]) : String(element.id)
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { ids: [] })
      }
      const group = groups.get(groupKey)!
      group.ids.push(element.id)
      if (data.aiVideoJobId && !group.jobId) {
        group.jobId = String(data.aiVideoJobId)
      }
      if (!group.createdAt && data.aiChatCreatedAt) {
        group.createdAt = String(data.aiChatCreatedAt)
      }
      if (element.type === 'rectangle') {
        group.rectId = element.id
      } else if (element.type === 'text') {
        group.textId = element.id
      }
    }
    return Array.from(groups.values()).filter((group) => group.rectId || group.textId)
  }, [getSceneElementsSafe])

  const cleanupLegacyVideoPlaceholders = useCallback((jobs: VideoJobListItem[], existingJobIds: Set<string>, existingUrls: Set<string>) => {
    const placeholders = collectVideoPlaceholders()
    if (!placeholders.length) return
    const jobMap = new Map<string, VideoJobListItem>()
    for (const job of jobs) {
      if (job?.id) {
        jobMap.set(String(job.id), job)
      }
    }
    const idsToRemove: string[] = []
    for (const placeholder of placeholders) {
      const jobId = placeholder.jobId ? String(placeholder.jobId) : ''
      if (!jobId) continue
      const job = jobMap.get(jobId)
      if (!job) continue
      const status = String(job.status || '').toUpperCase()
      if (status === 'SUCCEEDED') {
        const resultUrl = job.result_url || ''
        if (existingJobIds.has(jobId) || (resultUrl && existingUrls.has(resultUrl))) {
          idsToRemove.push(...placeholder.ids)
        }
      }
    }
    if (idsToRemove.length) {
      removeElementsById(Array.from(new Set(idsToRemove)))
    }
  }, [collectVideoPlaceholders, removeElementsById])

  const createPinnedVideo = useCallback(async (
    sceneId: string | null,
    videoUrl: string,
    thumbnailUrl?: string | null,
    placeholder?: ImagePlaceholder | null,
    videoJobId?: string | null,
  ) => {
    if (sceneId !== sceneIdRef.current) return false
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState || !api?.addFiles) return false
    if (!videoUrl) return false

    let dataURL = ''
    let decodedWidth: number | null = null
    let decodedHeight: number | null = null
    const shouldPersistThumbnail = Boolean(thumbnailUrl && /^https?:\/\//.test(thumbnailUrl))
    let resolvedPosterUrl = shouldPersistThumbnail ? thumbnailUrl! : buildVideoPosterDataUrl()
    try {
      const loaded = await loadImageDataUrl(resolvedPosterUrl, MAX_VIDEO_POSTER_DIM)
      dataURL = loaded.dataUrl
      decodedWidth = loaded.width
      decodedHeight = loaded.height
    } catch {
      if (thumbnailUrl) {
        try {
          resolvedPosterUrl = buildVideoPosterDataUrl()
          const fallback = await loadImageDataUrl(resolvedPosterUrl, MAX_VIDEO_POSTER_DIM)
          dataURL = fallback.dataUrl
          decodedWidth = fallback.width
          decodedHeight = fallback.height
        } catch {
          return false
        }
      } else {
        return false
      }
    }

    const fileId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    api.addFiles([{
      id: fileId,
      dataURL,
      mimeType: 'image/png',
      created: Date.now(),
      lastRetrieved: Date.now(),
    }])

    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    const naturalWidth = decodedWidth || 640
    const naturalHeight = decodedHeight || 360

    let x = 0
    let y = 0
    let width = Math.max(160, Math.round(naturalWidth))
    let height = Math.max(90, Math.round(naturalHeight))

    const placeholderRect = placeholder
      ? existing.find((item: any) => item?.id === placeholder.rectId && !item?.isDeleted)
      : null
    if (placeholderRect) {
      const targetWidth = Math.max(160, Math.round(placeholderRect.width || naturalWidth))
      const scale = naturalWidth > 0 ? targetWidth / naturalWidth : 1
      width = Math.max(160, Math.round(naturalWidth * scale))
      height = Math.max(90, Math.round(naturalHeight * scale))
      x = placeholderRect.x || 0
      y = placeholderRect.y || 0
    } else {
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
      const maxWidth = MAX_CANVAS_IMAGE_DIM
      const scale = naturalWidth > 0 ? Math.min(1, maxWidth / naturalWidth) : 1
      width = Math.max(160, Math.round(naturalWidth * scale))
      height = Math.max(90, Math.round(naturalHeight * scale))
      const placement = findNonOverlappingPinPosition(existing, baseX, baseY, width, height, gap)
      x = placement.x
      y = placement.y
    }

    const imageElement = createImageElement({
      x,
      y,
      width,
      height,
      fileId,
      status: 'saved',
      scale: [1, 1],
      link: videoUrl,
      customData: {
        aiChatType: 'note-video',
        aiChatCreatedAt: new Date().toISOString(),
        aiVideoUrl: videoUrl,
        aiVideoThumbnailUrl: shouldPersistThumbnail ? resolvedPosterUrl : null,
        aiVideoJobId: videoJobId || null,
        aiImageMimeType: 'image/png',
        aiNaturalWidth: naturalWidth,
        aiNaturalHeight: naturalHeight,
      },
    })

    api.updateScene({
      elements: [...(existing || []), imageElement],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
    queueUrgentSave()
    if (placeholder) {
      removeElementsById([placeholder.rectId, placeholder.textId])
    }
    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent([imageElement], { fitToViewport: false })
      } catch {}
    }
    lastPinnedIdRef.current = imageElement.id
    persistLastPinnedForScene(sceneId, imageElement.id)
    window.setTimeout(() => {
      flashPinnedElement(imageElement)
    }, 120)
    return true
  }, [
    buildVideoPosterDataUrl,
    canvexApiRef,
    captureSceneSnapshot,
    createImageElement,
    findNonOverlappingPinPosition,
    flashPinnedElement,
    getSceneElementsSafe,
    loadImageDataUrl,
    persistLastPinnedForScene,
    persistPinOriginForScene,
    pinOriginRef,
    queueUrgentSave,
    removeElementsById,
    sceneIdRef,
  ])

  useEffect(() => {
    createPinnedVideoRef.current = createPinnedVideo
  }, [createPinnedVideo, createPinnedVideoRef])

  const pollVideoJob = useCallback(async (
    jobId: string,
    sceneId: string,
    placeholder?: ImagePlaceholder | null,
    selectionKey?: string | null,
  ) => {
    const pollKey = `${sceneId}:${jobId}`
    if (videoPollInFlightRef.current.has(pollKey)) return
    videoPollInFlightRef.current.add(pollKey)
    const maxAttemptsEnv = Number(import.meta.env.VITE_VIDEO_POLL_MAX_ATTEMPTS ?? 600)
    const delayMsEnv = Number(import.meta.env.VITE_VIDEO_POLL_INTERVAL_MS ?? 3000)
    const maxAttempts = Number.isFinite(maxAttemptsEnv) && maxAttemptsEnv > 0 ? Math.floor(maxAttemptsEnv) : 600
    const delayMs = Number.isFinite(delayMsEnv) && delayMsEnv > 0 ? Math.floor(delayMsEnv) : 3000
    let resolvedPlaceholder: ImagePlaceholder | null = placeholder || null
    const trackedSelectionKey = selectionKey || ''
    const resolveSelectionKey = () => trackedSelectionKey || videoEditSelectionByJobRef.current[jobId] || ''
    const finishTrackedVideoJob = (status?: string | null, error?: string | null) => {
      const resolvedSelectionKey = resolveSelectionKey()
      if (!resolvedSelectionKey) return
      if (status) {
        updateVideoEditStatus(resolvedSelectionKey, status, error || null)
      }
      if (videoEditSelectionByJobRef.current[jobId]) {
        delete videoEditSelectionByJobRef.current[jobId]
      }
      decrementVideoPending(resolvedSelectionKey)
    }
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const res = await request.get(`/api/v1/excalidraw/video-jobs/${jobId}/`)
          const status = res.data?.status
          if (!resolvedPlaceholder) {
            const byJob = findVideoPlaceholderByJobId(sceneId, jobId)
            if (byJob) {
              resolvedPlaceholder = byJob
            } else {
              const orphan = findOrphanVideoPlaceholder(sceneId, 10000)
              if (orphan) {
                updatePlaceholderMeta(orphan, { aiChatType: 'note-video-placeholder', aiVideoJobId: jobId })
                resolvedPlaceholder = orphan
              }
            }
          }
          const statusSelectionKey = resolveSelectionKey()
          if (statusSelectionKey && status) {
            updateVideoEditStatus(statusSelectionKey, status, res.data?.error || null)
          }
          if (status && resolvedPlaceholder && sceneIdRef.current === sceneId) {
            if (status === 'QUEUED') {
              updatePlaceholderText(resolvedPlaceholder, t('editVideoPlaceholderQueued', { defaultValue: '视频排队中…' }))
            } else if (status === 'RUNNING') {
              updatePlaceholderText(resolvedPlaceholder, t('editVideoPlaceholderWorking', { defaultValue: '视频生成中…' }))
            }
          }
          if (status === 'SUCCEEDED') {
            const url = res.data?.result?.url
            if (url && sceneIdRef.current === sceneId) {
              const existing = findExistingVideoElement(jobId, url)
              if (existing) {
                if (resolvedPlaceholder) {
                  removeElementsById([resolvedPlaceholder.rectId, resolvedPlaceholder.textId])
                }
                finishTrackedVideoJob('SUCCEEDED', null)
                return
              }
              const creator = createPinnedVideoRef.current
              if (creator) {
                const created = await creator(sceneId, url, res.data?.result?.thumbnail_url, resolvedPlaceholder, jobId)
                if (!created) {
                  const writeError = t('editVideoPinFailed', { defaultValue: '视频已生成，但写入画布失败' })
                  finishTrackedVideoJob('FAILED', writeError)
                  if (sceneIdRef.current === sceneId && resolvedPlaceholder) {
                    updatePlaceholderText(resolvedPlaceholder, `${writeError}，请重试`)
                  }
                  return
                }
              }
            }
            finishTrackedVideoJob('SUCCEEDED', null)
            return
          }
          if (status === 'FAILED') {
            const error = res.data?.error || t('editVideoRequestFailed', { defaultValue: '视频生成失败' })
            finishTrackedVideoJob('FAILED', error)
            if (sceneIdRef.current === sceneId) {
              if (resolvedPlaceholder) {
                updatePlaceholderText(resolvedPlaceholder, toVideoFailureLabel(error))
              }
            }
            return
          }
        } catch (error) {
          console.error('Poll video job failed', error)
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      if (sceneIdRef.current === sceneId) {
        if (resolvedPlaceholder) {
          updatePlaceholderText(
            resolvedPlaceholder,
            toVideoFailureLabel(t('editVideoTimeout', { defaultValue: '超时' })),
          )
        }
      }
      finishTrackedVideoJob('FAILED', t('editVideoTimeout', { defaultValue: '超时' }))
    } finally {
      videoPollInFlightRef.current.delete(pollKey)
    }
  }, [
    createPinnedVideoRef,
    decrementVideoPending,
    findExistingVideoElement,
    findOrphanVideoPlaceholder,
    findVideoPlaceholderByJobId,
    removeElementsById,
    sceneIdRef,
    t,
    toVideoFailureLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
    updateVideoEditStatus,
    videoEditSelectionByJobRef,
    videoPollInFlightRef,
  ])

  const recoverVideoJobsForScene = useCallback(async (sceneId: string, attempt: number = 0) => {
    if (!sceneId) return
    if (recoveredVideoScenesRef.current[sceneId]) return
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return
    const creator = createPinnedVideoRef.current
    if (!creator) {
      if (attempt < 2) {
        window.setTimeout(() => {
          if (sceneIdRef.current === sceneId) {
            recoverVideoJobsForScene(sceneId, attempt + 1)
          }
        }, 300)
      }
      return
    }
    recoveredVideoScenesRef.current[sceneId] = true
    try {
      const res = await request.get(`/api/v1/excalidraw/scenes/${sceneId}/video-jobs/`, {
        params: { limit: 20 },
      })
      const jobs: VideoJobListItem[] = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.results)
          ? res.data.results
          : []

      const elements = getSceneElementsSafe()
      const existingUrls = new Set<string>()
      const existingJobIds = new Set<string>()
      for (const element of elements) {
        if (!element || element.isDeleted || element.type !== 'image') continue
        const data = element.customData || {}
        if (data.aiVideoUrl && typeof data.aiVideoUrl === 'string') {
          existingUrls.add(data.aiVideoUrl)
        }
        if (data.aiVideoJobId && typeof data.aiVideoJobId === 'string') {
          existingJobIds.add(data.aiVideoJobId)
        }
      }

      const orphanPlaceholder = findOrphanVideoPlaceholder(sceneId, 10000)
      let orphanUsed = false

      for (const job of jobs) {
        const jobId = job?.id ? String(job.id) : ''
        const status = String(job?.status || '').toUpperCase()
        if (!jobId || !status) continue
        let ph = findVideoPlaceholderByJobId(sceneId, jobId)
        if (!ph && orphanPlaceholder && !orphanUsed) {
          ph = orphanPlaceholder
          orphanUsed = true
          updatePlaceholderMeta(ph, { aiChatType: 'note-video-placeholder', aiVideoJobId: jobId })
        }
        if (status === 'QUEUED' || status === 'RUNNING') {
          if (ph) {
            void pollVideoJob(jobId, sceneId, ph)
          }
          continue
        }
        if (status === 'FAILED') {
          if (ph) {
            updatePlaceholderText(
              ph,
              toVideoFailureLabel((job as any)?.error || t('editVideoRequestFailed', { defaultValue: '视频生成失败' })),
            )
          }
          continue
        }
        if (status !== 'SUCCEEDED') continue
        if (!ph) continue
        const url = job?.result_url || ''
        if (!url || typeof url !== 'string') continue
        if (existingJobIds.has(jobId) || existingUrls.has(url)) {
          if (ph) {
            removeElementsById([ph.rectId, ph.textId])
          }
          continue
        }
        await creator(sceneId, url, job?.thumbnail_url || null, ph, jobId)
        existingJobIds.add(jobId)
        existingUrls.add(url)
      }
      cleanupLegacyVideoPlaceholders(jobs, existingJobIds, existingUrls)
    } catch (error) {
      recoveredVideoScenesRef.current[sceneId] = false
      if (attempt < 2) {
        window.setTimeout(() => {
          if (sceneIdRef.current === sceneId) {
            recoverVideoJobsForScene(sceneId, attempt + 1)
          }
        }, 2000)
      }
      console.error('Recover video jobs failed', error)
      return
    }
  }, [
    canvexApiRef,
    cleanupLegacyVideoPlaceholders,
    createPinnedVideoRef,
    findOrphanVideoPlaceholder,
    findVideoPlaceholderByJobId,
    getSceneElementsSafe,
    pollVideoJob,
    recoveredVideoScenesRef,
    removeElementsById,
    sceneIdRef,
    toVideoFailureLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
    t,
  ])

  const handleVideoGenerate = useCallback(async () => {
    if (!selectedEditKeyExternal || !selectedEditIdsExternal.length) return
    const selectionKey = selectedEditKeyExternal
    const sceneId = sceneIdRef.current
    if (!sceneId) {
      setImageEditErrorExternal(t('editNoScene', { defaultValue: 'Save the scene first.' }))
      return
    }
    const api = canvexApiRef.current
    if (!api?.getSceneElements) {
      setImageEditErrorExternal(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    const selectedElements = getSelectedElementsByIds(selectedEditIdsExternal)
    if (!selectedElements.length) {
      setImageEditErrorExternal(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }

    const textPrompt = selectedElements
      .filter((item: any) => item?.type === 'text' && typeof item?.text === 'string')
      .map((item: any) => String(item.text || '').trim())
      .filter(Boolean)
      .join('\n')
    const prompt = textPrompt || imageEditPromptExternal.trim()

    const imageElements = selectedElements
      .filter((item: any) => item?.type === 'image')
      .slice()
      .sort((a: any, b: any) => {
        const ax = Number(a?.x) || 0
        const bx = Number(b?.x) || 0
        if (ax !== bx) return ax - bx
        const ay = Number(a?.y) || 0
        const by = Number(b?.y) || 0
        if (ay !== by) return ay - by
        return String(a?.id || '').localeCompare(String(b?.id || ''))
      })

    setImageEditErrorExternal(null)
    setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: null }))
    setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoQueued', { defaultValue: '排队中…' }) }))
    setVideoEditPendingCountByKey(prev => ({
      ...prev,
      [selectionKey]: Number(prev[selectionKey] || 0) + 1,
    }))
    const ph = createImagePlaceholder(
      sceneId,
      t('editVideoPlaceholderQueued', { defaultValue: '视频排队中…' }),
      { kind: 'video' },
    )
    let imageUrls: string[] = []
    if (imageElements.length) {
      const resolved = await resolveVideoImageUrls(sceneId, imageElements)
      imageUrls = resolved.urls.filter((url: string) => typeof url === 'string' && url.startsWith('http'))
      if (!resolved.allResolved || !imageUrls.length || imageUrls.length !== imageElements.length) {
        const errorMessage = t('editImageUrlMissing', { defaultValue: 'Selected images must have public URLs.' })
        setImageEditErrorExternal(errorMessage)
        updateVideoEditStatus(selectionKey, 'FAILED', errorMessage)
        decrementVideoPending(selectionKey)
        if (ph) {
          updatePlaceholderText(ph, toVideoFailureLabel(errorMessage))
        }
        return
      }
    }
    if (ph) {
      updatePlaceholderText(ph, t('editVideoPlaceholderWorking', { defaultValue: '视频生成中…' }))
    }
    let submittedJobId = ''
    try {
      const requestPayload: Record<string, any> = { prompt, duration: videoDuration, aspect_ratio: videoAspectRatio }
      if (imageUrls.length) requestPayload.image_urls = imageUrls
      const res = await request.post(`/api/v1/excalidraw/scenes/${sceneId}/video/`, requestPayload)
      const jobId = res.data?.job_id ? String(res.data.job_id) : ''
      if (!jobId) {
        throw new Error('job id missing')
      }
      submittedJobId = jobId
      if (ph) {
        updatePlaceholderMeta(ph, { aiChatType: 'note-video-placeholder', aiVideoJobId: jobId })
      }
      videoEditSelectionByJobRef.current[jobId] = selectionKey
      if (res.data?.status) {
        updateVideoEditStatus(selectionKey, res.data.status, null)
      }
      void pollVideoJob(jobId, sceneId, ph, selectionKey)
    } catch (error) {
      console.error('Video generation failed', error)
      const errorMessage = toRequestErrorDetail(error)
      updateVideoEditStatus(selectionKey, 'FAILED', errorMessage)
      if (submittedJobId && videoEditSelectionByJobRef.current[submittedJobId]) {
        delete videoEditSelectionByJobRef.current[submittedJobId]
      }
      decrementVideoPending(selectionKey)
      if (ph) {
        updatePlaceholderText(
          ph,
          toVideoFailureLabel(errorMessage),
        )
      }
    }
  }, [
    canvexApiRef,
    createImagePlaceholder,
    decrementVideoPending,
    getSelectedElementsByIds,
    imageEditPromptExternal,
    pollVideoJob,
    resolveVideoImageUrls,
    sceneIdRef,
    selectedEditIdsExternal,
    selectedEditKeyExternal,
    setImageEditErrorExternal,
    t,
    toRequestErrorDetail,
    toVideoFailureLabel,
    updateVideoEditStatus,
    updatePlaceholderMeta,
    updatePlaceholderText,
    videoEditSelectionByJobRef,
    videoDuration,
    videoAspectRatio,
  ])

  return {
    videoOverlayItems,
    setVideoOverlayItems,
    activeVideoId,
    setActiveVideoId,
    videoEditPendingCountByKey,
    videoEditStatusByKey,
    videoEditErrorByKey,
    forceVideoOverlayRefresh,
    toVideoFailureLabel,
    scheduleVideoOverlayRefresh,
    isVideoGeneratingSelected,
    videoEditStatus,
    videoEditError,
    videoEditStatusTone,
    updateVideoEditStatus,
    decrementVideoPending,
    findVideoPlaceholderByJobId,
    findOrphanVideoPlaceholder,
    findExistingVideoElement,
    collectVideoPlaceholders,
    cleanupLegacyVideoPlaceholders,
    createPinnedVideo,
    pollVideoJob,
    recoverVideoJobsForScene,
    handleVideoGenerate,
    videoDurationOptions,
    videoDuration,
    setVideoDuration,
    videoAspectRatio,
    setVideoAspectRatio,
  }
}
