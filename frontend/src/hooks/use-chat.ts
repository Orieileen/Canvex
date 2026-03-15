import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconCat, IconButterfly, IconDog, IconFish, IconPaw } from '@tabler/icons-react'
import { request } from '@/utils/request'
import type { ChatMessage, ChatResultStatus, ChatStatus, ToolResult, ImagePlaceholder } from '@/types/canvex'
import { API_BASE } from '@/constants/canvex'

export function useChat({
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
  getSelectedElementsByIds,
  resolveVideoImageUrls,
  createPinnedNote,
  updatePinnedNoteText,
  createPinnedImage,
  createPinnedVideo,
  createImagePlaceholder,
  enqueueImagePlaceholder,
  takeNextImagePlaceholder,
  markPendingPlaceholdersFailed,
  updatePlaceholderText,
  removeElementsById,
  insertMermaidFlowchartToCanvas,
  toErrorLabel,
  toVideoFailureLabel,
  isImageSpecPayload: isImageSpecPayloadExternal,
}: {
  sceneIdRef: React.MutableRefObject<string | null>
  currentSceneRef: React.MutableRefObject<any>
  pendingRef: React.MutableRefObject<any>
  canvexApiRef: React.MutableRefObject<any>
  chatLoadTokenRef: React.MutableRefObject<number>
  chatAbortControllersRef: React.MutableRefObject<Record<string, AbortController>>
  chatInterruptedScenesRef: React.MutableRefObject<Set<string>>
  activeSceneId: string | null
  getChatKey: (id?: string | null) => string
  flushSave: () => Promise<void>
  queueUrgentSave: () => void
  getSelectedElementsByIds: (ids: string[]) => any[]
  resolveVideoImageUrls: (sceneId: string, elements: any[]) => Promise<{ urls: string[] }>
  createPinnedNote: (sceneId: string | null, message: ChatMessage) => string | undefined
  updatePinnedNoteText: (noteId: string, text: string) => void
  createPinnedImage: (sceneId: string | null, tool: ToolResult, placeholder?: ImagePlaceholder | null, meta?: Record<string, any>) => Promise<boolean | void>
  createPinnedVideo: (sceneId: string | null, videoUrl: string, thumbnailUrl?: string | null, placeholder?: ImagePlaceholder | null, videoJobId?: string | null) => Promise<boolean | void>
  createImagePlaceholder: (sceneId: string | null, label: string, options?: any) => ImagePlaceholder | null
  enqueueImagePlaceholder: (placeholder: ImagePlaceholder) => void
  takeNextImagePlaceholder: (sceneId: string | null) => ImagePlaceholder | null
  markPendingPlaceholdersFailed: (sceneId: string | null, label: string) => void
  updatePlaceholderText: (placeholder: ImagePlaceholder, text: string) => void
  removeElementsById: (ids: string[]) => void
  insertMermaidFlowchartToCanvas: (sceneId: string, mermaid: string) => Promise<{ ok: boolean; error?: string }>
  toErrorLabel: (error: string) => string
  toVideoFailureLabel: (error: string) => string
  isImageSpecPayload?: (text: string) => boolean
}) {
  const { t } = useTranslation('canvex')

  const [, setChatByScene] = useState<Record<string, ChatMessage[]>>({})
  const [chatInput, setChatInput] = useState('')
  const [chatLoadingByScene, setChatLoadingByScene] = useState<Record<string, boolean>>({})
  const [chatStatusByScene, setChatStatusByScene] = useState<Record<string, ChatStatus>>({})
  const [exitingStatusByScene, setExitingStatusByScene] = useState<Record<string, ChatResultStatus | null>>({})
  const [chatElapsedTime, setChatElapsedTime] = useState<number>(0)
  const [loadingIconIndex, setLoadingIconIndex] = useState(0)

  const chatSuccessRef = useRef(false)
  const chatStartTimeRef = useRef<number>(0)

  const chatLoading = activeSceneId ? !!chatLoadingByScene[activeSceneId] : false
  const chatStatus: ChatStatus = activeSceneId ? chatStatusByScene[activeSceneId] ?? 'idle' : 'idle'
  const exitingStatus = activeSceneId ? exitingStatusByScene[activeSceneId] ?? null : null

  const setSceneChatLoading = useCallback((sceneId: string | null, value: boolean) => {
    if (!sceneId) return
    setChatLoadingByScene(prev => ({ ...prev, [sceneId]: value }))
  }, [])

  const setSceneChatStatus = useCallback(
    (sceneId: string | null, value: ChatStatus) => {
      if (!sceneId) return
      setChatStatusByScene(prev => ({ ...prev, [sceneId]: value }))
    },
    [],
  )

  const setSceneExitingStatus = useCallback(
    (sceneId: string | null, value: ChatResultStatus | null) => {
      if (!sceneId) return
      setExitingStatusByScene(prev => ({ ...prev, [sceneId]: value }))
    },
    [],
  )

  const isImageSpecPayload = useCallback((text: string) => {
    if (isImageSpecPayloadExternal) return isImageSpecPayloadExternal(text)
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
  }, [isImageSpecPayloadExternal])

  const stopMessage = useCallback((sceneId: string | null = activeSceneId) => {
    if (!sceneId) return
    const controller = chatAbortControllersRef.current[sceneId]
    if (!controller) return
    chatInterruptedScenesRef.current.add(sceneId)
    controller.abort()
  }, [activeSceneId, chatAbortControllersRef, chatInterruptedScenesRef])

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
  }, [getChatKey, chatLoadTokenRef])

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

  const appendChatMessageForScene = useCallback((sceneId: string | null, message: ChatMessage) => {
    const key = sceneId || 'draft'
    setChatByScene(prev => {
      const current = prev[key] || []
      const next = [...current, message]
      persistChatForScene(sceneId, next)
      return { ...prev, [key]: next }
    })
  }, [persistChatForScene])

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
  }, [canvexApiRef, getSelectedElementsByIds, resolveVideoImageUrls])

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
    setChatInput('')
    setSceneChatLoading(sceneId, true)
    chatSuccessRef.current = false
    chatStartTimeRef.current = Date.now()
    const abortController = new AbortController()
    chatAbortControllersRef.current[sceneId] = abortController
    let finalChatStatus: ChatResultStatus = 'error'
    let finalPlaceholderLabel = '生成失败'
    let backendContent = trimmed
    try {
      backendContent = await buildChatContentWithSelection(sceneId, trimmed)
    } catch (error) {
      console.warn('Build chat selection context failed', error)
      backendContent = trimmed
    }
    let pendingVideoPlaceholder: ImagePlaceholder | null = null
    let buffer = ''
    let assistantContent = ''
    let assistantNoteId: string | null = null
    let suppressAssistantPin = false
    let intentReceived = false
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

        if (toolName === 'mermaid_flowchart') {
          if (payload.result.error) {
            const failedMessage: ChatMessage = {
              id: `flowchart-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              role: 'assistant',
              content: t('aiFlowchartGenerateFailed', {
                defaultValue: '流程图生成失败：{{error}}',
                error: String(payload.result.error),
              }),
              created_at: new Date().toISOString(),
            }
            appendChatMessageForScene(sceneId, failedMessage)
            createPinnedNote(sceneId, failedMessage)
            return
          }

          const mermaid = String(payload.result.mermaid || '').trim()
          if (!mermaid) {
            const invalidMessage: ChatMessage = {
              id: `flowchart-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              role: 'assistant',
              content: t('aiFlowchartEmpty', {
                defaultValue: '流程图已生成，但返回的 Mermaid 为空。',
              }),
              created_at: new Date().toISOString(),
            }
            appendChatMessageForScene(sceneId, invalidMessage)
            createPinnedNote(sceneId, invalidMessage)
            return
          }

          const inserted = await insertMermaidFlowchartToCanvas(sceneId, mermaid)
          if (!inserted.ok) {
            const failedMessage: ChatMessage = {
              id: `flowchart-insert-failed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              role: 'assistant',
              content: t('aiFlowchartInsertFailed', {
                defaultValue: '流程图已生成，但插入画布失败：{{error}}',
                error: inserted.error || 'unknown',
              }),
              created_at: new Date().toISOString(),
            }
            appendChatMessageForScene(sceneId, failedMessage)
            createPinnedNote(sceneId, failedMessage)
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
                const placeholder = createImagePlaceholder(sceneId, '生成中…')
                if (placeholder) enqueueImagePlaceholder(placeholder)
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
          signal: abortController.signal,
        })
      }
      const response = await makeStreamRequest()
      if (!response.ok || !response.body) {
        throw new Error(`Chat stream failed (${response.status})`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')

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
      finalChatStatus = 'success'
    } catch (error) {
      const aborted = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (aborted) {
        if (chatInterruptedScenesRef.current.has(sceneId)) {
          finalChatStatus = 'interrupted'
          finalPlaceholderLabel = '已中断'
        }
        return
      }
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
        finalChatStatus = 'success'
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
      if (chatAbortControllersRef.current[sceneId] === abortController) {
        delete chatAbortControllersRef.current[sceneId]
      }
      const wasInterrupted = chatInterruptedScenesRef.current.has(sceneId)
      chatInterruptedScenesRef.current.delete(sceneId)
      if (wasInterrupted && finalChatStatus === 'error') {
        finalChatStatus = 'interrupted'
        finalPlaceholderLabel = '已中断'
      }
      queueUrgentSave()
      setSceneChatLoading(sceneId, false)
      if (finalChatStatus === 'success') {
        const elapsed = ((Date.now() - chatStartTimeRef.current) / 1000).toFixed(1)
        setChatElapsedTime(parseFloat(elapsed))
      }
      setSceneChatStatus(sceneId, finalChatStatus)
      markPendingPlaceholdersFailed(sceneId, finalPlaceholderLabel)
    }
  }, [activeSceneId, appendChatMessageForScene, buildChatContentWithSelection, chatInput, chatLoading, createImagePlaceholder, createPinnedImage, createPinnedNote, createPinnedVideo, enqueueImagePlaceholder, flushSave, insertMermaidFlowchartToCanvas, isImageSpecPayload, markPendingPlaceholdersFailed, queueUrgentSave, removeElementsById, setSceneChatLoading, setSceneChatStatus, t, takeNextImagePlaceholder, toErrorLabel, toVideoFailureLabel, updatePlaceholderText, updatePinnedNoteText, sceneIdRef, currentSceneRef, pendingRef, chatAbortControllersRef, chatInterruptedScenesRef])

  // Auto-hide status after 2 seconds with exit animation (per scene)
  useEffect(() => {
    if (!activeSceneId) return
    if (chatStatus === 'idle' || chatStatus === 'exiting') return
    setSceneExitingStatus(activeSceneId, chatStatus as ChatResultStatus)
    const exitTimeout = window.setTimeout(() => {
      setSceneChatStatus(activeSceneId, 'exiting')
      window.setTimeout(() => setSceneChatStatus(activeSceneId, 'idle'), 300)
    }, 2000)
    return () => window.clearTimeout(exitTimeout)
  }, [activeSceneId, chatStatus, setSceneChatStatus, setSceneExitingStatus])

  const loadingIcons = useMemo(() => [IconCat, IconButterfly, IconDog, IconFish, IconPaw], [])

  useEffect(() => {
    if (!chatLoading) {
      setLoadingIconIndex(0)
      return
    }
    const interval = window.setInterval(() => {
      setLoadingIconIndex(prev => (prev + 1) % loadingIcons.length)
    }, 500)
    return () => window.clearInterval(interval)
  }, [chatLoading, loadingIcons.length])

  // Cleanup abort controllers on unmount
  useEffect(() => {
    return () => {
      for (const controller of Object.values(chatAbortControllersRef.current)) {
        try {
          controller.abort()
        } catch {
          // ignore abort cleanup errors
        }
      }
      chatAbortControllersRef.current = {}
    }
  }, [chatAbortControllersRef])

  return {
    chatInput,
    setChatInput,
    chatLoading,
    chatStatus,
    exitingStatus,
    chatElapsedTime,
    loadingIconIndex,
    loadingIcons,
    chatSuccessRef,
    chatStartTimeRef,
    setSceneChatLoading,
    setSceneChatStatus,
    setSceneExitingStatus,
    isImageSpecPayload,
    stopMessage,
    loadChatForScene,
    persistChatForScene,
    migrateDraftChatToScene,
    appendChatMessageForScene,
    buildChatContentWithSelection,
    sendMessage,
  }
}
