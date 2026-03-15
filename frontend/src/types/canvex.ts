export type SceneData = {
  elements?: any[]
  appState?: Record<string, any>
  files?: Record<string, any>
}

export type SceneRecord = {
  id: string
  title?: string
  data?: SceneData
  created_at?: string
  updated_at?: string
}

export type LocalCache = {
  sceneId?: string | null
  data: SceneData
  updatedAt?: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export type ChatResultStatus = 'success' | 'error' | 'interrupted'
export type ChatStatus = 'idle' | ChatResultStatus | 'exiting'

export type PinOrigin = {
  x: number
  y: number
}

export type PinRect = {
  x: number
  y: number
  width: number
  height: number
}

export type SelectionBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type HoverAnchor = {
  x: number
  y: number
  width: number
  height: number
}

export type ToolResult = {
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
    mermaid?: string
    format?: string
    diagram_type?: string
    direction?: string
    [key: string]: any
  }
}

export type MermaidInsertResult = {
  ok: boolean
  insertedCount?: number
  error?: string
}

export type ImagePlaceholder = {
  sceneId: string
  groupId: string
  rectId: string
  textId: string
}

export type PlaceholderOptions = {
  kind?: 'image' | 'video'
  jobId?: string | null
}

export type VideoJobResult = {
  job_id?: string
  status?: string
  result?: {
    url?: string
    thumbnail_url?: string
    task_id?: string
  }
  error?: string
}

export type VideoJobListItem = {
  id?: string
  status?: string
  result_url?: string | null
  thumbnail_url?: string | null
  task_id?: string | null
}

export type ImageEditJobListItem = {
  id?: string
  status?: string
  num_images?: number
  error?: string | null
}

export type VideoOverlayItem = {
  id: string
  url: string
  thumbnailUrl?: string | null
}

export type MediaLibraryImageItem = {
  id: string
  url: string
  filename: string
  mimeType: string
  width: number | null
  height: number | null
  createdAt: string | null
  projectName: string
}

export type MediaLibraryVideoItem = {
  id: string
  url: string
  thumbnailUrl: string | null
  taskId: string | null
  createdAt: string | null
  projectName: string
}

export type MediaProjectFolder = {
  key: string
  projectName: string
  images: MediaLibraryImageItem[]
  videos: MediaLibraryVideoItem[]
}

export type DataFolderRecord = {
  id: string
  name: string
  parent: string | null
}
