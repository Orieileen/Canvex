import type { SceneRecord, DataFolderRecord } from '@/types/canvex'

export const toListPayload = <T = any,>(payload: any): T[] => {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && Array.isArray(payload.results)) return payload.results as T[]
  return []
}

export const normalizeProjectName = (value: unknown, fallback = 'Untitled') => {
  const text = String(value || '').trim()
  return text || fallback
}

export const toSceneSummary = (scene: SceneRecord): SceneRecord => ({
  id: String(scene.id),
  title: typeof scene.title === 'string' ? scene.title : '',
  created_at: scene.created_at,
  updated_at: scene.updated_at,
})

export const resolveProjectNameFromFolder = (
  folderId: string | null,
  folderMap: Map<string, DataFolderRecord>,
) => {
  if (!folderId) return 'Untitled'
  let current = folderMap.get(folderId) || null
  if (!current) return 'Untitled'

  const chain: DataFolderRecord[] = []
  while (current) {
    chain.unshift(current)
    if (!current.parent) break
    current = folderMap.get(current.parent) || null
  }

  const drawmindIndex = chain.findIndex((item) => item.name.toLowerCase() === 'drawmind')
  if (drawmindIndex >= 0 && chain[drawmindIndex + 1]?.name) {
    return normalizeProjectName(chain[drawmindIndex + 1].name, 'Untitled')
  }
  const nearestName = chain[chain.length - 1]?.name || ''
  return normalizeProjectName(nearestName, 'Untitled')
}

export const isPregeneratedKeyword = (raw: unknown) => {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return false
  if (value.includes('预生成')) return true
  const normalized = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  return (
    normalized.includes('pregenerate')
    || normalized.includes('pregenerated')
    || normalized.includes('pre generate')
  )
}

export const getFontFamilyName = (family: number) => {
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

export const getLatestElements = (elements: any[]) => {
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

export const normalizeFlowchartLabelText = (value: string) => {
  let text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'Node'
  text = text
    .replace(/`/g, '')
    .replace(/\{+/g, '(')
    .replace(/\}+/g, ')')
    .replace(/\[\[/g, '(')
    .replace(/\]\]/g, ')')
    .replace(/->/g, '→')
    .replace(/<-/g, '←')
    .replace(/\|/g, '¦')
    .replace(/"/g, '\\"')
  return text
}

export const normalizeMermaidForCanvasParser = (value: string) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const output: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) {
      output.push(line)
      continue
    }
    if (i === 0) {
      output.push(line)
      continue
    }
    let next = line
    next = next.replace(/([A-Za-z][A-Za-z0-9_]*)\[(.*?)\]/g, (_match, id: string, label: string) => {
      return `${id}["${normalizeFlowchartLabelText(label)}"]`
    })
    next = next.replace(/([A-Za-z][A-Za-z0-9_]*)\{([^{}]*?)\}/g, (_match, id: string, label: string) => {
      return `${id}["${normalizeFlowchartLabelText(label)}"]`
    })
    output.push(next)
  }
  return output.join('\n')
}

export const sanitizeAppState = (appState?: Record<string, any>) => {
  if (!appState) return {}
  const { collaborators, ...rest } = appState
  return rest
}
