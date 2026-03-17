import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaptureUpdateAction, exportToBlob, MIME_TYPES } from '@excalidraw/excalidraw'
import { request } from '@/utils/request'
import type { HoverAnchor, ImagePlaceholder, PinRect, SelectionBounds, ToolResult } from '@/types/canvex'
import { MAX_CANVAS_IMAGE_DIM, resolveImageEditSize } from '@/constants/canvex'

const SPLIT_INPAINT_PROMPT =
  'Identify the main subject/foreground object indicated by the user-drawn dashed bounding box. ' +
  'The dashed bounding box is a guide only and must NOT appear in the output.\n\n' +
  'Remove the subject completely from the image. ' +
  'Fill the area where the subject was with a natural continuation of the surrounding background. ' +
  'The result should look like the subject was never there.\n\n' +
  'Do NOT add, hallucinate, or introduce any new objects. ' +
  'Preserve all background details, lighting, textures, and perspective. ' +
  'Edges of the filled area must blend seamlessly with the surrounding background. ' +
  'The final image must contain only the background with no trace of the removed subject.'

export function useImageEditPipeline({
  sceneIdRef,
  canvexApiRef,
  createPinnedImageRef,
  recoveredImageEditScenesRef,
  imagePollInFlightRef,
  getSceneElementsSafe,
  getSelectedElementsByIds,
  getSelectionBounds,
  getSceneRectViewportRect,
  createRectElement,
  createTextElement,
  createImageElement,
  findNonOverlappingPinPosition,
  flashPinnedElement,
  loadImageDataUrl,
  removeElementsById,
  updatePlaceholderText,
  updatePlaceholderMeta,
  captureSceneSnapshot,
  queueUrgentSave,
  isVideoElement,
  scheduleVideoOverlayRefresh,
  canShowAiEditBar,
}: {
  sceneIdRef: React.MutableRefObject<string | null>
  canvexApiRef: React.MutableRefObject<any>
  createPinnedImageRef: React.MutableRefObject<any>
  recoveredImageEditScenesRef: React.MutableRefObject<Record<string, boolean>>
  imagePollInFlightRef: React.MutableRefObject<Set<string>>
  getSceneElementsSafe: () => any[]
  getSelectedElementsByIds: (ids: string[]) => any[]
  getSelectionBounds: (elements: any[]) => SelectionBounds | null
  getSceneRectViewportRect: (rect: { x: number; y: number; width: number; height: number }, appStateOverride?: any) => PinRect | null
  createRectElement: (overrides: Record<string, any>) => any
  createTextElement: (overrides: Record<string, any>) => any
  createImageElement: (overrides: Record<string, any>) => any
  findNonOverlappingPinPosition: (elements: any[], x: number, startY: number, width: number, height: number, gap?: number) => { x: number; y: number }
  flashPinnedElement: (element: any) => void
  loadImageDataUrl: (url: string, maxDim?: number | null) => Promise<{ dataUrl: string; width: number | null; height: number | null }>
  removeElementsById: (ids: string[]) => void
  updatePlaceholderText: (placeholder: ImagePlaceholder, content: string) => void
  updatePlaceholderMeta: (placeholder: ImagePlaceholder, meta: Record<string, any>) => void
  captureSceneSnapshot: () => void
  queueUrgentSave: () => void
  isVideoElement: (item: any) => boolean
  scheduleVideoOverlayRefresh: () => void
  canShowAiEditBar: boolean
}) {
  const { t } = useTranslation('canvex')
  const [imageEditPrompt, setImageEditPrompt] = useState('')
  const [imageEditSize, setImageEditSize] = useState('')
  const [imageEditCount, setImageEditCount] = useState(1)
  const [imageEditError, setImageEditError] = useState<string | null>(null)
  const [imageEditPendingIds, setImageEditPendingIds] = useState<string[]>([])
  const [selectedEditIds, setSelectedEditIds] = useState<string[]>([])
  const [selectedEditKey, setSelectedEditKey] = useState<string | null>(null)
  const [selectedEditRect, setSelectedEditRect] = useState<PinRect | null>(null)
  const [selectedEditPreview, setSelectedEditPreview] = useState<string | null>(null)

  // Refs to break the self-referencing cycle in updateSelectedEditSelection:
  // the callback reads these values (to check if state actually changed) and
  // also sets them, so using state in the dep array causes an infinite loop.
  const selectedEditKeyRef = useRef(selectedEditKey)
  selectedEditKeyRef.current = selectedEditKey
  const selectedEditRectRef = useRef(selectedEditRect)
  selectedEditRectRef.current = selectedEditRect
  const selectedEditIdsRef = useRef(selectedEditIds)
  selectedEditIdsRef.current = selectedEditIds
  const [previewAnchor, setPreviewAnchor] = useState<HoverAnchor | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const scrollUnsubRef = useRef<null | (() => void)>(null)

  const toErrorLabel = useCallback((value: any) => {
    if (!value) return '生成失败'
    const text = String(value)
    return `生成失败：${text}`
  }, [])

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
      const loaded = await loadImageDataUrl(url, MAX_CANVAS_IMAGE_DIM)
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
        aiImageMimeType: result?.mime_type || 'image/png',
        aiNaturalWidth: naturalWidth,
        aiNaturalHeight: naturalHeight,
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
  }, [canvexApiRef, captureSceneSnapshot, createImageElement, getSceneElementsSafe, loadImageDataUrl, queueUrgentSave])

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
  }, [canvexApiRef])

  const insertEditedImageFromPlaceholder = useCallback(async (
    placeholder: ImagePlaceholder | null,
    result: ToolResult['result'],
  ) => {
    const bounds = getPlaceholderBounds(placeholder)
    if (!bounds) return false
    return insertEditedImage(bounds, result, placeholder)
  }, [getPlaceholderBounds, insertEditedImage])

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
          return (a.order ?? 0) - (b.order ?? 0)
        }
        return (a.x || 0) - (b.x || 0)
      })
      .map(({ order, x, ...rest }) => rest)
    return placeholders
  }, [canvexApiRef])

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
          return (a.order ?? 0) - (b.order ?? 0)
        }
        return (a.x || 0) - (b.x || 0)
      })
      .map(({ order, x, ...rest }) => rest)
  }, [canvexApiRef])

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
      placeholders.push({ sceneId: sceneId!, groupId, rectId: rect.id, textId: text.id })
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
  }, [canvexApiRef, createRectElement, createTextElement, flashPinnedElement, getSceneElementsSafe, sceneIdRef])

  const getRemoteImageMimeType = useCallback((element: any) => {
    const raw = element?.customData?.aiImageMimeType
    return typeof raw === 'string' && raw ? raw : 'image/png'
  }, [])

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
    const maxAttemptsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_MAX_ATTEMPTS ?? 600)
    const delayMsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_INTERVAL_MS ?? 3000)
    const maxAttempts = Number.isFinite(maxAttemptsEnv) && maxAttemptsEnv > 0 ? Math.floor(maxAttemptsEnv) : 600
    const delayMs = Number.isFinite(delayMsEnv) && delayMsEnv > 0 ? Math.floor(delayMsEnv) : 3000
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
  }, [imagePollInFlightRef, insertEditedImage, sceneIdRef, selectedEditKey, t, toErrorLabel, updatePlaceholderText])

  const pollImageEditJobForPlaceholders = useCallback(async (
    jobId: string,
    sceneId: string,
    placeholders: ImagePlaceholder[],
  ) => {
    const pollKey = `${sceneId}:${jobId}`
    if (imagePollInFlightRef.current.has(pollKey)) return
    imagePollInFlightRef.current.add(pollKey)
    const maxAttemptsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_MAX_ATTEMPTS ?? 600)
    const delayMsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_INTERVAL_MS ?? 3000)
    const maxAttempts = Number.isFinite(maxAttemptsEnv) && maxAttemptsEnv > 0 ? Math.floor(maxAttemptsEnv) : 600
    const delayMs = Number.isFinite(delayMsEnv) && delayMsEnv > 0 ? Math.floor(delayMsEnv) : 3000
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
  }, [imagePollInFlightRef, insertEditedImageFromPlaceholder, sceneIdRef, t, toErrorLabel, updatePlaceholderText])

  const pollImageEditJobWithoutPlaceholder = useCallback(async (
    jobId: string,
    sceneId: string,
  ) => {
    const pollKey = `${sceneId}:${jobId}:recover`
    if (imagePollInFlightRef.current.has(pollKey) || imagePollInFlightRef.current.has(`${sceneId}:${jobId}`)) return
    imagePollInFlightRef.current.add(pollKey)
    const maxAttemptsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_MAX_ATTEMPTS ?? 600)
    const delayMsEnv = Number(import.meta.env.VITE_IMAGE_EDIT_POLL_INTERVAL_MS ?? 3000)
    const maxAttempts = Number.isFinite(maxAttemptsEnv) && maxAttemptsEnv > 0 ? Math.floor(maxAttemptsEnv) : 600
    const delayMs = Number.isFinite(delayMsEnv) && delayMsEnv > 0 ? Math.floor(delayMsEnv) : 3000
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
  }, [createPinnedImageRef, imagePollInFlightRef, queueUrgentSave, sceneIdRef])

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
      const jobs: Array<{ id?: string; status?: string; num_images?: number; error?: string | null }> = Array.isArray(res.data)
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
        const jid = String(data.aiEditJobId)
        const order = Number(data.aiEditOrder)
        if (!existingOrdersByJobId.has(jid)) {
          existingOrdersByJobId.set(jid, new Set())
        }
        if (Number.isFinite(order)) {
          existingOrdersByJobId.get(jid)!.add(order)
        }
      }

      const orphanPlaceholders = findOrphanImageEditPlaceholders(sceneId)
      let orphanIndex = 0

      for (const job of jobs) {
        const jobId = job?.id ? String(job.id) : ''
        const status = String(job?.status || '').toUpperCase()
        if (!jobId || !status) continue
        if (imagePollInFlightRef.current.has(`${sceneId}:${jobId}`)) continue
        let placeholders = findImageEditPlaceholdersByJobId(sceneId, jobId)
        const canBindOrphanPlaceholders = status === 'QUEUED' || status === 'RUNNING'
        if (!placeholders.length && canBindOrphanPlaceholders && orphanPlaceholders.length) {
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
    canvexApiRef,
    findImageEditPlaceholdersByJobId,
    findOrphanImageEditPlaceholders,
    imagePollInFlightRef,
    insertEditedImageFromPlaceholder,
    pollImageEditJobForPlaceholders,
    pollImageEditJobWithoutPlaceholder,
    recoveredImageEditScenesRef,
    removeElementsById,
    sceneIdRef,
    t,
    toErrorLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  const updateSelectedEditSelection = useCallback((appStateOverride?: any) => {
    scheduleVideoOverlayRefresh()
    const api = canvexApiRef.current
    if (!api?.getSceneElements || !api?.getAppState) return
    // Read from refs to avoid self-referencing dep cycle
    const curKey = selectedEditKeyRef.current
    const curRect = selectedEditRectRef.current
    const curIdsLen = selectedEditIdsRef.current.length
    if (!canShowAiEditBar) {
      if (curKey !== null || curRect !== null) {
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
      if (curKey !== null || curRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const selectedElements = getSelectedElementsByIds(ids)
    if (!selectedElements.length) {
      if (curKey !== null || curRect !== null) {
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
      if (curKey !== null || curRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const hasImageTrigger = editableElements.some((item: any) => String(item?.type || '').toLowerCase() === 'image')
    if (!hasImageTrigger) {
      if (curKey !== null || curRect !== null || curIdsLen) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const bounds = getSelectionBounds(editableElements)
    if (!bounds) {
      if (curKey !== null || curRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const rect = getSceneRectViewportRect(bounds, appState)
    if (!rect) {
      if (curKey !== null || curRect !== null) {
        setSelectedEditIds([])
        setSelectedEditKey(null)
        setSelectedEditRect(null)
      }
      return
    }
    const nextIds = editableElements.map((item: any) => String(item.id)).sort()
    const nextKey = nextIds.join('|')
    const sameRect = curRect
      && Math.abs(curRect.x - rect.x) < 0.5
      && Math.abs(curRect.y - rect.y) < 0.5
      && Math.abs(curRect.width - rect.width) < 0.5
      && Math.abs(curRect.height - rect.height) < 0.5
    if (curKey === nextKey && sameRect) return
    setSelectedEditIds(nextIds)
    setSelectedEditKey(nextKey)
    setSelectedEditRect(rect)
  }, [canShowAiEditBar, canvexApiRef, getSceneRectViewportRect, getSelectedElementsByIds, getSelectionBounds, isVideoElement, scheduleVideoOverlayRefresh])

  // Preview generation effect
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
    const exportElements = selectedElements.filter((item) => item && !isVideoElement(item))
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
      getDimensions: (width: number, height: number) => ({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
      }),
    }).then((blob: Blob) => {
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
  }, [canShowAiEditBar, canvexApiRef, getSelectedElementsByIds, getSelectionBounds, isVideoElement, selectedEditIds, selectedEditKey])

  // Clear edit state when AI bar hidden
  useEffect(() => {
    if (canShowAiEditBar) return
    if (selectedEditKey !== null || selectedEditRect !== null || selectedEditIds.length) {
      setSelectedEditIds([])
      setSelectedEditKey(null)
      setSelectedEditRect(null)
    }
    setPreviewAnchor(null)
  }, [canShowAiEditBar, selectedEditIds.length, selectedEditKey, selectedEditRect])

  // Clear prompt on selection change
  useEffect(() => {
    setImageEditPrompt('')
    setImageEditError(null)
  }, [selectedEditKey])

  // Cleanup scroll unsub
  useEffect(() => {
    return () => {
      if (scrollUnsubRef.current) {
        scrollUnsubRef.current()
        scrollUnsubRef.current = null
      }
    }
  }, [])

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
      const loaded = await loadImageDataUrl(url, MAX_CANVAS_IMAGE_DIM)
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

    api.getAppState()
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
      const gap = 16
      const maxWidth = MAX_CANVAS_IMAGE_DIM
      const scale = naturalWidth > 0 ? Math.min(1, maxWidth / naturalWidth) : 1
      width = Math.max(120, Math.round(naturalWidth * scale))
      height = Math.max(120, Math.round(naturalHeight * scale))
      const placement = findNonOverlappingPinPosition(existing, 32, 32, width, height, gap)
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
      customData: {
        aiChatType: 'note-image',
        aiChatCreatedAt: new Date().toISOString(),
        aiChatImageUrl: url,
        aiChatAssetId: tool?.result?.asset_id,
        aiImageMimeType: tool?.result?.mime_type || 'image/png',
        aiNaturalWidth: naturalWidth,
        aiNaturalHeight: naturalHeight,
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
    flashPinnedElement(imageElement)
    return true
  }, [canvexApiRef, captureSceneSnapshot, createImageElement, findNonOverlappingPinPosition, flashPinnedElement, getSceneElementsSafe, loadImageDataUrl, queueUrgentSave, sceneIdRef])

  useEffect(() => {
    createPinnedImageRef.current = createPinnedImage
  }, [createPinnedImage, createPinnedImageRef])

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
    canvexApiRef,
    createEditImagePlaceholders,
    getSelectedElementsByIds,
    getSelectionBounds,
    imageEditCount,
    imageEditPendingIds,
    imageEditPrompt,
    imageEditSize,
    isVideoElement,
    pollImageEditJob,
    sceneIdRef,
    selectedEditIds,
    selectedEditKey,
    t,
    toErrorLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  // ── Split Element: produce cutout (subject) + inpainted background ──
  const handleSplitElement = useCallback(async () => {
    if (!selectedEditKey || !selectedEditIds.length) return
    if (imageEditPendingIds.includes(selectedEditKey)) return
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
    const exportElements = selectedElements.filter((item) => item && !isVideoElement(item))
    if (!exportElements.length) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }
    const bounds = getSelectionBounds(exportElements)
    if (!bounds) {
      setImageEditError(t('editNoImage', { defaultValue: 'Select an image to edit.' }))
      return
    }

    setImageEditPendingIds(prev => (prev.includes(selectedEditKey) ? prev : [...prev, selectedEditKey]))
    setImageEditError(null)

    // Create 2 overlapping placeholders (same position, like layers)
    // Background layer first (below), then subject layer on top
    const backgroundPlaceholders = createEditImagePlaceholders(
      sceneId, bounds, t('splitBackground', { defaultValue: 'splitting...' }), 1,
    )
    const subjectPlaceholders = createEditImagePlaceholders(
      sceneId, bounds, '', 1,
    )
    const placeholders = [...subjectPlaceholders, ...backgroundPlaceholders]

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

      // Build two FormData payloads
      const cutoutForm = new FormData()
      cutoutForm.append('image', blob, 'image.png')
      cutoutForm.append('cutout', '1')
      cutoutForm.append('n', '1')

      const inpaintForm = new FormData()
      inpaintForm.append('image', blob, 'image.png')
      inpaintForm.append('prompt', SPLIT_INPAINT_PROMPT)
      inpaintForm.append('n', '1')

      // Fire both requests in parallel
      const [cutoutRes, inpaintRes] = await Promise.all([
        request.post(`/api/v1/excalidraw/scenes/${sceneId}/image-edit/`, cutoutForm),
        request.post(`/api/v1/excalidraw/scenes/${sceneId}/image-edit/`, inpaintForm),
      ])

      const cutoutJobId = cutoutRes.data?.job_id
      const inpaintJobId = inpaintRes.data?.job_id
      if (!cutoutJobId || !inpaintJobId) throw new Error('job id missing')

      // Attach job IDs to placeholders
      if (subjectPlaceholders[0]) updatePlaceholderMeta(subjectPlaceholders[0], { aiEditJobId: String(cutoutJobId) })
      if (backgroundPlaceholders[0]) updatePlaceholderMeta(backgroundPlaceholders[0], { aiEditJobId: String(inpaintJobId) })

      // Poll both jobs in parallel
      await Promise.all([
        pollImageEditJob(cutoutJobId, sceneId, bounds, selectedEditKey, subjectPlaceholders),
        pollImageEditJob(inpaintJobId, sceneId, bounds, selectedEditKey, backgroundPlaceholders),
      ])

      // Ensure cutout (subject) is above inpaint (background) in z-order.
      // Whichever job finishes last gets appended last and ends up on top,
      // so we need to reorder after both complete.
      if (sceneIdRef.current === sceneId) {
        const api2 = canvexApiRef.current
        if (api2?.getSceneElements && api2?.updateScene) {
          const els = api2.getSceneElements()
          const cutoutIdx = els.findIndex((e: any) =>
            e && !e.isDeleted && e.type === 'image' && String(e.customData?.aiEditJobId) === String(cutoutJobId),
          )
          const inpaintIdx = els.findIndex((e: any) =>
            e && !e.isDeleted && e.type === 'image' && String(e.customData?.aiEditJobId) === String(inpaintJobId),
          )
          // If cutout is before inpaint in array, it's rendered below — swap them
          if (cutoutIdx >= 0 && inpaintIdx >= 0 && cutoutIdx < inpaintIdx) {
            const reordered = [...els]
            const [cutoutEl] = reordered.splice(cutoutIdx, 1)
            // After removing cutoutEl, inpaintIdx shifted by -1 if it was after cutoutIdx
            reordered.splice(inpaintIdx, 0, cutoutEl)
            api2.updateScene({
              elements: reordered,
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            })
          }
        }
      }
    } catch (error) {
      console.error('Split element failed', error)
      if (placeholders?.length) {
        for (const item of placeholders) {
          updatePlaceholderText(item, toErrorLabel(t('splitFailed', { defaultValue: '拆分失败' })))
        }
      } else {
        setImageEditError(t('splitFailed', { defaultValue: '拆分失败' }))
      }
    } finally {
      setImageEditPendingIds(prev => prev.filter((id) => id !== selectedEditKey))
    }
  }, [
    canvexApiRef,
    createEditImagePlaceholders,
    getSelectedElementsByIds,
    getSelectionBounds,
    imageEditPendingIds,
    isVideoElement,
    pollImageEditJob,
    sceneIdRef,
    selectedEditIds,
    selectedEditKey,
    t,
    toErrorLabel,
    updatePlaceholderMeta,
    updatePlaceholderText,
  ])

  return {
    imageEditPrompt,
    setImageEditPrompt,
    imageEditSize,
    setImageEditSize,
    imageEditCount,
    setImageEditCount,
    imageEditError,
    setImageEditError,
    imageEditPendingIds,
    selectedEditIds,
    selectedEditKey,
    selectedEditRect,
    selectedEditPreview,
    previewAnchor,
    setPreviewAnchor,
    scrollUnsubRef,
    toErrorLabel,
    createPinnedImage,
    insertEditedImage,
    createEditImagePlaceholders,
    findImageEditPlaceholdersByJobId,
    findOrphanImageEditPlaceholders,
    loadImageDataUrl,
    getRemoteImageMimeType,
    getPlaceholderBounds,
    insertEditedImageFromPlaceholder,
    pollImageEditJob,
    pollImageEditJobForPlaceholders,
    pollImageEditJobWithoutPlaceholder,
    recoverImageEditJobsForScene,
    updateSelectedEditSelection,
    handleImageEdit,
    handleSplitElement,
  }
}
