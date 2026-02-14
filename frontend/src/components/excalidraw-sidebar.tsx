import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { IconDotsVertical, IconLoader, IconPencil, IconPlus, IconCopy, IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'

import { request } from '@/utils/request'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RingIcon } from '@/components/ui/icons/svg-spinners-270-ring'

interface SceneRecord {
  id: string
  title?: string
  updated_at?: string
  data?: any
}

export function ExcalidrawSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation('excalidraw')
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const activeId = searchParams.get('scene')
  const [scenes, setScenes] = useState<SceneRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const editInputRef = useRef<HTMLInputElement | null>(null)
  const renameBusyRef = useRef(false)
  const skipBlurCommitRef = useRef(false)

  const loadScenes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await request.get('/api/v1/excalidraw/scenes/')
      const list: SceneRecord[] = Array.isArray(res.data?.results)
        ? res.data.results
        : Array.isArray(res.data)
          ? res.data
          : []
      setScenes(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadScenes()
    const handler = () => loadScenes()
    window.addEventListener('excalidraw:scenes-changed', handler)
    return () => window.removeEventListener('excalidraw:scenes-changed', handler)
  }, [loadScenes])

  useEffect(() => {
    if (!editingId) return
    if (editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const handleNew = async () => {
    const res = await request.post('/api/v1/excalidraw/scenes/', {
      title: t('untitled', { defaultValue: 'Untitled' }),
      data: {},
    })
    const id = res?.data?.id ? String(res.data.id) : null
    if (id) {
      setScenes(prev => [res.data, ...prev])
      navigate(`/?scene=${id}`)
    }
  }

  const dispatchScenesChanged = () => {
    window.dispatchEvent(new CustomEvent('excalidraw:scenes-changed'))
  }

  const handleDuplicate = async (scene: SceneRecord) => {
    try {
      const src = await request.get(`/api/v1/excalidraw/scenes/${scene.id}/`)
      const data = src.data?.data || {}
      const sourceTitle = src.data?.title || scene.title || t('untitled', { defaultValue: 'Untitled' })
      const copyTitle = t('copyOf', { defaultValue: 'Copy of {{title}}', title: sourceTitle })
      const res = await request.post('/api/v1/excalidraw/scenes/', { title: copyTitle, data })
      const id = res?.data?.id ? String(res.data.id) : null
      if (id) {
        setScenes(prev => [res.data, ...prev])
        dispatchScenesChanged()
        navigate(`/?scene=${id}`)
      }
    } catch {
      // ignore; page handles toast
    }
  }

  const startRename = (scene: SceneRecord) => {
    setEditingId(scene.id)
    setEditingValue(scene.title || t('untitled', { defaultValue: 'Untitled' }))
  }

  const cancelRename = () => {
    setEditingId(null)
    setEditingValue('')
    renameBusyRef.current = false
  }

  const commitRename = async (scene: SceneRecord, nextValue?: string) => {
    if (renameBusyRef.current) return
    const raw = (typeof nextValue === 'string' ? nextValue : editingValue).trim()
    const title = raw || t('untitled', { defaultValue: 'Untitled' })
    const currentTitle = scene.title || t('untitled', { defaultValue: 'Untitled' })
    if (title === currentTitle) {
      cancelRename()
      return
    }
    renameBusyRef.current = true
    try {
      await request.patch(`/api/v1/excalidraw/scenes/${scene.id}/`, { title })
      setScenes(prev => prev.map(item => (item.id === scene.id ? { ...item, title } : item)))
      dispatchScenesChanged()
      cancelRename()
    } catch {
      renameBusyRef.current = false
      toast.error(t('saveFailed', { defaultValue: 'Save failed' }))
    }
  }

  const handleDelete = async (scene: SceneRecord) => {
    if (!window.confirm(t('confirmDelete', { defaultValue: 'Delete this scene?' }))) return
    try {
      await request.delete(`/api/v1/excalidraw/scenes/${scene.id}/`)
      const remaining = scenes.filter(item => item.id !== scene.id)
      setScenes(remaining)
      dispatchScenesChanged()
      if (editingId === scene.id) {
        cancelRename()
      }
      if (scene.id === activeId) {
        const next = remaining[0]
        if (next) {
          navigate(`/?scene=${next.id}`)
        } else {
          navigate('/')
        }
      }
    } catch {
      // ignore; page handles toast
    }
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
              <Link to="/">
                <RingIcon className="!size-5" />
                <span className="text-base font-semibold">Canvex</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('scenesTitle', { defaultValue: 'Scenes' })}</SidebarGroupLabel>
          <div className="px-2 pb-2">
            <Button variant="outline" size="sm" className="w-full" onClick={handleNew}>
              <IconPlus className="mr-1 size-4" />
              {t('newScene', { defaultValue: 'New' })}
            </Button>
          </div>
          <SidebarMenu>
            {loading ? (
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <IconLoader className="size-4 animate-spin" />
                  <span>{t('loading', { defaultValue: 'Loading…' })}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : scenes.length === 0 ? (
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <span>{t('empty', { defaultValue: 'No scenes yet' })}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : (
              scenes.map(scene => (
                <SidebarMenuItem key={scene.id}>
                  <div className="flex items-center gap-1">
                    {editingId === scene.id ? (
                      <div className="flex flex-1 items-center">
                        <Input
                          ref={(node) => {
                            if (editingId === scene.id) {
                              editInputRef.current = node
                            }
                          }}
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              e.currentTarget.blur()
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              skipBlurCommitRef.current = true
                              cancelRename()
                            }
                          }}
                          onBlur={() => {
                            if (skipBlurCommitRef.current) {
                              skipBlurCommitRef.current = false
                              return
                            }
                            void commitRename(scene, editingValue)
                          }}
                          placeholder={t('namePlaceholder', { defaultValue: 'Scene name' })}
                          className="h-8"
                        />
                      </div>
                    ) : (
                      <SidebarMenuButton
                        asChild
                        isActive={activeId ? activeId === scene.id : false}
                        tooltip={scene.title || t('untitled', { defaultValue: 'Untitled' })}
                        className="flex-1"
                      >
                        <Link to={`/?scene=${scene.id}`}>
                          <span>{scene.title || t('untitled', { defaultValue: 'Untitled' })}</span>
                        </Link>
                      </SidebarMenuButton>
                    )}
                    {editingId !== scene.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md hover:bg-muted"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                            }}
                            aria-label={t('sceneActions', { defaultValue: 'Scene actions' })}
                          >
                            <IconDotsVertical className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => startRename(scene)}>
                            <IconPencil className="size-4" />
                            {t('rename', { defaultValue: 'Rename' })}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDuplicate(scene)}>
                            <IconCopy className="size-4" />
                            {t('duplicate', { defaultValue: 'Duplicate' })}
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => handleDelete(scene)}>
                            <IconTrash className="size-4" />
                            {t('delete', { defaultValue: 'Delete' })}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-2 py-2 text-xs text-muted-foreground">Workspace: Public</div>
      </SidebarFooter>
    </Sidebar>
  )
}
