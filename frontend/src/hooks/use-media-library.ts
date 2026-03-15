import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/utils/request'
import type { MediaLibraryImageItem, MediaLibraryVideoItem, MediaProjectFolder, DataFolderRecord } from '@/types/canvex'
import { toListPayload, normalizeProjectName, resolveProjectNameFromFolder } from '@/utils/canvex'

export function useMediaLibrary({
  scenes,
  activeSceneId,
  createPinnedImageRef,
  createPinnedVideoRef,
}: {
  scenes: Array<{ id: string; title?: string }>
  activeSceneId: string | null
  createPinnedImageRef: React.MutableRefObject<any>
  createPinnedVideoRef: React.MutableRefObject<any>
}) {
  const { t } = useTranslation('canvex')
  const [mediaLibraryImages, setMediaLibraryImages] = useState<MediaLibraryImageItem[]>([])
  const [mediaLibraryVideos, setMediaLibraryVideos] = useState<MediaLibraryVideoItem[]>([])
  const [mediaLibraryLoading, setMediaLibraryLoading] = useState(false)
  const [mediaLibraryError, setMediaLibraryError] = useState<string | null>(null)
  const [mediaSidebarOpen, setMediaSidebarOpen] = useState(false)
  const [mediaFolderOpenByKey, setMediaFolderOpenByKey] = useState<Record<string, boolean>>({})
  const [mediaTypeOpenByKey, setMediaTypeOpenByKey] = useState<Record<string, boolean>>({})
  const mediaLibraryRequestTokenRef = useRef(0)

  const activeProjectName = useMemo(() => {
    const activeScene = scenes.find((item) => item.id === activeSceneId)
    return normalizeProjectName(activeScene?.title, 'Untitled')
  }, [activeSceneId, scenes])

  const loadMediaLibrary = useCallback(async (sceneId: string | null) => {
    const requestToken = Date.now()
    mediaLibraryRequestTokenRef.current = requestToken
    setMediaLibraryLoading(true)
    setMediaLibraryError(null)
    try {
      const sceneEntries = Array.from(new Map(
        (scenes || [])
          .filter((item) => item?.id)
          .map((item) => [
            String(item.id),
            normalizeProjectName(item.title, 'Untitled'),
          ]),
      ).entries()).map(([id, title]) => ({ id, title }))

      if (sceneId && !sceneEntries.some((item) => item.id === sceneId)) {
        sceneEntries.unshift({
          id: sceneId,
          title: normalizeProjectName(
            scenes.find((item) => item.id === sceneId)?.title,
            'Untitled',
          ),
        })
      }

      const [imageRes, folderRes, videoSettled] = await Promise.all([
        request.get('/api/v1/library/assets/'),
        request.get('/api/v1/library/folders/'),
        Promise.allSettled(
          sceneEntries.map((scene) => request.get(`/api/v1/excalidraw/scenes/${scene.id}/video-jobs/?limit=50`)),
        ),
      ])

      const folders = toListPayload<any>(folderRes.data).map((item: any) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        parent: item.parent ? String(item.parent) : null,
      }))
      const folderMap = new Map<string, DataFolderRecord>()
      for (const folder of folders) {
        if (folder.id) {
          folderMap.set(folder.id, folder)
        }
      }

      const nextImages = toListPayload<any>(imageRes.data)
        .filter((item: any) => typeof item?.url === 'string' && item.url)
        .map((item: any) => ({
          id: String(item.id || ''),
          url: String(item.url || ''),
          filename: String(item.filename || item.id || 'image'),
          mimeType: String(item.mime_type || 'image/png'),
          width: Number.isFinite(Number(item.width)) ? Number(item.width) : null,
          height: Number.isFinite(Number(item.height)) ? Number(item.height) : null,
          createdAt: item.created_at ? String(item.created_at) : null,
          projectName: resolveProjectNameFromFolder(
            item?.folder ? String(item.folder) : null,
            folderMap,
          ),
        }))

      const nextVideos: MediaLibraryVideoItem[] = []
      for (let index = 0; index < videoSettled.length; index += 1) {
        const settled = videoSettled[index]
        if (settled.status !== 'fulfilled') continue
        const scene = sceneEntries[index]
        const projectName = normalizeProjectName(scene?.title, 'Untitled')
        const jobs = toListPayload<any>(settled.value?.data)
        for (const item of jobs) {
          const status = String(item?.status || '').toUpperCase()
          if (status !== 'SUCCEEDED') continue
          const resultUrl = String(item?.result_url || '')
          if (!resultUrl) continue
          nextVideos.push({
            id: String(item.id || item.task_id || item.result_url),
            url: resultUrl,
            thumbnailUrl: item.thumbnail_url ? String(item.thumbnail_url) : null,
            taskId: item.task_id ? String(item.task_id) : null,
            createdAt: item.created_at ? String(item.created_at) : null,
            projectName,
          })
        }
      }

      if (mediaLibraryRequestTokenRef.current !== requestToken) return
      setMediaLibraryImages(nextImages)
      setMediaLibraryVideos(nextVideos)
    } catch (error) {
      if (mediaLibraryRequestTokenRef.current !== requestToken) return
      console.error('Load media library failed', error)
      setMediaLibraryError(t('mediaLibraryLoadFailed', { defaultValue: '媒体素材库加载失败，请稍后重试。' }))
    } finally {
      if (mediaLibraryRequestTokenRef.current === requestToken) {
        setMediaLibraryLoading(false)
      }
    }
  }, [scenes, t])

  useEffect(() => {
    if (!mediaSidebarOpen) return
    void loadMediaLibrary(activeSceneId)
  }, [activeSceneId, loadMediaLibrary, mediaSidebarOpen])

  const refreshMediaLibrary = useCallback(() => {
    void loadMediaLibrary(activeSceneId)
  }, [activeSceneId, loadMediaLibrary])

  const mediaProjectFolders = useMemo<MediaProjectFolder[]>(() => {
    const grouped = new Map<string, MediaProjectFolder>()
    const ensureGroup = (projectNameRaw: unknown) => {
      const projectName = normalizeProjectName(projectNameRaw, 'Untitled')
      const key = projectName
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          projectName,
          images: [],
          videos: [],
        })
      }
      return grouped.get(key)!
    }

    for (const item of mediaLibraryImages) {
      ensureGroup(item.projectName).images.push(item)
    }
    for (const item of mediaLibraryVideos) {
      ensureGroup(item.projectName).videos.push(item)
    }

    return Array.from(grouped.values()).sort((a, b) => {
      if (a.projectName === activeProjectName && b.projectName !== activeProjectName) return -1
      if (b.projectName === activeProjectName && a.projectName !== activeProjectName) return 1
      return a.projectName.localeCompare(b.projectName)
    })
  }, [activeProjectName, mediaLibraryImages, mediaLibraryVideos])

  useEffect(() => {
    setMediaFolderOpenByKey((prev) => {
      const next: Record<string, boolean> = {}
      let changed = false
      for (const folder of mediaProjectFolders) {
        if (Object.prototype.hasOwnProperty.call(prev, folder.key)) {
          next[folder.key] = Boolean(prev[folder.key])
        } else {
          next[folder.key] = folder.projectName === activeProjectName
          changed = true
        }
      }

      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (!changed && prevKeys.length !== nextKeys.length) changed = true
      if (!changed) {
        for (const key of nextKeys) {
          if (Boolean(prev[key]) !== Boolean(next[key])) {
            changed = true
            break
          }
        }
      }
      return changed ? next : prev
    })
  }, [activeProjectName, mediaProjectFolders])

  useEffect(() => {
    setMediaTypeOpenByKey((prev) => {
      const next: Record<string, boolean> = {}
      let changed = false
      for (const folder of mediaProjectFolders) {
        if (folder.images.length > 0) {
          const key = `${folder.key}:image`
          if (Object.prototype.hasOwnProperty.call(prev, key)) {
            next[key] = Boolean(prev[key])
          } else {
            next[key] = true
            changed = true
          }
        }
        if (folder.videos.length > 0) {
          const key = `${folder.key}:video`
          if (Object.prototype.hasOwnProperty.call(prev, key)) {
            next[key] = Boolean(prev[key])
          } else {
            next[key] = true
            changed = true
          }
        }
      }

      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (!changed && prevKeys.length !== nextKeys.length) changed = true
      if (!changed) {
        for (const key of nextKeys) {
          if (Boolean(prev[key]) !== Boolean(next[key])) {
            changed = true
            break
          }
        }
      }
      return changed ? next : prev
    })
  }, [mediaProjectFolders])

  const toggleMediaProjectFolder = useCallback((key: string) => {
    setMediaFolderOpenByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }, [])

  const toggleMediaTypeSection = useCallback((key: string) => {
    setMediaTypeOpenByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }, [])

  const insertImageFromMediaLibrary = useCallback(async (item: MediaLibraryImageItem) => {
    const createPinnedImage = createPinnedImageRef.current
    if (!createPinnedImage) return
    const created = await createPinnedImage(
      activeSceneId,
      {
        tool: 'media-library',
        result: {
          url: item.url,
          width: item.width,
          height: item.height,
          asset_id: item.id,
          mime_type: item.mimeType,
        },
      },
      null,
      {
        aiLibraryType: 'image',
        aiLibraryAssetId: item.id,
      },
    )
    if (!created) {
      setMediaLibraryError(t('mediaLibraryInsertFailed', { defaultValue: '媒体素材插入失败，请重试。' }))
    }
  }, [activeSceneId, createPinnedImageRef, t])

  const insertVideoFromMediaLibrary = useCallback(async (item: MediaLibraryVideoItem) => {
    const createPinnedVideo = createPinnedVideoRef.current
    if (!createPinnedVideo || !activeSceneId) return
    const created = await createPinnedVideo(
      activeSceneId,
      item.url,
      item.thumbnailUrl,
      null,
      item.id,
    )
    if (!created) {
      setMediaLibraryError(t('mediaLibraryInsertFailed', { defaultValue: '媒体素材插入失败，请重试。' }))
    }
  }, [activeSceneId, createPinnedVideoRef, t])

  return {
    mediaLibraryImages,
    mediaLibraryVideos,
    mediaLibraryLoading,
    mediaLibraryError,
    setMediaLibraryError,
    mediaSidebarOpen,
    setMediaSidebarOpen,
    mediaFolderOpenByKey,
    mediaTypeOpenByKey,
    activeProjectName,
    loadMediaLibrary,
    refreshMediaLibrary,
    mediaProjectFolders,
    toggleMediaProjectFolder,
    toggleMediaTypeSection,
    insertImageFromMediaLibrary,
    insertVideoFromMediaLibrary,
  }
}
