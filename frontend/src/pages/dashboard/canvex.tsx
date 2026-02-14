import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, MIME_TYPES, getCommonBounds, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import '@/styles/canvex-shadcn.css'
import { IconAlertTriangle, IconLoader, IconMessage2, IconHistory, IconCat, IconButterfly, IconDog, IconFish, IconPaw, IconCheck, IconX } from '@tabler/icons-react'
import { request } from '@/utils/request'
import { Button } from '@/components/ui/button'

type SceneData = {
  elements?: any[]
  appState?: Record<string, any>
  files?: Record<string, any>
}

type SceneRecord = {
  id: string
  title?: string
  data?: SceneData
  updated_at?: string
}

type LocalCache = {
  sceneId?: string | null
  data: SceneData
  updatedAt?: string
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

type PinOrigin = {
  x: number
  y: number
}

type PinRect = {
  x: number
  y: number
  width: number
  height: number
}

type SelectionBounds = {
  x: number
  y: number
  width: number
  height: number
}

type HoverAnchor = {
  x: number
  y: number
  width: number
  height: number
}

type ToolResult = {
  tool?: string
  result?: {
    url?: string
    thumbnail_url?: string
    width?: number | null
    height?: number | null
    asset_id?: string
    mime_type?: string
    task_id?: string
    status?: string
    error?: string
  }
}

type ImagePlaceholder = {
  sceneId: string
  groupId: string
  rectId: string
  textId: string
}

type PlaceholderOptions = {
  kind?: 'image' | 'video'
  jobId?: string | null
}

type VideoJobResult = {
  job_id?: string
  status?: string
  result?: {
    url?: string
    thumbnail_url?: string
    task_id?: string
  }
  error?: string
}

type VideoJobListItem = {
  id?: string
  status?: string
  result_url?: string | null
  thumbnail_url?: string | null
  task_id?: string | null
}

type ImageEditJobListItem = {
  id?: string
  status?: string
  num_images?: number
  error?: string | null
}

type VideoOverlayItem = {
  id: string
  url: string
  thumbnailUrl?: string | null
}

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8000' : '')
const WORKSPACE_KEY = import.meta.env.VITE_WORKSPACE_KEY || 'public'
const MAX_INSERT_IMAGE_DIM = 512
const parsePositiveIntEnv = (raw: unknown, fallback: number) => {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
const SCENE_SAVE_DEBOUNCE_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_DEBOUNCE_MS, 600)
const SCENE_SAVE_URGENT_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_URGENT_MS, 180)
const SCENE_SAVE_FORCE_FLUSH_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_FORCE_FLUSH_MS, 1600)
const SCENE_SAVE_WATCH_INTERVAL_MS = parsePositiveIntEnv(import.meta.env.VITE_SCENE_SAVE_WATCH_INTERVAL_MS, 700)
const IMAGE_EDIT_SIZE_OPTIONS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
const IMAGE_EDIT_SIZE_MAP: Record<string, string> = {
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

const resolveImageEditSize = (value: string) => IMAGE_EDIT_SIZE_MAP[value] || value

const getFontFamilyName = (family: number) => {
  switch (family) {
    case 1:
      return 'Virgil, "Segoe UI Emoji", sans-serif'
    case 2:
      return 'Helvetica, Arial, sans-serif'
    case 3:
      return '"Cascadia Code", "Segoe UI Emoji", monospace'
    case 5:
      return 'Excalifont, Virgil, "Segoe UI Emoji", sans-serif'
    default:
      return 'Helvetica, Arial, sans-serif'
  }
}

const getLatestElements = (elements: any[]) => {
  const scored: Array<{ element: any; ts: number }> = []
  for (const item of elements) {
    if (!item || item.isDeleted) continue
    const ts = Number.isFinite(item.updated) ? item.updated : 0
    scored.push({ element: item, ts })
  }
  scored.sort((a, b) => b.ts - a.ts)
  return {
    latest: scored[0]?.element || null,
    previous: scored[1]?.element || null,
  }
}

export default function CanvexPage() {
  const { t, i18n } = useTranslation('canvex')
  const [scenes, setScenes] = useState<SceneRecord[]>([])
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const [initialData, setInitialData] = useState<SceneData | null>(null)
  const [initialKey, setInitialKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const [, setChatByScene] = useState<Record<string, ChatMessage[]>>({})
  const [chatInput, setChatInput] = useState('')
  const [chatLoadingByScene, setChatLoadingByScene] = useState<Record<string, boolean>>({})
  const [loadingIconIndex, setLoadingIconIndex] = useState(0)
  const [chatStatusByScene, setChatStatusByScene] = useState<Record<string, 'idle' | 'success' | 'error' | 'exiting'>>({})
  const [exitingStatusByScene, setExitingStatusByScene] = useState<Record<string, 'success' | 'error' | null>>({})
  const [lastPinnedId, setLastPinnedId] = useState<string | null>(null)
  const [pinFlashRect, setPinFlashRect] = useState<PinRect | null>(null)
  const [selectedEditIds, setSelectedEditIds] = useState<string[]>([])
  const [selectedEditKey, setSelectedEditKey] = useState<string | null>(null)
  const [selectedEditRect, setSelectedEditRect] = useState<PinRect | null>(null)
  const [selectedEditPreview, setSelectedEditPreview] = useState<string | null>(null)
  const [previewAnchor, setPreviewAnchor] = useState<HoverAnchor | null>(null)
  const [imageEditPrompt, setImageEditPrompt] = useState('')
  const [imageEditSize, setImageEditSize] = useState('')
  const [imageEditCount, setImageEditCount] = useState(1)
  const [imageEditError, setImageEditError] = useState<string | null>(null)
  const [imageEditPendingIds, setImageEditPendingIds] = useState<string[]>([])
  const [searchParams, setSearchParams] = useSearchParams()
  const [videoOverlayItems, setVideoOverlayItems] = useState<VideoOverlayItem[]>([])
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [, forceVideoOverlayRefresh] = useReducer((value: number) => (value + 1) % 1000000, 0)
  const [canvexReady, setCanvexReady] = useState(false)
  const [videoEditPendingCountByKey, setVideoEditPendingCountByKey] = useState<Record<string, number>>({})
  const [videoEditStatusByKey, setVideoEditStatusByKey] = useState<Record<string, string | null>>({})
  const [videoEditErrorByKey, setVideoEditErrorByKey] = useState<Record<string, string | null>>({})
  const untitledRef = useRef('Untitled')

  const canvexApiRef = useRef<any>(null)
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  const saveStatusRef = useRef<HTMLDivElement | null>(null)
  const sceneIdRef = useRef<string | null>(null)
  const currentSceneRef = useRef<SceneData | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const pendingRef = useRef<SceneData | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const workspaceKeyRef = useRef('canvex:workspace:public')
  const pinOriginRef = useRef<PinOrigin | null>(null)
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastPinnedIdRef = useRef<string | null>(null)
  const imagePlaceholderQueueRef = useRef<ImagePlaceholder[]>([])
  const scrollUnsubRef = useRef<null | (() => void)>(null)
  const previewUrlRef = useRef<string | null>(null)
  const canvexThemeRef = useRef<'light' | 'dark'>('light')
  const videoOverlayKeyRef = useRef('')
  const videoOverlayRafRef = useRef<number | null>(null)
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

  const setSceneChatLoading = useCallback((sceneId: string | null, value: boolean) => {
    if (!sceneId) return
    setChatLoadingByScene(prev => ({ ...prev, [sceneId]: value }))
  }, [])

  const setSceneChatStatus = useCallback(
    (sceneId: string | null, value: 'idle' | 'success' | 'error' | 'exiting') => {
      if (!sceneId) return
      setChatStatusByScene(prev => ({ ...prev, [sceneId]: value }))
    },
    [],
  )

  const setSceneExitingStatus = useCallback(
    (sceneId: string | null, value: 'success' | 'error' | null) => {
      if (!sceneId) return
      setExitingStatusByScene(prev => ({ ...prev, [sceneId]: value }))
    },
    [],
  )

  const chatLoading = activeSceneId ? !!chatLoadingByScene[activeSceneId] : false
  const chatStatus = activeSceneId ? chatStatusByScene[activeSceneId] ?? 'idle' : 'idle'
  const exitingStatus = activeSceneId ? exitingStatusByScene[activeSceneId] ?? null : null

  const isVideoElement = useCallback((item: any) => {
    if (!item || item.type !== 'image') return false
    const data = item.customData || {}
    return data.aiChatType === 'note-video' || Boolean(data.aiVideoUrl)
  }, [])

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

  useEffect(() => {
    untitledRef.current = t('untitled', { defaultValue: 'Untitled' })
  }, [i18n.language, t])

  const saveStatusMeta = useMemo(() => {
    if (loading || loadError) return null
    if (saveState === 'saving') {
      return { label: t('saveSaving', { defaultValue: 'Saving…' }), tone: 'warn' as const }
    }
    if (saveState === 'pending') {
      return { label: t('savePending', { defaultValue: 'Unsaved changes' }), tone: 'warn' as const }
    }
    if (saveState === 'error') {
      return { label: t('saveFailed', { defaultValue: 'Save failed' }), tone: 'error' as const }
    }
    if (!activeSceneId) {
      return { label: t('saveDraft', { defaultValue: 'Draft · local only' }), tone: 'muted' as const }
    }
    if (saveState === 'saved') {
      return { label: t('saveSaved', { defaultValue: 'Saved' }), tone: 'muted' as const }
    }
    return null
  }, [activeSceneId, loadError, loading, saveState, t])

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

  const sceneParam = searchParams.get('scene')

  const canvexLangCode = useMemo(() => {
    const code = (i18n.language || 'en').toLowerCase()
    if (code.startsWith('zh')) return 'zh-CN'
    return 'en'
  }, [i18n.language])

  const activeScene = useMemo(
    () => scenes.find((scene) => scene.id === activeSceneId) || null,
    [scenes, activeSceneId]
  )

  const isPregeneratedSpace = useMemo(() => {
    const name = String(activeScene?.title || '').trim().toLowerCase()
    if (!name) return false
    return (
      name.includes('预生成')
      || name.includes('pregenerate')
      || name.includes('pre-generate')
      || name.includes('pre generated')
    )
  }, [activeScene?.title])

  const canShowAiEditBar = !!activeSceneId && !isPregeneratedSpace

  const imageEditStyle = useMemo(() => {
    if (!canShowAiEditBar || !selectedEditRect) return null
    return {
      left: Math.max(8, selectedEditRect.x),
      top: Math.max(8, selectedEditRect.y - 44),
    }
  }, [canShowAiEditBar, selectedEditRect])

  const previewFloatingStyle = useMemo(() => {
    if (!previewAnchor || typeof window === 'undefined') return null
    const size = 192
    const padding = 12
    let left = previewAnchor.x
    let top = previewAnchor.y - size - padding
    if (top < 8) {
      top = previewAnchor.y + previewAnchor.height + padding
    }
    if (left + size > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - size - 8)
    }
    return { left, top }
  }, [previewAnchor])

  const isEditingSelected = useMemo(() => {
    if (!selectedEditKey) return false
    return imageEditPendingIds.includes(selectedEditKey)
  }, [imageEditPendingIds, selectedEditKey])

  const isVideoGeneratingSelected = useMemo(() => {
    if (!selectedEditKey) return false
    return (videoEditPendingCountByKey[selectedEditKey] || 0) > 0
  }, [selectedEditKey, videoEditPendingCountByKey])

  const videoEditStatus = useMemo(() => {
    if (!selectedEditKey) return null
    return videoEditStatusByKey[selectedEditKey] || null
  }, [selectedEditKey, videoEditStatusByKey])

  const videoEditError = useMemo(() => {
    if (!selectedEditKey) return null
    return videoEditErrorByKey[selectedEditKey] || null
  }, [selectedEditKey, videoEditErrorByKey])

  const videoEditStatusTone = useMemo(() => {
    if (!videoEditStatus) return 'text-muted-foreground'
    if (videoEditError || videoEditStatus === t('editVideoFailed', { defaultValue: '失败' })) return 'text-destructive'
    if (videoEditStatus === t('editVideoDone', { defaultValue: '已完成' })) return 'text-emerald-600'
    return 'text-muted-foreground'
  }, [t, videoEditError, videoEditStatus])

  const scheduleVideoOverlayRefresh = useCallback(() => {
    if (!videoOverlayKeyRef.current) return
    if (videoOverlayRafRef.current) return
    videoOverlayRafRef.current = window.requestAnimationFrame(() => {
      videoOverlayRafRef.current = null
      forceVideoOverlayRefresh()
    })
  }, [forceVideoOverlayRefresh])

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

  const setSceneIdSafe = useCallback((id: string | null) => {
    sceneIdRef.current = id
    setActiveSceneId(id)
  }, [])

  const updateSceneParam = useCallback((id: string | null, replace = true) => {
    const next = new URLSearchParams(searchParams)
    if (id) {
      next.set('scene', id)
    } else {
      next.delete('scene')
    }
    setSearchParams(next, { replace })
  }, [searchParams, setSearchParams])

  const getSceneKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:scene:${id || 'draft'}`,
    []
  )

  const getLastKey = useCallback(() => `${workspaceKeyRef.current}:last`, [])

  const getChatKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat:${id || 'draft'}`,
    []
  )

  const getPinLastKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat-pin-last:${id || 'draft'}`,
    []
  )

  const getPinOriginKey = useCallback(
    (id?: string | null) => `${workspaceKeyRef.current}:chat-pin-origin:${id || 'draft'}`,
    []
  )

  const writeLocalCache = useCallback(
    (sceneId: string | null, data: SceneData) => {
      try {
        const payload: LocalCache = {
          sceneId,
          data,
          updatedAt: new Date().toISOString(),
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

  const loadChatForScene = useCallback(async (sceneId: string | null) => {
    const key = getChatKey(sceneId)
    const sceneKey = sceneId || 'draft'
    const token = ++chatLoadTokenRef.current

    const normalizeMessage = (item: any): ChatMessage | null => {
      if (!item || typeof item !== 'object') return null
      const role = item.role === 'user' || item.role === 'assistant' ? item.role : null
      if (!role) return null
      const content = typeof item.content === 'string' ? item.content : ''
      const createdAt = typeof item.created_at === 'string' ? item.created_at : new Date().toISOString()
      const rawId = typeof item.id === 'string' ? item.id : ''
      const id = rawId || `${role}-${createdAt}-${Math.random().toString(16).slice(2, 10)}`
      return { id, role, content, created_at: createdAt }
    }

    const sortByCreatedAt = (a: ChatMessage, b: ChatMessage) => {
      const ta = Date.parse(a.created_at || '')
      const tb = Date.parse(b.created_at || '')
      const va = Number.isFinite(ta) ? ta : 0
      const vb = Number.isFinite(tb) ? tb : 0
      if (va !== vb) return va - vb
      return a.id.localeCompare(b.id)
    }

    const mergeMessages = (server: ChatMessage[], local: ChatMessage[]) => {
      const merged = new Map<string, ChatMessage>()
      const signatureSeen = new Set<string>()
      for (const item of [...server, ...local]) {
        const msg = normalizeMessage(item)
        if (!msg) continue
        const normalizedTime = String(msg.created_at || '').slice(0, 19)
        const signature = `${msg.role}|${msg.content.trim()}|${normalizedTime}`
        if (signatureSeen.has(signature)) continue
        signatureSeen.add(signature)
        merged.set(msg.id, msg)
      }
      return Array.from(merged.values()).sort(sortByCreatedAt)
    }

    let localMessages: ChatMessage[] = []
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          localMessages = (parsed
            .map((item: any) => normalizeMessage(item))
            .filter(Boolean) as ChatMessage[])
            .sort(sortByCreatedAt)
        }
      }
    } catch {
      localMessages = []
    }

    if (chatLoadTokenRef.current !== token) return
    setChatByScene(prev => ({ ...prev, [sceneKey]: localMessages }))

    if (!sceneId) return

    try {
      const res = await request.get(`/api/v1/excalidraw/scenes/${sceneId}/chat/`, {
        params: { limit: 50 },
      })
      if (chatLoadTokenRef.current !== token) return
      const payload = Array.isArray(res.data?.results)
        ? res.data.results
        : Array.isArray(res.data)
          ? res.data
          : []
      const serverMessages = payload
        .map((item: any) => normalizeMessage(item))
        .filter(Boolean) as ChatMessage[]
      const merged = mergeMessages(serverMessages, localMessages)
      setChatByScene(prev => ({ ...prev, [sceneKey]: merged }))
      try {
        localStorage.setItem(key, JSON.stringify(merged))
      } catch {}
    } catch {
      // keep local fallback only
    }
  }, [getChatKey])

  const persistChatForScene = useCallback((sceneId: string | null, messages: ChatMessage[]) => {
    const key = getChatKey(sceneId)
    try {
      localStorage.setItem(key, JSON.stringify(messages))
    } catch {}
  }, [getChatKey])

  const migrateDraftChatToScene = useCallback((sceneId: string) => {
    const draftKey = getChatKey(null)
    const targetKey = getChatKey(sceneId)
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) {
        localStorage.setItem(targetKey, raw)
        localStorage.removeItem(draftKey)
      }
    } catch {}
    setChatByScene(prev => {
      const draft = prev.draft
      if (!draft || draft.length === 0) return prev
      const next = { ...prev }
      next[sceneId] = draft
      delete next.draft
      return next
    })
  }, [getChatKey])

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
  }, [getPinLastKey])

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
  }, [getPinOriginKey])

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

  const fetchUserKey = useCallback(async () => {
    workspaceKeyRef.current = `canvex:workspace:${WORKSPACE_KEY}`
    return WORKSPACE_KEY
  }, [])

  const sanitizeAppState = (appState?: Record<string, any>) => {
    if (!appState) return {}
    const { collaborators, ...rest } = appState
    return rest
  }

  const normalizeScenePayload = useCallback((scene?: SceneData | null): { normalized: SceneData; fingerprint: string } => {
    const baseElements = Array.isArray(scene?.elements) ? scene!.elements! : []
    const baseAppState = scene?.appState && typeof scene.appState === 'object'
      ? sanitizeAppState(scene.appState)
      : {}
    const baseFiles = scene?.files && typeof scene.files === 'object' ? scene.files : {}

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
  }, [])

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
  }, [resolveCanvexTheme])

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

  const applyScene = useCallback((scene?: SceneData | null) => {
    if (!scene) return
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
      setVideoOverlayItems(nextVideos)
    }
    if (!lastPinnedIdRef.current) {
      const { latest } = getLatestElements(scene.elements || [])
      if (latest?.id) {
        lastPinnedIdRef.current = latest.id
        setLastPinnedId(latest.id)
      }
    }
    syncCanvexTheme(scene.appState?.theme)
  }, [syncCanvexTheme])

  const getSceneFingerprint = useCallback((scene: SceneData) => {
    return normalizeScenePayload(scene).fingerprint
  }, [normalizeScenePayload])

  const persistSceneToList = useCallback((sceneId: string, data: SceneData, title?: string) => {
    setScenes((prev) => {
      const existing = prev.find((scene) => scene.id === sceneId)
      const nextTitle = title ?? existing?.title ?? untitledRef.current
      const updated = {
        ...existing,
        id: sceneId,
        title: nextTitle,
        data,
        updated_at: new Date().toISOString(),
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
  }, [normalizeScenePayload])

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
        writeLocalCache(sceneIdRef.current, data)

        try {
          if (sceneIdRef.current) {
            await request.patch(`/api/v1/excalidraw/scenes/${sceneIdRef.current}/`, { data })
            persistSceneToList(sceneIdRef.current, data)
          } else {
            const title = (activeScene?.title || '').trim() || untitledRef.current
            const payload = { title, data }
            const res = await request.post('/api/v1/excalidraw/scenes/', payload)
            const newId = res.data?.id ? String(res.data.id) : null
            if (newId) {
              setSceneIdSafe(newId)
              persistSceneToList(newId, data, title)
              migrateDraftChatToScene(newId)
              migrateDraftPinOriginToScene(newId)
              migrateDraftLastPinnedToScene(newId)
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
  }, [activeScene?.title, getLastKey, migrateDraftChatToScene, migrateDraftLastPinnedToScene, migrateDraftPinOriginToScene, normalizeScenePayload, persistSceneToList, setSceneIdSafe, writeLocalCache])

  const queueUrgentSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave()
    }, SCENE_SAVE_URGENT_MS)
  }, [flushSave])

  const queueSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave()
    }, SCENE_SAVE_DEBOUNCE_MS)
  }, [flushSave])

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
  }, [flushSave, hasUnsavedChanges, saveState])

  useEffect(() => {
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
        flushNow()
        return
      }
      if (document.visibilityState === 'visible') {
        queueNow()
      }
    }
    const handleBeforeUnload = () => {
      if (!hasUnsavedChanges()) return
      try {
        if (currentSceneRef.current) {
          writeLocalCache(sceneIdRef.current, currentSceneRef.current)
        }
      } catch {}
      flushNow()
    }
    const handlePageHide = () => flushNow()
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
  }, [flushSave, hasUnsavedChanges, queueUrgentSave, writeLocalCache])

  const selectScene = useCallback(
    async (scene: SceneRecord, opts?: { skipFlush?: boolean; skipUrl?: boolean }) => {
      if (!scene?.id) return
      if (scene.id === activeSceneId) return

      if (!opts?.skipFlush) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
        await flushSave()
      }

      const local = readLocalCache(scene.id)
      const serverUpdated = scene.updated_at ? new Date(scene.updated_at).getTime() : 0
      const localUpdated = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0

      if (local && localUpdated > serverUpdated && local.data) {
        const localData = normalizeScenePayload(local.data).normalized
        setSceneIdSafe(scene.id)
        applyScene(localData)
        pendingRef.current = localData
        lastSavedRef.current = null
        lastMutationAtRef.current = Date.now()
        setSaveState('pending')
        queueSave()
      } else {
        const serverData = normalizeScenePayload(scene.data || {}).normalized
        setSceneIdSafe(scene.id)
        applyScene(serverData)
        pendingRef.current = null
        lastSavedRef.current = getSceneFingerprint(serverData)
        writeLocalCache(scene.id, serverData)
        setSaveState('saved')
      }

      try {
        localStorage.setItem(getLastKey(), scene.id)
      } catch {}

      if (!opts?.skipUrl) {
        updateSceneParam(scene.id)
      }
    },
    [activeSceneId, applyScene, flushSave, getLastKey, getSceneFingerprint, normalizeScenePayload, queueSave, readLocalCache, setSceneIdSafe, updateSceneParam, writeLocalCache]
  )

  const loadScene = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    await fetchUserKey()

    const localDraft = readLocalCache(null)

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

      setScenes(list)

      const lastId = (() => {
        try {
          return localStorage.getItem(getLastKey())
        } catch {
          return null
        }
      })()

      const preferredFromParam = sceneParam && list.find(scene => scene.id === sceneParam)
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
  }, [applyScene, clearLocalCache, fetchUserKey, getLastKey, normalizeScenePayload, readLocalCache, sceneParam, selectScene, updateSceneParam])

  // Cycle through loading icons
  const loadingIcons = useMemo(() => [IconCat, IconButterfly, IconDog, IconFish, IconPaw], [])
  const chatSuccessRef = useRef(false)
  const chatStartTimeRef = useRef<number>(0)
  const [chatElapsedTime, setChatElapsedTime] = useState<number>(0)
  
  // Auto-hide status after 2 seconds with exit animation (per scene)
  useEffect(() => {
    if (!activeSceneId) return
    if (chatStatus === 'idle' || chatStatus === 'exiting') return
    setSceneExitingStatus(activeSceneId, chatStatus as 'success' | 'error')
    const exitTimeout = window.setTimeout(() => {
      setSceneChatStatus(activeSceneId, 'exiting')
      window.setTimeout(() => setSceneChatStatus(activeSceneId, 'idle'), 300)
    }, 2000)
    return () => window.clearTimeout(exitTimeout)
  }, [activeSceneId, chatStatus, setSceneChatStatus, setSceneExitingStatus])

  useEffect(() => {
    if (!chatLoading) {
      setLoadingIconIndex(0)
      return
    }
    const interval = setInterval(() => {
      setLoadingIconIndex((prev) => (prev + 1) % loadingIcons.length)
    }, 500)
    return () => clearInterval(interval)
  }, [chatLoading, loadingIcons.length])

  useEffect(() => {
    loadScene()
    const handler = () => loadScene()
    window.addEventListener('canvex:scenes-changed', handler)
    return () => {
      window.removeEventListener('canvex:scenes-changed', handler)
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [loadScene])

  useEffect(() => {
    if (!sceneParam) return
    if (sceneParam === activeSceneId) return
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
          return [record, ...filtered]
        })
        void selectScene(record, { skipUrl: true })
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeSceneId, sceneParam, scenes, selectScene])

  useEffect(() => {
    void loadChatForScene(activeSceneId)
    setChatInput('')
    loadPinOriginForScene(activeSceneId)
    loadLastPinnedForScene(activeSceneId)
  }, [activeSceneId, loadChatForScene, loadLastPinnedForScene, loadPinOriginForScene])

  useEffect(() => {
    setImageEditPrompt('')
    setImageEditError(null)
  }, [selectedEditKey])

  useEffect(() => {
    return () => {
      if (scrollUnsubRef.current) {
        scrollUnsubRef.current()
        scrollUnsubRef.current = null
      }
    }
  }, [])


  const appendChatMessageForScene = useCallback((sceneId: string | null, message: ChatMessage) => {
    const key = sceneId || 'draft'
    setChatByScene(prev => {
      const current = prev[key] || []
      const next = [...current, message]
      persistChatForScene(sceneId, next)
      return { ...prev, [key]: next }
    })
  }, [persistChatForScene])

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
  }, [])

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
  }, [])

  const getSelectedElementsByIds = useCallback((ids: string[]) => {
    if (!ids.length) return []
    const api = canvexApiRef.current
    const elements = api?.getSceneElements?.()
    if (!Array.isArray(elements)) return []
    return elements.filter((item: any) => ids.includes(item?.id) && !item?.isDeleted)
  }, [])

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
  }, [])

  useEffect(() => {
    let cancelled = false
    const api = canvexApiRef.current
    if (!canShowAiEditBar || !selectedEditKey || !selectedEditIds.length || !api?.getFiles) {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
      setSelectedEditPreview(null)
      return
    }
    const selectedElements = getSelectedElementsByIds(selectedEditIds)
    const exportElements = selectedElements.filter((item: any) => item && !isVideoElement(item))
    const bounds = getSelectionBounds(exportElements)
    if (!exportElements.length || !bounds) {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
      setSelectedEditPreview(null)
      return
    }
    const appState = api.getAppState?.() || {}
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
    const previewSize = 192
    const targetSize = previewSize * dpr
    const scale = bounds.width > 0 && bounds.height > 0
      ? Math.min(targetSize / bounds.width, targetSize / bounds.height)
      : 1

    exportToBlob({
      elements: exportElements,
      appState: {
        exportBackground: false,
        viewBackgroundColor: appState.viewBackgroundColor,
      },
      files: api.getFiles(),
      mimeType: MIME_TYPES.png,
      exportPadding: 4,
      getDimensions: (width, height) => ({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
      }),
    }).then((blob) => {
      if (cancelled) return
      const url = URL.createObjectURL(blob)
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
      previewUrlRef.current = url
      setSelectedEditPreview(url)
    }).catch(() => {
      if (cancelled) return
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
      setSelectedEditPreview(null)
    })

    return () => {
      cancelled = true
    }
  }, [canShowAiEditBar, getSelectedElementsByIds, getSelectionBounds, isVideoElement, selectedEditIds, selectedEditKey])

  useEffect(() => {
    if (canShowAiEditBar) return
    if (selectedEditKey !== null || selectedEditRect !== null || selectedEditIds.length) {
      setSelectedEditIds([])
      setSelectedEditKey(null)
      setSelectedEditRect(null)
    }
    setPreviewAnchor(null)
  }, [canShowAiEditBar, selectedEditIds.length, selectedEditKey, selectedEditRect])

  const updateSelectedEditSelection = useCallback((appStateOverride?: any) => {
    scheduleVideoOverlayRefresh()
    const api = canvexApiRef.current
    if (!api?.getSceneElements || !api?.getAppState) return
    if (!canShowAiEditBar) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const appState = appStateOverride || api.getAppState()
    const selectedIds = appState?.selectedElementIds || {}
    const ids = Object.keys(selectedIds).filter((key) => selectedIds[key])
    if (!ids.length) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const selectedElements = getSelectedElementsByIds(ids)
    if (!selectedElements.length) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const editableElements = selectedElements.filter((item: any) => {
      if (!item || item.isDeleted) return false
      return !isVideoElement(item)
    })
    if (!editableElements.length) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const hasImageTrigger = editableElements.some((item: any) => String(item?.type || '').toLowerCase() === 'image')
    if (!hasImageTrigger) {
      if (selectedEditKey !== null || selectedEditRect !== null || selectedEditIds.length) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const bounds = getSelectionBounds(editableElements)
    if (!bounds) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const rect = getSceneRectViewportRect(bounds, appState)
    if (!rect) {
      if (selectedEditKey !== null || selectedEditRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const nextIds = editableElements.map((item: any) => String(item.id)).sort()
    const nextKey = nextIds.join('|')
    const sameRect = selectedEditRect
      && Math.abs(selectedEditRect.x - rect.x) < 0.5
      && Math.abs(selectedEditRect.y - rect.y) < 0.5
      && Math.abs(selectedEditRect.width - rect.width) < 0.5
      && Math.abs(selectedEditRect.height - rect.height) < 0.5
    if (selectedEditKey === nextKey && sameRect) return
    setSelectedEditIds(nextIds)
    setSelectedEditKey(nextKey)
    setSelectedEditRect(rect)
  }, [canShowAiEditBar, getSceneRectViewportRect, getSelectedElementsByIds, getSelectionBounds, isVideoElement, scheduleVideoOverlayRefresh, selectedEditIds.length, selectedEditKey, selectedEditRect])

  const flashPinnedElement = useCallback((element: any) => {
    const rect = getElementViewportRect(element)
    if (!rect) return
    setPinFlashRect(rect)
    window.setTimeout(() => {
      setPinFlashRect(null)
    }, 700)
  }, [getElementViewportRect])

  const handleChange = useCallback(
    (elements: any[], appState: any, files: any) => {
      const { normalized: scene, fingerprint } = normalizeScenePayload({
        elements,
        appState: sanitizeAppState(appState),
        files,
      })
      const nextVideos: VideoOverlayItem[] = []
      for (const element of elements || []) {
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
        setVideoOverlayItems(nextVideos)
      }
      currentSceneRef.current = scene
      pendingRef.current = scene
      if (!lastPinnedIdRef.current) {
        const { latest } = getLatestElements(elements)
        if (latest?.id) {
          lastPinnedIdRef.current = latest.id
          setLastPinnedId(latest.id)
        }
      }
      writeLocalCache(sceneIdRef.current, scene)
      if (fingerprint === lastSavedRef.current) {
        setSaveState('saved')
      } else {
        lastMutationAtRef.current = Date.now()
        setSaveState('pending')
        queueSave()
      }
      syncCanvexTheme(appState?.theme)
      updateSelectedEditSelection(appState)
    },
    [normalizeScenePayload, queueSave, syncCanvexTheme, updateSelectedEditSelection, writeLocalCache]
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
    writeLocalCache(sceneIdRef.current, scene)
    if (fingerprint === lastSavedRef.current) {
      setSaveState('saved')
    } else {
      lastMutationAtRef.current = Date.now()
      setSaveState('pending')
      queueSave()
    }
    syncCanvexTheme(appState?.theme)
    updateSelectedEditSelection(appState)
  }, [normalizeScenePayload, queueSave, syncCanvexTheme, updateSelectedEditSelection, writeLocalCache])

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
  }, [captureSceneSnapshot, getSceneElementsSafe, measurePinnedText])

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
  }, [getSceneElementsSafe, wrapChatText])

  const toErrorLabel = useCallback((value: any) => {
    if (!value) return '生成失败'
    const text = String(value)
    if (text.length > 60) return `生成失败：${text.slice(0, 60)}…`
    return `生成失败：${text}`
  }, [])

  const toVideoFailureLabel = useCallback((value: any) => {
    const fallback = t('editVideoRequestFailed', { defaultValue: '视频生成失败' })
    let detail = String(value ?? '').trim()
    if (!detail) return fallback

    // Strip repeated high-level failure prefixes from backend/provider messages.
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
  }, [getSceneElementsSafe])

  const enqueueImagePlaceholder = useCallback((placeholder: ImagePlaceholder | null) => {
    if (!placeholder) return
    imagePlaceholderQueueRef.current = [...imagePlaceholderQueueRef.current, placeholder]
  }, [])

  const takeNextImagePlaceholder = useCallback((sceneId: string | null) => {
    if (!sceneId) return null
    const queue = imagePlaceholderQueueRef.current
    const index = queue.findIndex((item) => item.sceneId === sceneId)
    if (index === -1) return null
    const next = queue[index]
    imagePlaceholderQueueRef.current = [...queue.slice(0, index), ...queue.slice(index + 1)]
    return next
  }, [])

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
  }, [updatePlaceholderText])

  const createPinnedNote = useCallback((sceneId: string | null, message: ChatMessage) => {
    if (sceneId !== sceneIdRef.current) return
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState) return
    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    const noteTexts = (existing || []).filter((item: any) => String(item?.customData?.aiChatType || '').startsWith('note-') && !item?.isDeleted)
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
    const stackedHeight = noteTexts.reduce((total, item: any) => total + (item.height || 0) + gap, 0)
    const x = baseX
    const y = baseY + stackedHeight
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
  }, [captureSceneSnapshot, createTextElement, flashPinnedElement, getSceneElementsSafe, measurePinnedText, persistLastPinnedForScene, persistPinOriginForScene])

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
  }, [captureSceneSnapshot, getSceneElementsSafe, measurePinnedText])

  const createImagePlaceholder = useCallback((sceneId: string | null, label: string, options?: PlaceholderOptions) => {
    if (sceneId !== sceneIdRef.current) return null
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState) return null
    const existing = getSceneElementsSafe()
    const appState = api.getAppState()
    const pinnedItems = (existing || []).filter((item: any) => String(item?.customData?.aiChatType || '').startsWith('note-') && !item?.isDeleted)
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
    const stackedHeight = pinnedItems.reduce((total, item: any) => total + (item.height || 0) + gap, 0)

    const width = 400
    const height = 400
    const groupId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    const placeholderType = options?.kind === 'video' ? 'note-video-placeholder' : 'note-image-placeholder'
    const jobId = options?.jobId ? String(options.jobId) : null

    const rect = createRectElement({
      x: baseX,
      y: baseY + stackedHeight,
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
      x: baseX + 12,
      y: baseY + stackedHeight + 12,
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
    return { sceneId, groupId, rectId: rect.id, textId: text.id }
  }, [createRectElement, createTextElement, flashPinnedElement, getSceneElementsSafe, persistLastPinnedForScene, persistPinOriginForScene])

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
  }, [captureSceneSnapshot, getSceneElementsSafe])

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
    return {
      sceneId,
      groupId,
      rectId,
      textId,
    }
  }, [])

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
      const groupId = String(groupIds[0])
      if (!groups[groupId]) {
        groups[groupId] = {}
      }
      if (isVideoType) {
        groups[groupId].isVideo = true
      }
      if (data.aiVideoJobId) {
        groups[groupId].hasJobId = true
      }
      if (data.aiChatCreatedAt) {
        const createdAtTs = Date.parse(String(data.aiChatCreatedAt))
        if (Number.isFinite(createdAtTs)) {
          const prevCreatedAt = groups[groupId].createdAt
          if (!prevCreatedAt || createdAtTs < prevCreatedAt) {
            groups[groupId].createdAt = createdAtTs
          }
        }
      }
      if (element.type === 'rectangle') {
        groups[groupId].rectId = element.id
      } else if (element.type === 'text') {
        groups[groupId].textId = element.id
        if (!groups[groupId].isVideo && typeof element.text === 'string' && element.text.includes('视频')) {
          groups[groupId].isVideo = true
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
    const [groupId, value] = candidates[0]
    return {
      sceneId,
      groupId,
      rectId: value.rectId!,
      textId: value.textId!,
    }
  }, [])

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

  const findImageEditPlaceholdersByJobId = useCallback((sceneId: string | null, jobId: string | null) => {
    if (!sceneId || !jobId) return [] as ImagePlaceholder[]
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return []
    const elements = api.getSceneElements()
    if (!Array.isArray(elements)) return []
    const groups: Record<string, { rectId?: string; textId?: string; order?: number; x?: number }> = {}
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const data = element.customData || {}
      if (data.aiEditType !== 'image-placeholder') continue
      if (data.aiEditJobId !== jobId) continue
      const groupIds = Array.isArray(element.groupIds) ? element.groupIds : []
      if (!groupIds.length) continue
      const groupId = String(groupIds[0])
      if (!groups[groupId]) {
        groups[groupId] = {}
      }
      const order = Number(data.aiEditOrder)
      if (Number.isFinite(order)) {
        groups[groupId].order = order
      }
      if (element.type === 'rectangle') {
        groups[groupId].rectId = element.id
        groups[groupId].x = Number(element.x) || 0
      } else if (element.type === 'text') {
        groups[groupId].textId = element.id
      }
    }
    const placeholders = Object.entries(groups)
      .filter(([, value]) => value.rectId && value.textId)
      .map(([groupId, value]) => ({
        sceneId,
        groupId,
        rectId: value.rectId!,
        textId: value.textId!,
        order: Number.isFinite(value.order) ? value.order : null,
        x: Number.isFinite(value.x) ? value.x : 0,
      }))
      .sort((a, b) => {
        if (a.order !== null && b.order !== null && a.order !== b.order) {
          return a.order - b.order
        }
        return (a.x || 0) - (b.x || 0)
      })
      .map(({ order, x, ...rest }) => rest)
    return placeholders
  }, [])

  const findOrphanImageEditPlaceholders = useCallback((sceneId: string | null) => {
    if (!sceneId) return [] as ImagePlaceholder[]
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return []
    const elements = api.getSceneElements()
    if (!Array.isArray(elements)) return []
    const groups: Record<string, { rectId?: string; textId?: string; hasJobId?: boolean; order?: number; x?: number }> = {}
    for (const element of elements) {
      if (!element || element.isDeleted) continue
      const data = element.customData || {}
      if (data.aiEditType !== 'image-placeholder') continue
      const groupIds = Array.isArray(element.groupIds) ? element.groupIds : []
      if (!groupIds.length) continue
      const groupId = String(groupIds[0])
      if (!groups[groupId]) {
        groups[groupId] = {}
      }
      if (data.aiEditJobId) {
        groups[groupId].hasJobId = true
      }
      const order = Number(data.aiEditOrder)
      if (Number.isFinite(order)) {
        groups[groupId].order = order
      }
      if (element.type === 'rectangle') {
        groups[groupId].rectId = element.id
        groups[groupId].x = Number(element.x) || 0
      } else if (element.type === 'text') {
        groups[groupId].textId = element.id
      }
    }
    return Object.entries(groups)
      .filter(([, value]) => !value.hasJobId && value.rectId && value.textId)
      .map(([groupId, value]) => ({
        sceneId,
        groupId,
        rectId: value.rectId!,
        textId: value.textId!,
        order: Number.isFinite(value.order) ? value.order : null,
        x: Number.isFinite(value.x) ? value.x : 0,
      }))
      .sort((a, b) => {
        if (a.order !== null && b.order !== null && a.order !== b.order) {
          return a.order - b.order
        }
        return (a.x || 0) - (b.x || 0)
      })
      .map(({ order, x, ...rest }) => rest)
  }, [])

  const createEditImagePlaceholders = useCallback((sceneId: string | null, bounds: SelectionBounds, label: string, count = 1) => {
    if (sceneId !== sceneIdRef.current) return []
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements) return []
    const existing = getSceneElementsSafe()
    const width = Math.max(160, Math.round(Number(bounds?.width) || 320))
    const height = Math.max(120, Math.round(Number(bounds?.height) || 200))
    const gap = 16
    const baseX = (Number(bounds?.x) || 0) + (Number(bounds?.width) || width) + gap
    const baseY = Number(bounds?.y) || 0

    const placeholders: ImagePlaceholder[] = []
    const newElements: any[] = []
    const fontSize = 16
    const total = Math.max(1, Math.min(4, Math.round(count)))
    for (let index = 0; index < total; index += 1) {
      const x = baseX + (width + gap) * index
      const y = baseY
      const groupId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

      const rect = createRectElement({
        x,
        y,
        width,
        height,
        groupIds: [groupId],
        customData: {
          aiEditType: 'image-placeholder',
          aiEditStatus: 'pending',
          aiEditCreatedAt: new Date().toISOString(),
          aiEditOrder: index,
        },
      })
      const text = createTextElement({
        x: x + 12,
        y: y + 12,
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
          aiEditType: 'image-placeholder',
          aiEditStatus: 'pending',
          aiEditCreatedAt: new Date().toISOString(),
          aiEditOrder: index,
        },
      })

      newElements.push(rect, text)
      placeholders.push({ sceneId, groupId, rectId: rect.id, textId: text.id })
    }

    api.updateScene({
      elements: [...(existing || []), ...newElements],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    if (newElements.length) {
      const firstRect = newElements.find((item: any) => item?.type === 'rectangle')
      if (firstRect) {
        window.setTimeout(() => {
          flashPinnedElement(firstRect)
        }, 120)
      }
    }
    return placeholders
  }, [createRectElement, createTextElement, flashPinnedElement, getSceneElementsSafe])

  const loadImageDataUrl = useCallback(async (url: string, maxDim = MAX_INSERT_IMAGE_DIM) => {
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
      if (!maxDim || maxSide <= maxDim) {
        const dataUrl = await toDataUrl(blob)
        bitmap.close?.()
        return { dataUrl, width: bitmap.width, height: bitmap.height }
      }
      const scale = maxDim / maxSide
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
      return { dataUrl: canvas.toDataURL('image/png'), width: targetWidth, height: targetHeight }
    } catch {
      const dataUrl = await toDataUrl(blob)
      return { dataUrl, width: null, height: null }
    }
  }, [])

  const resolveVideoImageUrls = useCallback(async (sceneId: string, imageElements: any[]) => {
    const api = canvexApiRef.current
    if (!api?.getFiles || !api?.getSceneElements || !api?.updateScene) {
      return { urls: [] as string[], allResolved: false }
    }
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
      captureSceneSnapshot()
    }

    return { urls, allResolved }
  }, [captureSceneSnapshot, getSceneElementsSafe])

  const insertEditedImage = useCallback(async (
    bounds: SelectionBounds,
    result: ToolResult['result'],
    placeholder?: ImagePlaceholder | null,
  ) => {
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.addFiles) return false
    const url = result?.url
    if (!url) return false

    const findDuplicateEditedImage = (
      elements: any[],
      assetId: string | null,
      editJobId: string | null,
      editOrder: number | null,
    ) => {
      if (!Array.isArray(elements) || !elements.length) return false
      if (assetId) {
        const duplicatedByAsset = elements.some((element: any) => {
          if (!element || element.isDeleted || element.type !== 'image') return false
          const data = element.customData || {}
          return String(data.aiEditAssetId || data.aiChatAssetId || '') === assetId
        })
        if (duplicatedByAsset) return true
      }
      if (editJobId && Number.isFinite(editOrder)) {
        const duplicatedByOrder = elements.some((element: any) => {
          if (!element || element.isDeleted || element.type !== 'image') return false
          const data = element.customData || {}
          return String(data.aiEditJobId || '') === editJobId && Number(data.aiEditOrder) === Number(editOrder)
        })
        if (duplicatedByOrder) return true
      }
      return false
    }

    const removePlaceholderIfPresent = (elements: any[]) => {
      if (!placeholder) return false
      const deleteIds = new Set([placeholder.rectId, placeholder.textId])
      const now = Date.now()
      let changed = false
      const nextElements = elements.map((item: any) => {
        if (!item || !deleteIds.has(item.id) || item.isDeleted) return item
        changed = true
        return {
          ...item,
          isDeleted: true,
          updated: now,
          version: (item.version || 0) + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        }
      })
      if (!changed) return false
      api.updateScene({
        elements: nextElements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      captureSceneSnapshot()
      queueUrgentSave()
      return true
    }

    let existing = getSceneElementsSafe()
    const placeholderElement = placeholder
      ? existing.find((item: any) => item?.id === placeholder.rectId || item?.id === placeholder.textId)
      : null
    const placeholderMeta = placeholderElement?.customData || {}
    const editJobId = placeholderMeta?.aiEditJobId ? String(placeholderMeta.aiEditJobId) : null
    const orderRaw = Number(placeholderMeta?.aiEditOrder)
    const editOrder = Number.isFinite(orderRaw) ? orderRaw : null
    const editAssetId = result?.asset_id ? String(result.asset_id) : null

    if (findDuplicateEditedImage(existing, editAssetId, editJobId, editOrder)) {
      removePlaceholderIfPresent(existing)
      return true
    }

    let dataURL = ''
    let decodedWidth: number | null = null
    let decodedHeight: number | null = null
    try {
      const loaded = await loadImageDataUrl(url)
      dataURL = loaded.dataUrl
      decodedWidth = loaded.width
      decodedHeight = loaded.height
    } catch {
      return false
    }

    const fileId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    api.addFiles([{
      id: fileId,
      dataURL,
      mimeType: result?.mime_type || 'image/png',
      created: Date.now(),
      lastRetrieved: Date.now(),
    }])

    existing = getSceneElementsSafe()
    if (findDuplicateEditedImage(existing, editAssetId, editJobId, editOrder)) {
      removePlaceholderIfPresent(existing)
      return true
    }
    const placeholderRect = placeholder
      ? existing.find((item: any) => item?.id === placeholder.rectId && !item?.isDeleted)
      : null
    const placeholderRectMeta = placeholderRect?.customData || {}
    const resolvedEditJobId = placeholderRectMeta?.aiEditJobId || editJobId
    const resolvedEditOrderRaw = Number(placeholderRectMeta?.aiEditOrder)
    const resolvedEditOrder = Number.isFinite(resolvedEditOrderRaw)
      ? resolvedEditOrderRaw
      : editOrder
    const naturalWidth = Number(result?.width) || decodedWidth || Number(bounds?.width) || 512
    const naturalHeight = Number(result?.height) || decodedHeight || Number(bounds?.height) || 512
    const targetWidth = placeholderRect
      ? Math.max(120, Math.round(placeholderRect.width || naturalWidth))
      : (Number(bounds?.width) || naturalWidth)
    const targetHeight = placeholderRect
      ? Math.max(120, Math.round(placeholderRect.height || naturalHeight))
      : (Number(bounds?.height) || naturalHeight)
    const scale = naturalWidth > 0 && naturalHeight > 0
      ? Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
      : 1
    const width = Math.max(80, Math.round(naturalWidth * scale))
    const height = Math.max(80, Math.round(naturalHeight * scale))
    let x = 0
    let y = 0
    if (placeholderRect) {
      x = (placeholderRect.x || 0) + (targetWidth - width) / 2
      y = (placeholderRect.y || 0) + (targetHeight - height) / 2
    } else {
      const gap = 16
      x = (Number(bounds?.x) || 0) + (Number(bounds?.width) || width) + gap
      y = Number(bounds?.y) || 0
    }

    const imageElement = createImageElement({
      x,
      y,
      width,
      height,
      fileId,
      status: 'saved',
      scale: [1, 1],
      customData: {
        aiEditSourceId: 'selection',
        aiEditAssetId: editAssetId || result?.asset_id,
        aiEditImageUrl: url,
        ...(resolvedEditJobId ? { aiEditJobId: resolvedEditJobId } : {}),
        ...(Number.isFinite(resolvedEditOrder) ? { aiEditOrder: resolvedEditOrder } : {}),
      },
    })

    const now = Date.now()
    const deleteIds = placeholder ? new Set([placeholder.rectId, placeholder.textId]) : null
    const mergedElements = (existing || []).map((item: any) => {
      if (!item || !deleteIds?.has(item.id)) return item
      return {
        ...item,
        isDeleted: true,
        updated: now,
        version: (item.version || 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      }
    })

    api.updateScene({
      elements: [...mergedElements, imageElement],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
    queueUrgentSave()
    return true
  }, [captureSceneSnapshot, createImageElement, getSceneElementsSafe, loadImageDataUrl, queueUrgentSave])

  const getPlaceholderBounds = useCallback((placeholder: ImagePlaceholder | null) => {
    if (!placeholder) return null
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return null
    const elements = api.getSceneElements()
    const rect = elements.find((item: any) => item?.id === placeholder.rectId && !item?.isDeleted)
    if (!rect) return null
    return {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Math.max(1, Number(rect.width) || 0),
      height: Math.max(1, Number(rect.height) || 0),
    }
  }, [])

  const insertEditedImageFromPlaceholder = useCallback(async (
    placeholder: ImagePlaceholder | null,
    result: ToolResult['result'],
  ) => {
    const bounds = getPlaceholderBounds(placeholder)
    if (!bounds) return false
    return insertEditedImage(bounds, result, placeholder)
  }, [getPlaceholderBounds, insertEditedImage])

  const pollImageEditJob = useCallback(async (
    jobId: string,
    sceneId: string,
    bounds: SelectionBounds,
    selectionKey: string,
    placeholders?: ImagePlaceholder[] | null,
  ) => {
    const pollKey = `${sceneId}:${jobId}`
    if (imagePollInFlightRef.current.has(pollKey)) return
    imagePollInFlightRef.current.add(pollKey)
    const maxAttempts = 60
    const delayMs = 2000
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const res = await request.get(`/api/v1/excalidraw/image-edit-jobs/${jobId}/`)
          const status = res.data?.status
          if (status === 'SUCCEEDED') {
            if (sceneIdRef.current === sceneId) {
              const results = Array.isArray(res.data?.results) ? res.data.results : null
              if (results && results.length) {
                const baseX = Number(bounds?.x) || 0
                const baseWidth = Number(bounds?.width) || 0
                const offset = baseWidth + 16
                let anyInserted = false
                for (let index = 0; index < results.length; index += 1) {
                  const result = results[index]
                  const usePlaceholder = placeholders?.[index] || null
                  const nextBounds = usePlaceholder
                    ? bounds
                    : { ...bounds, x: baseX + offset * index }
                  const inserted = await insertEditedImage(nextBounds, result, usePlaceholder)
                  if (inserted) anyInserted = true
                }
                if (!anyInserted && selectedEditKey === selectionKey) {
                  setImageEditError(t('editFailed', { defaultValue: 'Edit failed.' }))
                }
              } else {
                const result = res.data?.result
                const inserted = await insertEditedImage(bounds, result, placeholders?.[0] || null)
                if (!inserted && selectedEditKey === selectionKey) {
                  setImageEditError(t('editFailed', { defaultValue: 'Edit failed.' }))
                }
              }
            }
            return
          }
          if (status === 'FAILED') {
            if (placeholders && placeholders.length) {
              for (const item of placeholders) {
                updatePlaceholderText(item, toErrorLabel(res.data?.error || t('editFailed', { defaultValue: 'Edit failed.' })))
              }
            } else if (selectedEditKey === selectionKey) {
              setImageEditError(res.data?.error || t('editFailed', { defaultValue: 'Edit failed.' }))
            }
            return
          }
        } catch (error) {
          console.error('Poll image edit job failed', error)
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      if (placeholders && placeholders.length) {
        for (const item of placeholders) {
          updatePlaceholderText(item, toErrorLabel(t('editFailed', { defaultValue: 'Edit failed.' })))
        }
      } else if (selectedEditKey === selectionKey) {
        setImageEditError(t('editFailed', { defaultValue: 'Edit failed.' }))
      }
    } finally {
      imagePollInFlightRef.current.delete(pollKey)
    }
  }, [insertEditedImage, selectedEditKey, t, toErrorLabel, updatePlaceholderText])

  const pollImageEditJobForPlaceholders = useCallback(async (
    jobId: string,
    sceneId: string,
    placeholders: ImagePlaceholder[],
  ) => {
    const pollKey = `${sceneId}:${jobId}`
    if (imagePollInFlightRef.current.has(pollKey)) return
    imagePollInFlightRef.current.add(pollKey)
    const maxAttempts = 60
    const delayMs = 2000
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const res = await request.get(`/api/v1/excalidraw/image-edit-jobs/${jobId}/`)
          const status = res.data?.status
          if (status === 'SUCCEEDED') {
            if (sceneIdRef.current === sceneId) {
              const results = Array.isArray(res.data?.results)
                ? res.data.results
                : (res.data?.result ? [res.data.result] : [])
              if (results.length) {
                const ordered = [...results].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
                for (let index = 0; index < ordered.length; index += 1) {
                  const result = ordered[index]
                  const placeholder = placeholders[index] || null
                  if (placeholder) {
                    await insertEditedImageFromPlaceholder(placeholder, result)
                  }
                }
              } else {
                for (const item of placeholders) {
                  updatePlaceholderText(item, toErrorLabel(t('editFailed', { defaultValue: 'Edit failed.' })))
                }
              }
            }
            return
          }
          if (status === 'FAILED') {
            const error = res.data?.error || t('editFailed', { defaultValue: 'Edit failed.' })
            for (const item of placeholders) {
              updatePlaceholderText(item, toErrorLabel(error))
            }
            return
          }
        } catch (error) {
          console.error('Poll image edit job failed', error)
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      for (const item of placeholders) {
        updatePlaceholderText(item, toErrorLabel(t('editFailed', { defaultValue: 'Edit failed.' })))
      }
    } finally {
      imagePollInFlightRef.current.delete(pollKey)
    }
  }, [insertEditedImageFromPlaceholder, t, toErrorLabel, updatePlaceholderText])

  const pollImageEditJobWithoutPlaceholder = useCallback(async (
    jobId: string,
    sceneId: string,
  ) => {
    const pollKey = `${sceneId}:${jobId}:recover`
    if (imagePollInFlightRef.current.has(pollKey) || imagePollInFlightRef.current.has(`${sceneId}:${jobId}`)) return
    imagePollInFlightRef.current.add(pollKey)
    const maxAttempts = 60
    const delayMs = 2000
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const res = await request.get(`/api/v1/excalidraw/image-edit-jobs/${jobId}/`)
          const status = String(res.data?.status || '').toUpperCase()
          if (status === 'FAILED') return
          if (status === 'SUCCEEDED') {
            if (sceneIdRef.current !== sceneId) return
            const results = Array.isArray(res.data?.results)
              ? res.data.results
              : (res.data?.result ? [res.data.result] : [])
            if (!results.length) return
            const ordered = [...results].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
            const creator = createPinnedImageRef.current
            if (!creator) return
            for (let index = 0; index < ordered.length; index += 1) {
              const result = ordered[index]
              await creator(
                sceneId,
                { tool: 'imagetool', result },
                null,
                {
                  aiEditSourceId: 'recover',
                  aiEditJobId: jobId,
                  aiEditOrder: index,
                  aiEditAssetId: result?.asset_id,
                },
              )
            }
            queueUrgentSave()
            return
          }
        } catch (error) {
          console.error('Poll image edit recover failed', error)
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    } finally {
      imagePollInFlightRef.current.delete(pollKey)
    }
  }, [queueUrgentSave])

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
    decrementVideoPending,
    findExistingVideoElement,
    findOrphanVideoPlaceholder,
    findVideoPlaceholderByJobId,
    removeElementsById,
    t,
    toVideoFailureLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
    updateVideoEditStatus,
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

      let orphanPlaceholder = findOrphanVideoPlaceholder(sceneId, 10000)
      let orphanUsed = false

      for (const job of jobs) {
        const jobId = job?.id ? String(job.id) : ''
        const status = String(job?.status || '').toUpperCase()
        if (!jobId || !status) continue
        let placeholder = findVideoPlaceholderByJobId(sceneId, jobId)
        if (!placeholder && orphanPlaceholder && !orphanUsed) {
          placeholder = orphanPlaceholder
          orphanUsed = true
          updatePlaceholderMeta(placeholder, { aiChatType: 'note-video-placeholder', aiVideoJobId: jobId })
        }
        if (status === 'QUEUED' || status === 'RUNNING') {
          if (placeholder) {
            void pollVideoJob(jobId, sceneId, placeholder)
          }
          continue
        }
        if (status === 'FAILED') {
          if (placeholder) {
            updatePlaceholderText(
              placeholder,
              toVideoFailureLabel(job?.error || t('editVideoRequestFailed', { defaultValue: '视频生成失败' })),
            )
          }
          continue
        }
        if (status !== 'SUCCEEDED') continue
        if (!placeholder) continue
        const url = job?.result_url || ''
        if (!url || typeof url !== 'string') continue
        if (existingJobIds.has(jobId) || existingUrls.has(url)) {
          if (placeholder) {
            removeElementsById([placeholder.rectId, placeholder.textId])
          }
          continue
        }
        await creator(sceneId, url, job?.thumbnail_url || null, placeholder, jobId)
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
    cleanupLegacyVideoPlaceholders,
    findOrphanVideoPlaceholder,
    findVideoPlaceholderByJobId,
    getSceneElementsSafe,
    pollVideoJob,
    removeElementsById,
    toVideoFailureLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
    t,
  ])

  const recoverImageEditJobsForScene = useCallback(async (sceneId: string, attempt: number = 0) => {
    if (!sceneId) return
    if (recoveredImageEditScenesRef.current[sceneId]) return
    const api = canvexApiRef.current
    if (!api?.getSceneElements) return
    recoveredImageEditScenesRef.current[sceneId] = true
    try {
      const res = await request.get(`/api/v1/excalidraw/scenes/${sceneId}/image-edit-jobs/`, {
        params: { limit: 20 },
      })
      const jobs: ImageEditJobListItem[] = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.results)
          ? res.data.results
          : []

      const elements = api.getSceneElements() || []
      const existingOrdersByJobId = new Map<string, Set<number>>()
      for (const element of elements) {
        if (!element || element.isDeleted || element.type !== 'image') continue
        const data = element.customData || {}
        if (!data.aiEditJobId) continue
        const jobId = String(data.aiEditJobId)
        const order = Number(data.aiEditOrder)
        if (!existingOrdersByJobId.has(jobId)) {
          existingOrdersByJobId.set(jobId, new Set())
        }
        if (Number.isFinite(order)) {
          existingOrdersByJobId.get(jobId)!.add(order)
        }
      }

      const orphanPlaceholders = findOrphanImageEditPlaceholders(sceneId)
      let orphanIndex = 0

      for (const job of jobs) {
        const jobId = job?.id ? String(job.id) : ''
        const status = job?.status
        if (!jobId || !status) continue
        if (imagePollInFlightRef.current.has(`${sceneId}:${jobId}`)) continue
        let placeholders = findImageEditPlaceholdersByJobId(sceneId, jobId)
        if (!placeholders.length && orphanPlaceholders.length) {
          const needed = Math.max(1, Number(job?.num_images) || 1)
          if (orphanPlaceholders.length - orphanIndex >= needed) {
            placeholders = orphanPlaceholders.slice(orphanIndex, orphanIndex + needed)
            orphanIndex += needed
            placeholders.forEach((placeholder, index) => {
              updatePlaceholderMeta(placeholder, { aiEditJobId: jobId, aiEditOrder: index })
            })
          }
        }

        if (status === 'QUEUED' || status === 'RUNNING') {
          if (placeholders.length) {
            void pollImageEditJobForPlaceholders(jobId, sceneId, placeholders)
          }
          continue
        }

        if (status === 'FAILED') {
          const error = job?.error || 'Edit failed.'
          if (placeholders.length) {
            for (const placeholder of placeholders) {
              updatePlaceholderText(placeholder, toErrorLabel(error))
            }
          }
          continue
        }

        if (status !== 'SUCCEEDED') continue
        if (!placeholders.length) continue

        const detail = await request.get(`/api/v1/excalidraw/image-edit-jobs/${jobId}/`)
        const results = Array.isArray(detail.data?.results)
          ? detail.data.results
          : (detail.data?.result ? [detail.data.result] : [])
        if (!results.length) {
          for (const placeholder of placeholders) {
            updatePlaceholderText(placeholder, toErrorLabel(t('editFailed', { defaultValue: 'Edit failed.' })))
          }
          continue
        }
        const orderedResults = [...results].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        const existingOrders = existingOrdersByJobId.get(jobId) || new Set<number>()
        for (let index = 0; index < orderedResults.length; index += 1) {
          const result = orderedResults[index]
          const order = Number(result.order)
          const placeholder = placeholders[index] || null
          if (Number.isFinite(order) && existingOrders.has(order)) {
            if (placeholder) {
              removeElementsById([placeholder.rectId, placeholder.textId])
            }
            continue
          }
          if (placeholder) {
            await insertEditedImageFromPlaceholder(placeholder, result)
          }
        }
      }
    } catch (error) {
      recoveredImageEditScenesRef.current[sceneId] = false
      if (attempt < 2) {
        window.setTimeout(() => {
          if (sceneIdRef.current === sceneId) {
            recoverImageEditJobsForScene(sceneId, attempt + 1)
          }
        }, 2000)
      }
      console.error('Recover image edit jobs failed', error)
    }
  }, [
    findImageEditPlaceholdersByJobId,
    findOrphanImageEditPlaceholders,
    insertEditedImageFromPlaceholder,
    pollImageEditJobForPlaceholders,
    pollImageEditJobWithoutPlaceholder,
    removeElementsById,
    t,
    toErrorLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  useEffect(() => {
    recoveredVideoScenesRef.current = {}
    recoveredImageEditScenesRef.current = {}
  }, [activeSceneId])

  useEffect(() => {
    if (!activeSceneId || loading || loadError || !canvexReady) return
    let cancelled = false
    const intervalMsEnv = Number(import.meta.env.VITE_SCENE_SYNC_INTERVAL_MS ?? 5000)
    const intervalMs = Number.isFinite(intervalMsEnv) && intervalMsEnv > 0 ? Math.floor(intervalMsEnv) : 5000

    const syncSceneBacklog = () => {
      if (cancelled) return
      void loadChatForScene(activeSceneId)
      recoveredVideoScenesRef.current[activeSceneId] = false
      recoveredImageEditScenesRef.current[activeSceneId] = false
      void recoverVideoJobsForScene(activeSceneId)
      void recoverImageEditJobsForScene(activeSceneId)
    }

    syncSceneBacklog()
    const timer = window.setInterval(syncSceneBacklog, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeSceneId, canvexReady, loadChatForScene, loadError, loading, recoverImageEditJobsForScene, recoverVideoJobsForScene])

  const handleImageEdit = useCallback(async (opts?: { cutout?: boolean }) => {
    if (!selectedEditKey || !selectedEditIds.length) return
    if (imageEditPendingIds.includes(selectedEditKey)) return
    const prompt = imageEditPrompt.trim()
    const isCutout = Boolean(opts?.cutout)
    const sceneId = sceneIdRef.current
    if (!sceneId) {
      setImageEditError(t('editNoScene', { defaultValue: 'Save the scene first.' }))
      return
    }
    const api = canvexApiRef.current
    if (!api?.getSceneElements || !api?.getAppState || !api?.getFiles) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    const selectedElements = getSelectedElementsByIds(selectedEditIds)
    if (!selectedElements.length) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    const selectionText = selectedElements
      .filter((item: any) => item?.type === 'text' && typeof item?.text === 'string')
      .map((item: any) => String(item.text || '').trim())
      .filter(Boolean)
      .join('\n')
    const exportElements = selectedElements.filter((item: any) => item && !isVideoElement(item))
    if (!exportElements.length) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    let promptToUse = ''
    if (!isCutout) {
      if (selectionText && prompt) {
        promptToUse = `${prompt}\n${selectionText}`
      } else if (selectionText) {
        promptToUse = selectionText
      } else if (prompt) {
        promptToUse = prompt
      } else {
        promptToUse = t('editDefaultPrompt', { defaultValue: 'Refine the image while preserving content and layout.' })
      }
    }
    const bounds = getSelectionBounds(exportElements)
    if (!bounds) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }

    setImageEditPendingIds(prev => (prev.includes(selectedEditKey) ? prev : [...prev, selectedEditKey]))
    setImageEditError(null)
    const placeholders = createEditImagePlaceholders(
      sceneId,
      bounds,
      t('editGenerating', { defaultValue: '生成中…' }),
      imageEditCount || 1,
    )
    try {
      const appState = api.getAppState()
      const blob = await exportToBlob({
        elements: exportElements,
        appState: {
          exportBackground: false,
          viewBackgroundColor: appState.viewBackgroundColor,
        },
        files: api.getFiles(),
        mimeType: MIME_TYPES.png,
        exportPadding: 0,
      })
      const form = new FormData()
      form.append('image', blob, 'image.png')
      if (isCutout) {
        form.append('cutout', '1')
      } else {
        form.append('prompt', promptToUse)
      }
      const sizeInput = imageEditSize.trim()
      if (sizeInput) {
        const size = resolveImageEditSize(sizeInput)
        if (size) {
          form.append('size', size)
        }
      }
      form.append('n', String(imageEditCount || 1))
      const res = await request.post(`/api/v1/excalidraw/scenes/${sceneId}/image-edit/`, form)
      const jobId = res.data?.job_id
      if (!jobId) {
        throw new Error('job id missing')
      }
      if (placeholders && placeholders.length) {
        for (const item of placeholders) {
          updatePlaceholderMeta(item, { aiEditJobId: String(jobId) })
        }
      }
      await pollImageEditJob(jobId, sceneId, bounds, selectedEditKey, placeholders)
    } catch (error) {
      console.error('Image edit failed', error)
      if (placeholders && placeholders.length) {
        for (const item of placeholders) {
          updatePlaceholderText(item, toErrorLabel(t('editFailed', { defaultValue: 'Edit failed.' })))
        }
      } else {
        setImageEditError(t('editFailed', { defaultValue: 'Edit failed.' }))
      }
    } finally {
      setImageEditPendingIds(prev => prev.filter((id) => id !== selectedEditKey))
    }
  }, [
    createEditImagePlaceholders,
    getSelectedElementsByIds,
    getSelectionBounds,
    imageEditPendingIds,
    imageEditPrompt,
    imageEditSize,
    imageEditCount,
    pollImageEditJob,
    selectedEditIds,
    selectedEditKey,
    t,
    toErrorLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  const handleVideoGenerate = useCallback(async () => {
    if (!selectedEditKey || !selectedEditIds.length) return
    const selectionKey = selectedEditKey
    const sceneId = sceneIdRef.current
    if (!sceneId) {
      setImageEditError(t('editNoScene', { defaultValue: 'Save the scene first.' }))
      return
    }
    const api = canvexApiRef.current
    if (!api?.getSceneElements) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    const selectedElements = getSelectedElementsByIds(selectedEditIds)
    if (!selectedElements.length) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }

    const textPrompt = selectedElements
      .filter((item: any) => item?.type === 'text' && typeof item?.text === 'string')
      .map((item: any) => String(item.text || '').trim())
      .filter(Boolean)
      .join('\n')
    const prompt = textPrompt || imageEditPrompt.trim()

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
    if (!imageElements.length) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }

    setImageEditError(null)
    setVideoEditErrorByKey(prev => ({ ...prev, [selectionKey]: null }))
    setVideoEditStatusByKey(prev => ({ ...prev, [selectionKey]: t('editVideoQueued', { defaultValue: '排队中…' }) }))
    setVideoEditPendingCountByKey(prev => ({
      ...prev,
      [selectionKey]: Number(prev[selectionKey] || 0) + 1,
    }))
    const placeholder = createImagePlaceholder(
      sceneId,
      t('editVideoPlaceholderQueued', { defaultValue: '视频排队中…' }),
      { kind: 'video' },
    )
    const resolved = await resolveVideoImageUrls(sceneId, imageElements)
    const imageUrls = resolved.urls.filter((url: string) => typeof url === 'string' && url.startsWith('http'))
    if (!resolved.allResolved || !imageUrls.length || imageUrls.length !== imageElements.length) {
      const errorMessage = t('editImageUrlMissing', { defaultValue: 'Selected images must have public URLs.' })
      setImageEditError(errorMessage)
      updateVideoEditStatus(selectionKey, 'FAILED', errorMessage)
      decrementVideoPending(selectionKey)
      if (placeholder) {
        updatePlaceholderText(placeholder, toVideoFailureLabel(errorMessage))
      }
      return
    }
    if (placeholder) {
      updatePlaceholderText(placeholder, t('editVideoPlaceholderWorking', { defaultValue: '视频生成中…' }))
    }
    let submittedJobId = ''
    try {
      const res = await request.post(`/api/v1/excalidraw/scenes/${sceneId}/video/`, {
        prompt,
        image_urls: imageUrls,
      })
      const jobId = res.data?.job_id ? String(res.data.job_id) : ''
      if (!jobId) {
        throw new Error('job id missing')
      }
      submittedJobId = jobId
      if (placeholder) {
        updatePlaceholderMeta(placeholder, { aiChatType: 'note-video-placeholder', aiVideoJobId: jobId })
      }
      videoEditSelectionByJobRef.current[jobId] = selectionKey
      if (res.data?.status) {
        updateVideoEditStatus(selectionKey, res.data.status, null)
      }
      void pollVideoJob(jobId, sceneId, placeholder, selectionKey)
    } catch (error) {
      console.error('Video generation failed', error)
      updateVideoEditStatus(selectionKey, 'FAILED', t('editVideoRequestFailed', { defaultValue: '视频生成失败' }))
      if (submittedJobId && videoEditSelectionByJobRef.current[submittedJobId]) {
        delete videoEditSelectionByJobRef.current[submittedJobId]
      }
      decrementVideoPending(selectionKey)
      if (placeholder) {
        updatePlaceholderText(
          placeholder,
          toVideoFailureLabel(t('editVideoRequestFailed', { defaultValue: '视频生成失败' })),
        )
      }
    }
  }, [
    createImagePlaceholder,
    decrementVideoPending,
    getSelectedElementsByIds,
    imageEditPrompt,
    pollVideoJob,
    resolveVideoImageUrls,
    selectedEditIds,
    selectedEditKey,
    t,
    toVideoFailureLabel,
    updateVideoEditStatus,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  const createPinnedImage = useCallback(async (
    sceneId: string | null,
    tool: ToolResult,
    placeholder?: ImagePlaceholder | null,
    meta?: Record<string, any>,
  ) => {
    if (sceneId !== sceneIdRef.current) return
    const api = canvexApiRef.current
    if (!api?.updateScene || !api?.getSceneElements || !api?.getAppState || !api?.addFiles) return
    const url = tool?.result?.url
    if (!url) return

    const existing = getSceneElementsSafe()
    const metaJobId = meta?.aiEditJobId ? String(meta.aiEditJobId) : ''
    const metaOrder = Number(meta?.aiEditOrder)
    const metaAssetId = meta?.aiEditAssetId || tool?.result?.asset_id || ''
    if (metaJobId) {
      const duplicatedByJob = existing.some((element: any) => {
        if (!element || element.isDeleted || element.type !== 'image') return false
        const data = element.customData || {}
        if (String(data.aiEditJobId || '') !== metaJobId) return false
        if (Number.isFinite(metaOrder)) {
          return Number(data.aiEditOrder) === metaOrder
        }
        return true
      })
      if (duplicatedByJob) return true
    }
    if (metaAssetId) {
      const duplicatedByAsset = existing.some((element: any) => {
        if (!element || element.isDeleted || element.type !== 'image') return false
        const data = element.customData || {}
        return String(data.aiEditAssetId || data.aiChatAssetId || '') === String(metaAssetId)
      })
      if (duplicatedByAsset) return true
    }

    let dataURL = ''
    let decodedWidth: number | null = null
    let decodedHeight: number | null = null
    try {
      const loaded = await loadImageDataUrl(url)
      dataURL = loaded.dataUrl
      decodedWidth = loaded.width
      decodedHeight = loaded.height
    } catch {
      return false
    }

    const fileId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    api.addFiles([{
      id: fileId,
      dataURL,
      mimeType: tool?.result?.mime_type || 'image/png',
      created: Date.now(),
      lastRetrieved: Date.now(),
    }])

    const appState = api.getAppState()
    const naturalWidth = Number(tool?.result?.width) || decodedWidth || 512
    const naturalHeight = Number(tool?.result?.height) || decodedHeight || 512

    let x = 0
    let y = 0
    let width = Math.max(120, Math.round(naturalWidth))
    let height = Math.max(120, Math.round(naturalHeight))

    const placeholderRect = placeholder
      ? existing.find((item: any) => item?.id === placeholder.rectId && !item?.isDeleted)
      : null
    if (placeholderRect) {
      const targetWidth = Math.max(120, Math.round(placeholderRect.width || 400))
      const targetHeight = Math.max(120, Math.round(placeholderRect.height || 400))
      const scale = naturalWidth > 0 && naturalHeight > 0
        ? Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
        : 1
      width = Math.max(120, Math.round(naturalWidth * scale))
      height = Math.max(120, Math.round(naturalHeight * scale))
      x = (placeholderRect.x || 0) + (targetWidth - width) / 2
      y = (placeholderRect.y || 0) + (targetHeight - height) / 2
    } else {
      const pinnedItems = (existing || []).filter((item: any) => String(item?.customData?.aiChatType || '').startsWith('note-') && !item?.isDeleted)
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
      const stackedHeight = pinnedItems.reduce((total, item: any) => total + (item.height || 0) + gap, 0)

      const maxWidth = 400
      const scale = naturalWidth > 0 ? Math.min(1, maxWidth / naturalWidth) : 1
      width = Math.max(120, Math.round(naturalWidth * scale))
      height = Math.max(120, Math.round(naturalHeight * scale))
      x = baseX
      y = baseY + stackedHeight
    }

    const imageElement = createImageElement({
      x,
      y,
      width,
      height,
      fileId,
      status: 'saved',
      scale: [1, 1],
      customData: {
        aiChatType: 'note-image',
        aiChatCreatedAt: new Date().toISOString(),
        aiChatImageUrl: url,
        aiChatAssetId: tool?.result?.asset_id,
        ...(meta || {}),
      },
    })

    api.updateScene({
      elements: [...(existing || []), imageElement],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    captureSceneSnapshot()
    queueUrgentSave()
    if (typeof api.scrollToContent === 'function') {
      try {
        api.scrollToContent([imageElement], { fitToViewport: false })
      } catch {}
    }
    lastPinnedIdRef.current = imageElement.id
    setLastPinnedId(imageElement.id)
    persistLastPinnedForScene(sceneId, imageElement.id)
    window.setTimeout(() => {
      flashPinnedElement(imageElement)
    }, 120)
    return true
  }, [captureSceneSnapshot, createImageElement, flashPinnedElement, getSceneElementsSafe, loadImageDataUrl, persistLastPinnedForScene, persistPinOriginForScene, queueUrgentSave])

  useEffect(() => {
    createPinnedImageRef.current = createPinnedImage
  }, [createPinnedImage])

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
      const loaded = await loadImageDataUrl(resolvedPosterUrl)
      dataURL = loaded.dataUrl
      decodedWidth = loaded.width
      decodedHeight = loaded.height
    } catch {
      if (thumbnailUrl) {
        try {
          resolvedPosterUrl = buildVideoPosterDataUrl()
          const fallback = await loadImageDataUrl(resolvedPosterUrl)
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
      const pinnedItems = (existing || []).filter((item: any) => String(item?.customData?.aiChatType || '').startsWith('note-') && !item?.isDeleted)
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
      const stackedHeight = pinnedItems.reduce((total, item: any) => total + (item.height || 0) + gap, 0)
      const maxWidth = 400
      const scale = naturalWidth > 0 ? Math.min(1, maxWidth / naturalWidth) : 1
      width = Math.max(160, Math.round(naturalWidth * scale))
      height = Math.max(90, Math.round(naturalHeight * scale))
      x = baseX
      y = baseY + stackedHeight
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
    setLastPinnedId(imageElement.id)
    persistLastPinnedForScene(sceneId, imageElement.id)
    window.setTimeout(() => {
      flashPinnedElement(imageElement)
    }, 120)
    return true
  }, [
    buildVideoPosterDataUrl,
    captureSceneSnapshot,
    createImageElement,
    flashPinnedElement,
    getSceneElementsSafe,
    loadImageDataUrl,
    persistLastPinnedForScene,
    persistPinOriginForScene,
    queueUrgentSave,
    removeElementsById,
  ])

  useEffect(() => {
    createPinnedVideoRef.current = createPinnedVideo
  }, [createPinnedVideo])

  const isImageSpecPayload = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) return false
    const hasPrompt = trimmed.includes('"prompt"')
    const hasSize = trimmed.includes('"size"')
    if (!trimmed.endsWith('}')) {
      return hasPrompt && hasSize
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      const keys = Object.keys(parsed)
      if (!keys.length) return false
      if (keys.some((key) => !['prompt', 'size'].includes(key))) return false
      return 'prompt' in parsed || 'size' in parsed
    } catch {
      return hasPrompt && hasSize
    }
  }, [])

  const buildChatContentWithSelection = useCallback(async (sceneId: string, content: string) => {
    const api = canvexApiRef.current
    if (!api?.getAppState) return content

    const appState = api.getAppState()
    const selectedIdsMap = appState?.selectedElementIds || {}
    const selectedIds = Object.keys(selectedIdsMap).filter((id) => selectedIdsMap[id])
    if (!selectedIds.length) return content

    const selectedElements = getSelectedElementsByIds(selectedIds)
    if (!selectedElements.length) return content

    const textLines = selectedElements
      .filter((item: any) => item?.type === 'text' && typeof item?.text === 'string')
      .map((item: any) => String(item.text || '').trim())
      .filter(Boolean)

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

    let imageUrls: string[] = []
    if (imageElements.length) {
      try {
        const resolved = await resolveVideoImageUrls(sceneId, imageElements)
        imageUrls = (resolved.urls || []).filter((url: string) => typeof url === 'string' && url.startsWith('http'))
      } catch (error) {
        console.warn('Resolve selected image urls for chat failed', error)
      }
    }

    const otherTypes = Array.from(new Set(
      selectedElements
        .map((item: any) => String(item?.type || '').trim())
        .filter((type: string) => Boolean(type) && type !== 'text' && type !== 'image'),
    ))

    const blocks: string[] = []
    if (textLines.length) {
      blocks.push(`selected_text:\n${textLines.join('\n')}`)
    }
    if (imageUrls.length) {
      blocks.push(`selected_image_urls:\n${imageUrls.join('\n')}`)
    }
    if (otherTypes.length) {
      blocks.push(`selected_element_types:\n${otherTypes.join(', ')}`)
    }
    if (!blocks.length) return content
    return `${content}\n\n[canvas_selection]\n${blocks.join('\n\n')}\n[/canvas_selection]`
  }, [getSelectedElementsByIds, resolveVideoImageUrls])

  const jumpToLatestPinned = useCallback(() => {
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
  }, [activeSceneId, flashPinnedElement, persistLastPinnedForScene])

  const sendMessage = useCallback(async () => {
    if (chatLoading) return
    const trimmed = chatInput.trim()
    if (!trimmed) return
    let sceneId = activeSceneId
    if (!sceneId) {
      if (!pendingRef.current) {
        pendingRef.current = currentSceneRef.current || {}
      }
      try {
        await flushSave()
      } catch {}
      sceneId = sceneIdRef.current
    }
    if (!sceneId) return
    const now = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: trimmed,
      created_at: now,
    }
    appendChatMessageForScene(sceneId, userMessage)
    createPinnedNote(sceneId, userMessage)
    // placeholder is created when the backend emits intent
    setChatInput('')
    setSceneChatLoading(sceneId, true)
    chatSuccessRef.current = false
    chatStartTimeRef.current = Date.now()
    let backendContent = trimmed
    try {
      backendContent = await buildChatContentWithSelection(sceneId, trimmed)
    } catch (error) {
      console.warn('Build chat selection context failed', error)
      backendContent = trimmed
    }
    try {
      const streamUrl = `${API_BASE}/api/v1/excalidraw/scenes/${sceneId}/chat/?stream=1`
      const makeStreamRequest = async () => {
        return fetch(streamUrl, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
            'ngrok-skip-browser-warning': 'true',
          },
          body: JSON.stringify({ content: backendContent }),
        })
      }
      const response = await makeStreamRequest()
      if (!response.ok || !response.body) {
        throw new Error(`Chat stream failed (${response.status})`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let assistantContent = ''
      let assistantNoteId: string | null = null
      let suppressAssistantPin = false
      let intentReceived = false
      let pendingVideoPlaceholder: ImagePlaceholder | null = null
      let appendedFinal = false
      let streamError: string | null = null
    const handleToolResult = async (payload: ToolResult) => {
      if (!payload?.result) return
      const toolName = payload.tool
      if (toolName === 'imagetool') {
        if (payload.result.url) {
          let placeholder = takeNextImagePlaceholder(sceneId)
          if (!placeholder) {
            placeholder = createImagePlaceholder(sceneId, '生成中…')
          }
          const created = await createPinnedImage(sceneId, payload, placeholder)
          if (created) {
            if (placeholder) {
              removeElementsById([placeholder.rectId, placeholder.textId])
            }
          } else if (placeholder) {
            updatePlaceholderText(placeholder, '图片加载失败')
          }
        } else if (payload.result.error) {
          const placeholder = takeNextImagePlaceholder(sceneId)
          if (placeholder) {
            updatePlaceholderText(placeholder, toErrorLabel(payload.result.error))
          }
        }
        return
      }

      if (toolName === 'videotool') {
        if (payload.result.url) {
          const videoUrl = payload.result.url
          const videoMessage: ChatMessage = {
            id: `video-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'assistant',
            content: '视频已生成。',
            created_at: new Date().toISOString(),
          }
          appendChatMessageForScene(sceneId, videoMessage)
          const created = await createPinnedVideo(sceneId, videoUrl, payload.result.thumbnail_url, pendingVideoPlaceholder)
          if (!created) {
            if (pendingVideoPlaceholder) {
              removeElementsById([pendingVideoPlaceholder.rectId, pendingVideoPlaceholder.textId])
              pendingVideoPlaceholder = null
            }
            createPinnedNote(sceneId, {
              ...videoMessage,
              content: `视频已生成：${videoUrl}`,
            })
          } else {
            pendingVideoPlaceholder = null
          }
        } else if (payload.result.task_id) {
          const pendingMessage: ChatMessage = {
            id: `video-task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'assistant',
            content: `视频生成中，任务ID：${payload.result.task_id}`,
            created_at: new Date().toISOString(),
          }
          appendChatMessageForScene(sceneId, pendingMessage)
          if (!pendingVideoPlaceholder) {
            pendingVideoPlaceholder = createImagePlaceholder(sceneId, '视频生成中…', { kind: 'video' })
          }
        } else if (payload.result.error) {
          const videoErrorLabel = toVideoFailureLabel(payload.result.error)
          const errorMessage: ChatMessage = {
            id: `video-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'assistant',
            content: videoErrorLabel,
            created_at: new Date().toISOString(),
          }
          appendChatMessageForScene(sceneId, errorMessage)
          if (pendingVideoPlaceholder) {
            updatePlaceholderText(pendingVideoPlaceholder, errorMessage.content)
            pendingVideoPlaceholder = null
          } else {
            createPinnedNote(sceneId, errorMessage)
          }
        }
        return
      }

      if (payload.result.url) {
        const fallbackMessage: ChatMessage = {
          id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: payload.result.url,
          created_at: new Date().toISOString(),
        }
        appendChatMessageForScene(sceneId, fallbackMessage)
        createPinnedNote(sceneId, fallbackMessage)
      } else if (payload.result.error) {
        const fallbackMessage: ChatMessage = {
          id: `tool-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: payload.result.error,
          created_at: new Date().toISOString(),
        }
        appendChatMessageForScene(sceneId, fallbackMessage)
        createPinnedNote(sceneId, fallbackMessage)
      }
    }
    const appendAssistantMessage = (payload?: any) => {
      const assistantMessage: ChatMessage = {
        id: payload?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
          content: payload?.content || assistantContent,
          created_at: payload?.created_at || new Date().toISOString(),
        }
        appendChatMessageForScene(sceneId, assistantMessage)
        const shouldSuppress = suppressAssistantPin || isImageSpecPayload(assistantMessage.content)
        if (!shouldSuppress) {
          if (assistantNoteId) {
            updatePinnedNoteText(assistantNoteId, assistantMessage.content)
          } else {
            assistantNoteId = createPinnedNote(sceneId, assistantMessage) || null
          }
        }
        appendedFinal = true
      }

      const processBuffer = () => {
        let idx = buffer.indexOf('\n\n')
        while (idx !== -1) {
          const raw = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 2)
          if (raw.startsWith('data:')) {
            const payloadText = raw.replace(/^data:\s*/, '')
            try {
              const payload = JSON.parse(payloadText)
              const toolPayload = payload?.['tool-result'] || payload
              if (toolPayload?.tool && toolPayload?.result) {
                void handleToolResult(toolPayload)
              }
              if (payload?.intent === 'image') {
                if (!intentReceived) {
                  enqueueImagePlaceholder(createImagePlaceholder(sceneId, '生成中…'))
                  intentReceived = true
                }
              }
              if (payload?.intent === 'video') {
                if (!intentReceived) {
                  const pendingMessage: ChatMessage = {
                    id: `video-intent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    role: 'assistant',
                    content: '视频生成中…',
                    created_at: new Date().toISOString(),
                  }
                  appendChatMessageForScene(sceneId, pendingMessage)
                  if (!pendingVideoPlaceholder) {
                    pendingVideoPlaceholder = createImagePlaceholder(sceneId, '视频生成中…', { kind: 'video' })
                  }
                  intentReceived = true
                }
              }
              if (payload?.delta) {
                assistantContent += payload.delta
                if (assistantContent.trim().startsWith('{')) {
                  suppressAssistantPin = true
                }
                suppressAssistantPin = suppressAssistantPin || isImageSpecPayload(assistantContent)
                if (!suppressAssistantPin) {
                  if (!assistantNoteId) {
                    assistantNoteId = createPinnedNote(sceneId, {
                      id: `assistant-${Date.now()}`,
                      role: 'assistant',
                      content: assistantContent,
                      created_at: new Date().toISOString(),
                    }) || null
                  } else {
                    updatePinnedNoteText(assistantNoteId, assistantContent)
                  }
                }
              }
              if (payload?.message) {
                appendAssistantMessage(payload.message)
              }
              if (payload?.error) {
                streamError = payload.error
                return
              }
            } catch (error) {
              console.error('Failed to parse stream chunk', error)
            }
          }
          idx = buffer.indexOf('\n\n')
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        processBuffer()
      }
      buffer += decoder.decode()
      processBuffer()

      if (streamError) {
        throw new Error(streamError)
      }

      if (!appendedFinal && !assistantContent.trim()) {
        throw new Error('Empty assistant response')
      }

      if (!appendedFinal && assistantContent.trim()) {
        appendAssistantMessage()
      }
      chatSuccessRef.current = true
      markPendingPlaceholdersFailed(sceneId, '生成失败')
    } catch (error) {
      console.error('Chat request failed', error)
      try {
        const res = await request.post(`/api/v1/excalidraw/scenes/${sceneId}/chat/`, { content: backendContent })
        const assistantMessage: ChatMessage = {
          id: res.data?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: res.data?.content || '',
          created_at: res.data?.created_at || new Date().toISOString(),
        }
        appendChatMessageForScene(sceneId, assistantMessage)
        if (!isImageSpecPayload(assistantMessage.content)) {
          createPinnedNote(sceneId, assistantMessage)
        }
        chatSuccessRef.current = true
        const toolResults = Array.isArray(res.data?.tool_results) ? res.data.tool_results : []
        for (const item of toolResults) {
          if (item?.result) {
            await handleToolResult(item)
          }
        }
      } catch (fallbackError) {
        console.error('Chat fallback failed', fallbackError)
      }
    } finally {
      queueUrgentSave()
      setSceneChatLoading(sceneId, false)
      if (chatSuccessRef.current) {
        const elapsed = ((Date.now() - chatStartTimeRef.current) / 1000).toFixed(1)
        setChatElapsedTime(parseFloat(elapsed))
      }
      setSceneChatStatus(sceneId, chatSuccessRef.current ? 'success' : 'error')
      markPendingPlaceholdersFailed(sceneId, '生成失败')
    }
  }, [activeSceneId, appendChatMessageForScene, buildChatContentWithSelection, chatInput, chatLoading, createImagePlaceholder, createPinnedImage, createPinnedNote, createPinnedVideo, enqueueImagePlaceholder, flushSave, isImageSpecPayload, markPendingPlaceholdersFailed, queueUrgentSave, removeElementsById, setSceneChatLoading, setSceneChatStatus, takeNextImagePlaceholder, toErrorLabel, toVideoFailureLabel, updatePlaceholderText, updatePinnedNoteText])

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <style>{`
        .canvex-host {
          overflow: visible !important;
        }
        .canvex-host .FixedSideContainer_side_top {
          top: 5px !important;
        }
        .canvex-host .help-icon,
        .canvex-host .help-icon-container,
        .canvex-host .HelpDialog__Icon,
        .canvex-host .HelpDialog__icon {
          display: none !important;
        }
        .Dialog__content .HelpDialog__header {
          display: none !important;
        }
        [data-testid="command-palette-button"] {
          display: none !important;
        }
        .canvex-host .layer-ui__wrapper__footer-left section {
          flex-direction: column;
          align-items: flex-start;
          gap: 0.5rem;
        }
        .canvex-host .layer-ui__wrapper__footer-left .undo-redo-buttons {
          order: -1;
        }
        .canvex-host .layer-ui__wrapper__footer-left .zoom-actions {
          order: 1;
        }
        .canvex-host .layer-ui__wrapper__footer-left .finalize-button {
          order: 2;
        }
      `}</style>
      {/* <div className="px-4 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <IconPencil className="size-5 text-primary" />
            <h1 className="text-xl font-semibold sm:text-2xl">
              {t('title', { defaultValue: 'Canvex' })}
            </h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {t('subtitle', { defaultValue: 'Sketch ideas and export diagrams for your listings.' })}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {saveStatusLabel && (
              <span className="text-xs text-muted-foreground">{saveStatusLabel}</span>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground sm:hidden">
          {t('subtitle', { defaultValue: 'Sketch ideas and export diagrams for your listings.' })}
        </p>
      </div> */}

      {canShowAiEditBar && selectedEditPreview && previewAnchor && previewFloatingStyle && (
        <div
          className="pointer-events-none fixed z-[60]"
          style={{
            left: previewFloatingStyle.left,
            top: previewFloatingStyle.top,
          }}
        >
          <div className="rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur">
            <img
              src={selectedEditPreview}
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
                  syncCanvexTheme(state?.theme)
                  if (scrollUnsubRef.current) {
                    scrollUnsubRef.current()
                    scrollUnsubRef.current = null
                  }
                  if (api?.onScrollChange) {
                    scrollUnsubRef.current = api.onScrollChange(() => {
                      updateSelectedEditSelection()
                    })
                  }
                  updateSelectedEditSelection()
                }}
              >
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
            {!loading && !loadError && videoOverlayItems.length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-30">
                {videoOverlayItems.map((item) => {
                  const api = canvexApiRef.current
                  const element = api?.getSceneElements?.().find((el: any) => el?.id === item.id && !el?.isDeleted)
                  if (!element) return null
                  const rect = getElementViewportRect(element)
                  if (!rect) return null
                  return (
                    <div
                      key={item.id}
                      className="canvex-video-overlay-item absolute"
                      style={{
                        pointerEvents: 'none',
                        left: rect.x,
                        top: rect.y,
                        width: rect.width,
                        height: rect.height,
                      }}
                    >
                      {activeVideoId === item.id ? (
                        <div
                          className="pointer-events-auto absolute inset-0"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <video
                            className="h-full w-full rounded-md border border-border/60 bg-black object-cover shadow-sm"
                            src={item.url}
                            poster={item.thumbnailUrl || buildVideoPosterDataUrl()}
                            controls
                            autoPlay
                            preload="metadata"
                            playsInline
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white shadow-sm"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              setActiveVideoId(null)
                            }}
                          >
                            {t('common:close', { defaultValue: 'Close' })}
                          </button>
                        </div>
                      ) : (
                        <>
                          <video
                            className="canvex-video-overlay-media h-full w-full rounded-md border border-border/60 bg-black object-cover shadow-sm"
                            src={item.url}
                            poster={item.thumbnailUrl || buildVideoPosterDataUrl()}
                            style={{ pointerEvents: 'none' }}
                            preload="metadata"
                            playsInline
                            muted
                          />
                          <button
                            type="button"
                            aria-label={t('playVideo', { defaultValue: 'Play video' })}
                            className="pointer-events-auto absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition hover:bg-black/70"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              setActiveVideoId(item.id)
                            }}
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
            {canShowAiEditBar && selectedEditKey && selectedEditRect && imageEditStyle && (
              <div
                className="absolute z-50 flex flex-col gap-1"
                style={imageEditStyle}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="flex items-center gap-2 rounded-lg border bg-background/95 px-2 py-2 shadow-md backdrop-blur">
                  <div
                    className="relative"
                    onMouseEnter={(event) => {
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                      setPreviewAnchor({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
                    }}
                    onMouseMove={(event) => {
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                      setPreviewAnchor({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
                    }}
                    onMouseLeave={() => setPreviewAnchor(null)}
                  >
                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border bg-muted">
                      {selectedEditPreview ? (
                        <img
                          src={selectedEditPreview}
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
                    value={imageEditPrompt}
                    onChange={(event) => {
                      setImageEditPrompt(event.target.value)
                      if (imageEditError) setImageEditError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void handleImageEdit()
                      }
                    }}
                    placeholder={t('editPromptPlaceholder', { defaultValue: 'Describe edits…' })}
                    className="h-8 w-56 rounded-md border px-2 text-xs outline-none"
                    disabled={isEditingSelected}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleImageEdit({ cutout: true })}
                    disabled={isEditingSelected}
                  >
                    {t('editCutout', { defaultValue: 'Cutout' })}
                  </Button>
                  <div className="flex items-center">
                    <select
                      value={imageEditSize}
                      onChange={(event) => {
                        setImageEditSize(event.target.value)
                        if (imageEditError) setImageEditError(null)
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
                      value={String(imageEditCount)}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10)
                        setImageEditCount(Number.isNaN(value) ? 1 : value)
                        if (imageEditError) setImageEditError(null)
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
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleVideoGenerate()}
                      disabled={isEditingSelected}
                    >
                      {isVideoGeneratingSelected
                        ? t('editVideoContinue', { defaultValue: 'Generate Another' })
                        : t('editVideo', { defaultValue: 'Generate Video' })}
                    </Button>
                    {videoEditStatus && (
                      <span className={`text-[11px] ${videoEditStatusTone}`}>
                        {videoEditStatus}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void handleImageEdit()}
                    disabled={isEditingSelected}
                  >
                    {isEditingSelected
                      ? t('editWorking', { defaultValue: 'Editing…' })
                      : t('editApply', { defaultValue: 'Apply' })}
                  </Button>
                </div>
                {imageEditError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive shadow-sm">
                    {imageEditError}
                  </div>
                )}
                {videoEditError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive shadow-sm">
                    {toVideoFailureLabel(videoEditError)}
                  </div>
                )}
              </div>
            )}
            {pinFlashRect && (
              <div
                className="pointer-events-none absolute z-40 rounded-md ring-2 ring-primary/50 animate-pulse"
                style={{
                  left: pinFlashRect.x,
                  top: pinFlashRect.y,
                  width: pinFlashRect.width,
                  height: pinFlashRect.height,
                }}
              />
            )}
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
            {lastPinnedId && (
              <div className="pointer-events-none absolute left-28 bottom-[63px] z-40">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="canvex-back-to-latest pointer-events-auto size-8 rounded-full shadow-none"
                  onClick={jumpToLatestPinned}
                  title={t('backToLatest', { defaultValue: 'Back to latest element' })}
                >
                  <IconHistory className="size-5" />
                </Button>
              </div>
            )}
            {!loading && !loadError && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
                <form
                  className="pointer-events-auto w-full max-w-xl"
                  onSubmit={(event) => {
                    event.preventDefault()
                    sendMessage()
                  }}
                >
                  {(chatLoading || chatStatus !== 'idle') && (
                    <div
                      className={`mb-2 flex items-center gap-1.5 text-xs transition-all duration-300 ${
                        chatStatus === 'exiting'
                          ? 'translate-y-2 opacity-0'
                          : 'translate-y-0 opacity-100'
                      } ${
                        chatLoading
                          ? 'text-muted-foreground'
                          : (chatStatus === 'success' || exitingStatus === 'success')
                            ? 'text-green-600 dark:text-green-400'
                            : (chatStatus === 'error' || exitingStatus === 'error')
                              ? 'text-red-500 dark:text-red-400'
                              : 'text-muted-foreground'
                      }`}
                    >
                      {chatLoading ? (
                        <>
                          <IconLoader className="size-3 animate-spin" />
                          <span>{t('aiThinking', { defaultValue: '思考中...' })}</span>
                        </>
                      ) : (chatStatus === 'success' || (chatStatus === 'exiting' && exitingStatus === 'success')) ? (
                        <>
                          <IconCheck className="size-3" />
                          <span>{t('aiCompleted', { defaultValue: '已回复', time: chatElapsedTime })}</span>
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
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          sendMessage()
                        }
                      }}
                      placeholder={t('aiPlaceholder')}
                      className="min-h-[42px] w-full resize-none rounded-xl border bg-background/95 px-4 py-2.5 pr-11 text-sm shadow-lg backdrop-blur outline-none transition-all duration-200 placeholder:text-muted-foreground/50 hover:border-border focus:border-primary/40 focus:shadow-[0_0_0_2px_hsl(var(--primary)/0.08)]"
                      rows={1}
                    />
                    <Button
                      type="submit"
                      size="icon"
                      variant={chatLoading ? 'secondary' : chatInput.trim() ? 'default' : 'ghost'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 size-8 rounded-lg transition-all duration-150"
                      disabled={!chatInput.trim() && !chatLoading}
                    >
                      <span className="relative size-4">
                        {/* Message icon - shown when not loading */}
                        <IconMessage2
                          className={`absolute inset-0 size-4 transition-all duration-300 ${
                            chatLoading ? 'opacity-0 scale-50' : 'opacity-100 scale-100'
                          }`}
                        />
                        {/* Loading icons - stacked with crossfade */}
                        {loadingIcons.map((Icon, index) => (
                          <Icon
                            key={index}
                            className={`absolute inset-0 size-4 transition-all duration-300 ${
                              chatLoading && loadingIconIndex === index
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
