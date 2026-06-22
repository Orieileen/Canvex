import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Frame,
  Github,
  Images,
  Loader2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
  Twitter,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { cn } from "@/lib/utils";
import type { CanvasSceneListItem } from "@/types/canvex";

/** 全局事件: Workspace 重命名当前 scene 后 dispatch, 让侧栏同步列表文案。 */
export const CANVAS_SCENE_RENAMED_EVENT = "canvas:scene-renamed";
export interface CanvasSceneRenamedDetail {
  id: string;
  title: string;
}

/** 全局事件: 侧栏「素材库」按钮 dispatch, 由 CanvasArea 监听打开面板 (那里才有
 *  pinImage + 当前 sceneId)。侧栏在外层组件、面板在内层, 用 window 事件跨过去
 *  (跟 CANVAS_SCENE_RENAMED_EVENT 同款桥接, 只是方向反过来)。 */
export const CANVAS_OPEN_MEDIA_LIBRARY_EVENT = "canvas:open-media-library";

// 作者社交链接 (用户提供)。展开=底部一排图标, 折叠=纵向堆叠。
const SOCIAL_LINKS: { href: string; label: string; Icon: typeof Github }[] = [
  { href: "https://x.com/real_meired", label: "Twitter", Icon: Twitter },
  { href: "https://github.com/Orieileen/Canvex", label: "GitHub", Icon: Github },
];

// 侧栏折叠态持久化 (localStorage), 跨刷新/重开浏览器保留用户选择。
// 取值 "1" = 折叠, 其他 (含缺失) = 展开。
const SIDEBAR_COLLAPSED_KEY = "canvex:canvas-sidebar-collapsed";

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    // localStorage 在隐私模式下可能抛 SecurityError, 退回默认展开。
    return false;
  }
}

interface CanvasSidebarProps {
  /** Currently open scene id (workspace component state — drives active styling). */
  activeSceneId: string | null;
  /** Select an existing scene → workspace switches to it (component state, no route). */
  onSelectScene: (id: string) => void;
  /** A new scene was created via the sidebar — workspace opens it. */
  onSceneCreated?: (id: string) => void;
  /** The active scene was deleted — workspace clears / picks another. */
  onSceneDeleted?: (id: string) => void;
}

export function CanvasSidebar({
  activeSceneId,
  onSelectScene,
  onSceneCreated,
  onSceneDeleted,
}: CanvasSidebarProps) {
  const [scenes, setScenes] = useState<CanvasSceneListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  // 新建画布对话框: 让用户填名称, 留空用默认 "Untitled canvas"。
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  // Escape sets this to true so the ensuing onBlur doesn't commit. ref (not state)
  // because the blur fires synchronously during Input unmount before any re-render.
  const cancelRenameRef = useRef(false);

  const [deleteTarget, setDeleteTarget] = useState<CanvasSceneListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 隐私模式下 setItem 失败 —— UI 仍切换, 只是不持久化。
      }
      return next;
    });
  }, []);

  const loadScenes = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await canvasService.listScenes();
      setScenes(data);
    } catch (err) {
      toast.error(extractApiError(err, "Failed to load canvases"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadScenes();
  }, [loadScenes]);

  // 无激活 scene 但已有 scene 时(首次加载完 / 当前 scene 被删后归 null)自动选第
  // 一个,避免在有 scene 的情况下空停在 EmptyState。配合 workspace 的
  // onSceneDeleted→setActiveSceneId(null):删当前 scene 后这里顺势挑下一个。
  useEffect(() => {
    if (!activeSceneId && scenes.length > 0) {
      onSelectScene(scenes[0].id);
    }
  }, [activeSceneId, scenes, onSelectScene]);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<CanvasSceneRenamedDetail>).detail;
      if (!detail) return;
      setScenes((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (s.id !== detail.id || s.title === detail.title) return s;
          changed = true;
          return { ...s, title: detail.title };
        });
        return changed ? next : prev;
      });
    }
    window.addEventListener(CANVAS_SCENE_RENAMED_EVENT, handler);
    return () => window.removeEventListener(CANVAS_SCENE_RENAMED_EVENT, handler);
  }, []);

  // 折叠/展开两个「新建画布」入口共用: 清空输入并打开命名对话框。
  const openCreate = useCallback(() => {
    setCreateName("");
    setCreateOpen(true);
  }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      // 留空则用默认名称 (后端 title 允许 blank, 这里前端兜个友好默认)。
      const title = createName.trim() || "Untitled canvas";
      const { data } = await canvasService.createScene({ title, data: {} });
      setScenes((prev) => [
        {
          id: data.id,
          title: data.title,
          created_at: data.created_at,
          updated_at: data.updated_at,
        },
        ...prev,
      ]);
      setCreateOpen(false);
      onSceneCreated?.(data.id);
    } catch (err) {
      toast.error(extractApiError(err, "Failed to create canvas"));
    } finally {
      setCreating(false);
    }
  }

  function startRename(scene: CanvasSceneListItem) {
    setEditingId(scene.id);
    setEditingValue(scene.title || "");
  }

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  async function commitRename(scene: CanvasSceneListItem, nextTitle: string) {
    const trimmed = nextTitle.trim();
    setEditingId(null);
    if (!trimmed || trimmed === scene.title) return;
    try {
      await canvasService.updateScene(scene.id, { title: trimmed });
      setScenes((prev) =>
        prev.map((s) => (s.id === scene.id ? { ...s, title: trimmed } : s)),
      );
    } catch (err) {
      toast.error(extractApiError(err, "Failed to rename canvas"));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await canvasService.removeScene(deleteTarget.id);
      setScenes((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      if (deleteTarget.id === activeSceneId) {
        onSceneDeleted?.(deleteTarget.id);
      }
      toast.success("Canvas deleted");
    } catch (err) {
      toast.error(extractApiError(err, "Failed to delete canvas"));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const deleteSceneTitle = deleteTarget?.title || "Untitled canvas";

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "shrink-0 py-8 flex flex-col h-screen sticky top-0 bg-stone-50 overflow-hidden overscroll-contain transition-[width] duration-200 ease-out",
        collapsed ? "w-16 px-2" : "w-[230px] px-5",
      )}
    >
      {/* 顶部: 展开时 [新建 / 收起] 同排; 折叠时纵向堆叠 [展开 / 新建] */}
      {collapsed ? (
        <div className="mb-1.5 flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex size-9 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="size-4" strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:opacity-90"
            aria-label="New canvas"
            title="New canvas"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1 justify-center gap-2"
            onClick={openCreate}
          >
            <Plus className="size-3.5" />
            New canvas
          </Button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* 「素材库」入口 (紧贴 New canvas 下方): 发全局事件, CanvasArea 接住打开面板。
          无激活画布时禁用 —— 面板挂在 CanvasArea(只在有激活画布时挂载), 点了也没人
          接事件、且无目标画布可插入。 */}
      <div className={collapsed ? "mb-3" : "mb-5"}>
        {collapsed ? (
          <button
            type="button"
            disabled={!activeSceneId}
            onClick={() => window.dispatchEvent(new CustomEvent(CANVAS_OPEN_MEDIA_LIBRARY_EVENT))}
            className="mx-auto flex size-9 items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-stone-200 hover:text-stone-900 disabled:pointer-events-none disabled:opacity-40"
            aria-label="Media library"
            title={activeSceneId ? "Media library" : "Select a canvas first"}
          >
            <Images className="size-4" strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            disabled={!activeSceneId}
            onClick={() => window.dispatchEvent(new CustomEvent(CANVAS_OPEN_MEDIA_LIBRARY_EVENT))}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-stone-700 transition-colors hover:bg-stone-200 disabled:pointer-events-none disabled:opacity-40"
            title={activeSceneId ? undefined : "Select a canvas first"}
          >
            <Images className="size-4 shrink-0" strokeWidth={2} />
            Media library
          </button>
        )}
      </div>

      {/* SCENES 标题: 折叠态隐藏 (只剩图标条没有空间承载文字 label) */}
      {!collapsed && (
        <div className="mb-2">
          <h3 className="text-[10px] font-bold tracking-[0.08em] text-stone-400">
            SCENES
          </h3>
        </div>
      )}

      <nav
        className={cn(
          "flex-1 overflow-y-auto overscroll-contain",
          collapsed ? "" : "-mx-1 pr-1",
        )}
      >
        {loading ? (
          <div
            className={cn(
              "flex items-center gap-2 text-xs text-stone-400",
              collapsed ? "justify-center py-2" : "px-2 py-2",
            )}
          >
            <Loader2 className="size-3 animate-spin" />
            {!collapsed && "Loading…"}
          </div>
        ) : scenes.length === 0 ? (
          !collapsed && (
            <p className="px-2 py-2 text-xs text-stone-400">
              No canvases yet. Start with "New canvas".
            </p>
          )
        ) : (
          <ul
            className={cn(
              "flex flex-col",
              collapsed ? "items-center gap-1" : "gap-0.5",
            )}
          >
            {scenes.map((scene) => {
              const isActive = scene.id === activeSceneId;
              const isEditing = editingId === scene.id;

              // 折叠态: 每条 scene 退化成 Frame 图标按钮 + title tooltip。
              // 重命名/删除 等需要文字承载的操作不在此态暴露 (展开后可用)。
              if (collapsed) {
                return (
                  <li key={scene.id}>
                    <button
                      type="button"
                      onClick={() => onSelectScene(scene.id)}
                      title={scene.title || "Untitled canvas"}
                      aria-label={scene.title || "Untitled canvas"}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex size-9 items-center justify-center rounded-md transition-colors",
                        isActive
                          ? "bg-primary/10 text-stone-900"
                          : "text-stone-500 hover:bg-stone-200 hover:text-stone-700",
                      )}
                    >
                      <Frame className="size-4" strokeWidth={2} />
                    </button>
                  </li>
                );
              }

              return (
                <li key={scene.id} className="group flex items-center gap-0.5">
                  {isEditing ? (
                    <Input
                      ref={editInputRef}
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRenameRef.current = true;
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        if (cancelRenameRef.current) {
                          cancelRenameRef.current = false;
                          return;
                        }
                        void commitRename(scene, editingValue);
                      }}
                      className="mx-1 h-8 flex-1 px-2 text-sm"
                    />
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        "flex flex-1 items-center truncate rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-stone-900"
                          : "text-stone-700 hover:bg-stone-200",
                      )}
                      onClick={() => onSelectScene(scene.id)}
                    >
                      <span className="truncate">
                        {scene.title || "Untitled canvas"}
                      </span>
                    </button>
                  )}
                  {!isEditing && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex size-7 shrink-0 items-center justify-center rounded-md text-stone-400 opacity-0 transition-opacity hover:bg-stone-200 hover:text-stone-700 group-hover:opacity-100 data-[state=open]:opacity-100"
                          aria-label="Canvas actions"
                        >
                          <MoreVertical className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem onClick={() => startRename(scene)}>
                          <Pencil className="mr-2 size-3.5" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(scene)}
                        >
                          <Trash2 className="mr-2 size-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* 作者社交链接: 展开=一排图标, 折叠=纵向堆叠。外链新标签页打开。 */}
      <div
        className={cn(
          "mt-2 flex",
          collapsed ? "flex-col items-center gap-1" : "items-center gap-1 px-1",
        )}
      >
        {SOCIAL_LINKS.map(({ href, label, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            title={label}
            className="flex size-8 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-200 hover:text-primary"
          >
            <Icon className="size-4" strokeWidth={2} />
          </a>
        ))}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <DialogHeader>
              <DialogTitle>New canvas</DialogTitle>
              <DialogDescription>
                Give your canvas a name, or leave it blank to use the default.
              </DialogDescription>
            </DialogHeader>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Untitled canvas"
              aria-label="New canvas"
              autoFocus
              maxLength={255}
              className="my-4"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="rounded-full bg-ember px-6 text-white hover:bg-ember/90"
                disabled={creating}
              >
                {creating && <Loader2 className="size-3.5 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete canvas</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{deleteSceneTitle}"? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
