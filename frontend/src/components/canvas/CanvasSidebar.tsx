import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Frame,
  Github,
  HelpCircle,
  Images,
  Languages,
  Loader2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SlidersHorizontal,
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
import { useLanguageToggle } from "@/hooks/use-language";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { cn } from "@/lib/utils";
import type { CanvasSceneListItem } from "@/types/canvex";
import { HelpDialog } from "./HelpDialog";
import { RingIcon } from "@/components/ui/icons/svg-spinners-270-ring";

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
// `id` 是稳定的逻辑键 (React key + 翻译键), `label` 是可翻译的展示文案。
const SOCIAL_LINKS: { id: string; href: string; label: string; Icon: typeof Github }[] = [
  { id: "twitter", href: "https://x.com/real_meired", label: "Twitter", Icon: Twitter },
  { id: "github", href: "https://github.com/Orieileen/Canvex", label: "GitHub", Icon: Github },
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

// 置顶场景 id 列表持久化 (按浏览器存, 不跨设备)。
const SIDEBAR_PINNED_KEY = "canvex:canvas-pinned-scenes";

// 侧栏分组标题 (PINNED / SCENES) 共用样式。
const SIDEBAR_SECTION_LABEL =
  "mb-1.5 px-2.5 text-xs font-semibold text-stone-500";

/** 侧栏底部那几个固定入口 (生图设置 / 语言 / 帮助) 共用的一行。
 *
 *  抽出来是因为三份是逐字相同的: 加第三个入口时为了插进去, 连带把另外两份的 `mt-2`
 *  改成 `mt-1` —— 它们本来就是绑在一起动的。再抄一份, 或者改一次样式, 必然漏一个。 */
function FooterButton({
  collapsed,
  first,
  label,
  title,
  onClick,
  icon,
  collapsedContent,
}: {
  collapsed: boolean;
  /** 底部这一组的第一个 —— 跟上面的 nav 之间要多一点间距。 */
  first?: boolean;
  label: string;
  /** 悬停提示。省略即用 label (语言那个例外: 按钮上写的是目标语言, 提示要说"切换语言")。 */
  title?: string;
  onClick: () => void;
  icon: React.ReactNode;
  /** 折叠态改显别的东西 (语言用两个字, 没有合适图标)。省略即用 icon。 */
  collapsedContent?: React.ReactNode;
}) {
  const gap = first ? "mt-2" : "mt-1";
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          gap,
          "mx-auto flex size-9 items-center justify-center rounded-md text-stone-500",
          "transition-colors hover:bg-stone-100 hover:text-stone-700",
        )}
        aria-label={title ?? label}
        title={title ?? label}
      >
        {collapsedContent ?? icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        gap,
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
        "font-medium text-stone-700 transition-colors hover:bg-stone-100",
      )}
      title={title}
    >
      {icon}
      {label}
    </button>
  );
}

function loadPinned(): string[] {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_PINNED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
  /** 打开生图供应商配置面板。直接回调而不是像素材库那样发 window 事件 —— 那个面板挂在
   *  CanvasArea 里(隔着一层 key), 这个跟侧栏同属 CanvexWorkspacePage 的直接子节点。 */
  onOpenImageSettings: () => void;
}

export function CanvasSidebar({
  activeSceneId,
  onSelectScene,
  onSceneCreated,
  onSceneDeleted,
  onOpenImageSettings,
}: CanvasSidebarProps) {
  const { t } = useTranslation("canvasUi");
  const { lang, toggle: toggleLanguage } = useLanguageToggle();
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
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinned);
  const [helpOpen, setHelpOpen] = useState(false);

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

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      try {
        window.localStorage.setItem(SIDEBAR_PINNED_KEY, JSON.stringify(next));
      } catch {
        // 隐私模式下持久化失败 —— UI 仍切换。
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
      toast.error(extractApiError(err, t("sidebar.toast.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadScenes();
  }, [loadScenes]);

  // 无激活 scene 但已有 scene 时(首次加载完 / 当前 scene 被删后归 null)自动选第
  // 一个,避免在有 scene 的情况下空停在 EmptyState。配合 workspace 的
  // onSceneDeleted→setActiveSceneId(null):删当前 scene 后这里顺势挑下一个。
  useEffect(() => {
    if (!activeSceneId && scenes.length > 0) {
      // 选"视觉最上面"那个 (置顶组排最前), 跟 UI 顺序一致, 而非 raw scenes[0]。
      const first = scenes.find((s) => pinnedIds.includes(s.id)) ?? scenes[0];
      onSelectScene(first.id);
    }
  }, [activeSceneId, scenes, pinnedIds, onSelectScene]);

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
      toast.error(extractApiError(err, t("sidebar.toast.createFailed")));
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
      toast.error(extractApiError(err, t("sidebar.toast.renameFailed")));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await canvasService.removeScene(deleteTarget.id);
      setScenes((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      // 同步把被删 scene 从置顶集剔除, 否则其 id 永久残留在 localStorage。
      if (pinnedIds.includes(deleteTarget.id)) {
        togglePin(deleteTarget.id);
      }
      if (deleteTarget.id === activeSceneId) {
        onSceneDeleted?.(deleteTarget.id);
      }
      toast.success(t("sidebar.toast.deleted"));
    } catch (err) {
      toast.error(extractApiError(err, t("sidebar.toast.deleteFailed")));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const deleteSceneTitle = deleteTarget?.title || t("sidebar.untitled");

  // 置顶分组 (localStorage 持久化): 置顶场景排在最上方独立模块, 其余在 SCENES 下。
  // 用 Set 做 O(1) 成员判断, 单次遍历切两组 (都保留 scenes 原序)。
  const pinnedSet = new Set(pinnedIds);
  const pinnedScenes: CanvasSceneListItem[] = [];
  const unpinnedScenes: CanvasSceneListItem[] = [];
  for (const s of scenes) {
    (pinnedSet.has(s.id) ? pinnedScenes : unpinnedScenes).push(s);
  }

  // 单条 scene 行 (折叠 = 图标; 展开 = 名称 + ⋮ 菜单)。抽成函数以便置顶组 / 普通
  // 组复用同一渲染, 不重复 JSX。
  const renderSceneRow = (scene: CanvasSceneListItem) => {
    const isActive = scene.id === activeSceneId;
    const isEditing = editingId === scene.id;
    const isPinned = pinnedSet.has(scene.id);

    if (collapsed) {
      return (
        <li key={scene.id}>
          <button
            type="button"
            onClick={() => onSelectScene(scene.id)}
            title={scene.title || t("sidebar.untitled")}
            aria-label={scene.title || t("sidebar.untitled")}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex size-9 items-center justify-center rounded-md transition-colors",
              isActive
                ? "bg-stone-200 text-stone-900"
                : "text-stone-500 hover:bg-stone-100 hover:text-stone-700",
            )}
          >
            <Frame className="size-4" strokeWidth={2} />
          </button>
        </li>
      );
    }

    return (
      <li
        key={scene.id}
        className={cn(
          // 整行作为一个块: 选中/hover 的底色加在 li 上, 让名称按钮和 ⋮ 合为一体。
          "group flex items-center gap-0.5 rounded-md pr-1 transition-colors",
          !isEditing && (isActive ? "bg-stone-200" : "hover:bg-stone-100"),
        )}
      >
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
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex flex-1 items-center truncate px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
              isActive ? "text-stone-900" : "text-stone-700",
            )}
            onClick={() => onSelectScene(scene.id)}
          >
            <span className="truncate">
              {scene.title || t("sidebar.untitled")}
            </span>
          </button>
        )}
        {!isEditing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-stone-400 opacity-0 transition-opacity hover:text-stone-700 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={t("sidebar.actions.menu")}
              >
                <MoreVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => togglePin(scene.id)}>
                {isPinned ? (
                  <>
                    <PinOff className="mr-2 size-3.5" />
                    {t("sidebar.actions.unpin")}
                  </>
                ) : (
                  <>
                    <Pin className="mr-2 size-3.5" />
                    {t("sidebar.actions.pin")}
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startRename(scene)}>
                <Pencil className="mr-2 size-3.5" />
                {t("sidebar.actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteTarget(scene)}
              >
                <Trash2 className="mr-2 size-3.5" />
                {t("sidebar.actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  // 一个带 label 的 scene 分组 (PINNED / SCENES 共用); 折叠态隐藏 label。
  const renderSceneSection = (label: string, items: CanvasSceneListItem[]) => (
    <div className={collapsed ? "mb-2" : "mb-3"}>
      {!collapsed && <h3 className={SIDEBAR_SECTION_LABEL}>{label}</h3>}
      <ul
        className={cn("flex flex-col", collapsed ? "items-center gap-1" : "gap-0.5")}
      >
        {items.map(renderSceneRow)}
      </ul>
    </div>
  );

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "shrink-0 py-8 flex flex-col h-screen sticky top-0 bg-white overflow-hidden overscroll-contain transition-[width] duration-200 ease-out",
        collapsed ? "w-16 px-2" : "w-[230px] px-5",
      )}
    >
      {/* 品牌 + 折叠按钮同排 (ChatGPT 风格): 展开 = ring+Canvex 左 / 折叠按钮右; 折叠态仅 ring 居中 */}
      <div className={cn("mb-3 flex items-center", collapsed ? "justify-center" : "justify-between px-1")}>
        <div className="flex items-center gap-2">
          <RingIcon className="shrink-0 text-stone-900" aria-hidden />
          {!collapsed && (
            <span className="text-[17px] font-semibold tracking-tight text-stone-900">Canvex</span>
          )}
        </div>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label={t("sidebar.collapseSidebar")}
            title={t("sidebar.collapseSidebar")}
          >
            <PanelLeftClose className="size-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
      {/* 新建画布: ChatGPT 风格普通行 (图标+文字, 灰底 hover); 折叠态 = 展开按钮 + 新建图标纵向堆叠 */}
      {collapsed ? (
        <div className="mb-1.5 flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex size-9 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label={t("sidebar.expandSidebar")}
            title={t("sidebar.expandSidebar")}
          >
            <PanelLeftOpen className="size-4" strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="flex size-9 items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
            aria-label={t("sidebar.newCanvas")}
            title={t("sidebar.newCanvas")}
          >
            <Plus className="size-4" strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openCreate}
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-stone-700 transition-colors hover:bg-stone-100"
        >
          <Plus className="size-4 shrink-0" strokeWidth={2} />
          {t("sidebar.newCanvas")}
        </button>
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
            className="mx-auto flex size-9 items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("sidebar.mediaLibrary")}
            title={activeSceneId ? t("sidebar.mediaLibrary") : t("sidebar.selectCanvasFirst")}
          >
            <Images className="size-4" strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            disabled={!activeSceneId}
            onClick={() => window.dispatchEvent(new CustomEvent(CANVAS_OPEN_MEDIA_LIBRARY_EVENT))}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-40"
            title={activeSceneId ? undefined : t("sidebar.selectCanvasFirst")}
          >
            <Images className="size-4 shrink-0" strokeWidth={2} />
            {t("sidebar.mediaLibrary")}
          </button>
        )}
      </div>

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
            {!collapsed && t("sidebar.loading")}
          </div>
        ) : scenes.length === 0 ? (
          !collapsed && (
            <p className="px-2 py-2 text-xs text-stone-400">
              {t("sidebar.empty")}
            </p>
          )
        ) : (
          <>
            {pinnedScenes.length > 0 &&
              renderSceneSection(t("sidebar.sections.pinned"), pinnedScenes)}

            {/* 折叠态: 置顶组与普通组之间一条短分隔线 (无文字 label 可区分两组) */}
            {collapsed && pinnedScenes.length > 0 && unpinnedScenes.length > 0 && (
              <div className="mx-auto my-1 h-px w-5 bg-stone-200" aria-hidden />
            )}

            {unpinnedScenes.length > 0
              ? renderSceneSection(t("sidebar.sections.scenes"), unpinnedScenes)
              : !collapsed && (
                  <p className="px-2 py-1 text-xs text-stone-400">
                    {t("sidebar.allPinned")}
                  </p>
                )}
          </>
        )}
      </nav>

      {/* 底部固定入口。生图设置不依赖当前画布, 所以不像素材库那样在无激活画布时禁用。 */}
      <FooterButton
        collapsed={collapsed}
        first
        label={t("sidebar.imageSettings")}
        onClick={onOpenImageSettings}
        icon={<SlidersHorizontal className="size-4 shrink-0" strokeWidth={2} />}
      />
      {/* 中英文切换: 折叠态没有图标可用, 直接显示目标语言的两个字。 */}
      <FooterButton
        collapsed={collapsed}
        label={lang === "en" ? "中文" : "English"}
        title={t("sidebar.toggleLanguage")}
        onClick={toggleLanguage}
        icon={<Languages className="size-4 shrink-0" strokeWidth={2} />}
        collapsedContent={
          <span className="text-[11px] font-bold">{lang === "en" ? "EN" : "中"}</span>
        }
      />
      <FooterButton
        collapsed={collapsed}
        label={t("sidebar.helpTips")}
        onClick={() => setHelpOpen(true)}
        icon={<HelpCircle className="size-4 shrink-0" strokeWidth={2} />}
      />

      {/* 作者社交链接: 展开=一排图标, 折叠=纵向堆叠。外链新标签页打开。 */}
      <div
        className={cn(
          "mt-2 flex",
          collapsed ? "flex-col items-center gap-1" : "items-center gap-1 px-1",
        )}
      >
        {SOCIAL_LINKS.map(({ id, href, label, Icon }) => (
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(`sidebar.social.${id}`, label)}
            title={t(`sidebar.social.${id}`, label)}
            className="flex size-8 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <Icon className="size-4" strokeWidth={2} />
          </a>
        ))}
      </div>

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />

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
              <DialogTitle>{t("sidebar.createDialog.title")}</DialogTitle>
              <DialogDescription>
                {t("sidebar.createDialog.description")}
              </DialogDescription>
            </DialogHeader>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t("sidebar.createDialog.placeholder")}
              aria-label={t("sidebar.newCanvas")}
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
                {t("sidebar.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                className="rounded-full bg-stone-900 px-6 text-white hover:bg-stone-800"
                disabled={creating}
              >
                {creating && <Loader2 className="size-3.5 animate-spin" />}
                {t("sidebar.createDialog.create")}
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
            <AlertDialogTitle>{t("sidebar.deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sidebar.deleteDialog.description", { name: deleteSceneTitle })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("sidebar.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                t("sidebar.actions.delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
