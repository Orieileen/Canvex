import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Film, Folder, Images, Loader2, Play } from "lucide-react";

import type { TFunction } from "i18next";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SmartImage } from "@/components/SmartImage";
import { canvasService } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import { absoluteMediaUrl } from "@/lib/canvas-media-url";
import { cn } from "@/lib/utils";
import type {
  CanvasMediaFolder,
  CanvasMediaImage,
  CanvasMediaVideo,
} from "@/types/canvex";

/**
 * 素材库面板 —— 跨「全部画布」浏览已生成的素材, 按画布分文件夹, 点一张插入「当前画布」。
 *
 * 两级导航 + 文件夹内分页:
 *   1. 文件夹网格: GET /media-library/folders/ 一次拉全 (画布数量级小), 每个文件夹带
 *      *精确* 计数 + 封面。
 *   2. 进文件夹: 按需 lazy-load 该画布的 Images / Videos, 每类独立 offset 流 + "Load
 *      more"。大文件夹可完整浏览, 计数始终用后端精确值 (不靠已加载数组长度)。
 *
 * 入口在侧栏 (发 window 事件), 面板挂在 CanvasArea —— 那里才有 pinImage/pinVideo +
 * 当前 sceneId。插入后保持打开 (方便连续挑多张)。
 */

const imgKey = (i: CanvasMediaImage) => i.asset_id;
const vidKey = (v: CanvasMediaVideo) => v.job_id;

/** 某一类型 (images/videos) 在「当前打开的文件夹」里的加载状态。
 *  nextOffset 是下一次请求的 offset (= 已请求的服务端条数, 跟随服务端分页, 不受
 *  前端去重影响); items 是去重后用于展示的数组。 */
interface KindState<T> {
  items: T[];
  nextOffset: number;
  hasMore: boolean;
  loading: boolean;
}

function freshKind<T>(): KindState<T> {
  return { items: [], nextOffset: 0, hasMore: false, loading: false };
}

function appendDedupe<T>(prev: T[], incoming: T[], keyOf: (i: T) => string): T[] {
  const seen = new Set(prev.map(keyOf));
  return [...prev, ...incoming.filter((i) => !seen.has(keyOf(i)))];
}

/** 拉一页并并入 state。offset=0 替换, >0 追加 (按 key 去重吸收并发生成造成的漂移)。
 *
 * `seq` + `seqRef`: 防「快速切文件夹」竞态 —— 进 A 的请求未回时又进 B, A 回来后
 * 若直接写会把 A 的图灌进当前已是 B 的 state (表头 B / 图是 A) 且污染 offset。
 * 切文件夹 / 返回时 seqRef 自增, 过期请求的结果直接丢弃。
 * `onPageZeroError`: 仅 offset=0 (进文件夹首屏) 失败时调 —— 比如该画布在拉列表后
 * 被删了 (items 接口 404), 用它退回文件夹网格而不是把用户晾在空抽屉里。 */
async function loadKindPage<T>(
  sceneId: string,
  kind: "images" | "videos",
  offset: number,
  keyOf: (i: T) => string,
  setState: React.Dispatch<React.SetStateAction<KindState<T>>>,
  seq: number,
  seqRef: React.MutableRefObject<number>,
  loadErrorMessage: string,
  onPageZeroError?: () => void,
) {
  setState((s) => ({ ...s, loading: true }));
  try {
    const { data } = await canvasService.getMediaFolderItems(sceneId, kind, offset);
    if (seqRef.current !== seq) return; // 用户已切走 → 丢弃过期结果
    const incoming = data.items as T[];
    setState((s) => ({
      items: offset === 0 ? incoming : appendDedupe(s.items, incoming, keyOf),
      nextOffset: offset + incoming.length,
      hasMore: data.has_more,
      loading: false,
    }));
  } catch (err) {
    if (seqRef.current !== seq) return; // 过期 → 静默丢弃
    setState((s) => ({ ...s, loading: false }));
    toast.error(extractApiError(err, loadErrorMessage));
    if (offset === 0) onPageZeroError?.();
  }
}

interface MediaLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 把一张图片插入当前画布 (CanvasArea 里走 pinImage)。 */
  onInsertImage: (item: CanvasMediaImage) => Promise<void>;
  /** 把一个视频插入当前画布 (CanvasArea 里走 pinVideo)。 */
  onInsertVideo: (item: CanvasMediaVideo) => void;
}

export function MediaLibrary({
  open,
  onOpenChange,
  onInsertImage,
  onInsertVideo,
}: MediaLibraryProps) {
  const { t } = useTranslation("canvasUi");
  const [folders, setFolders] = useState<CanvasMediaFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [imageState, setImageState] = useState<KindState<CanvasMediaImage>>(freshKind);
  const [videoState, setVideoState] = useState<KindState<CanvasMediaVideo>>(freshKind);
  // 进/出文件夹时自增, 让在途的 item 请求作废 (见 loadKindPage 的 seq 守卫)。
  const reqSeqRef = useRef(0);

  const loadFolders = useCallback(async (isCancelled?: () => boolean) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const { data } = await canvasService.getMediaFolders();
      if (!isCancelled?.()) setFolders(data.folders);
    } catch (err) {
      if (!isCancelled?.()) {
        setFoldersError(
          extractApiError(err, t("media.errors.loadLibrary")),
        );
      }
    } finally {
      if (!isCancelled?.()) setFoldersLoading(false);
    }
  }, [t]);

  // 每次打开重新拉文件夹列表 (生成持续进行, 缓存会过期), 并回到列表层。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOpenFolderId(null);
    void loadFolders(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open, loadFolders]);

  // openFolderId 可能因刷新而失效 (文件夹没了) → 退回列表。
  const openFolder = openFolderId
    ? folders.find((f) => f.scene_id === openFolderId) ?? null
    : null;

  // 返回文件夹网格: 自增 seq 让在途请求作废, 免得回到列表后还被旧结果写脏。
  const goBack = useCallback(() => {
    reqSeqRef.current += 1;
    setOpenFolderId(null);
  }, []);

  // 进文件夹首屏 (offset=0) 失败 —— 多半是该画布在拉列表后被删了 (items 404)。
  // 退回网格 + 重拉列表把这个失效文件夹剔掉, 而不是把用户晾在空抽屉。
  const onItemsPageZeroError = useCallback(() => {
    reqSeqRef.current += 1;
    setOpenFolderId(null);
    void loadFolders();
  }, [loadFolders]);

  const drillIn = useCallback(
    (folder: CanvasMediaFolder) => {
      reqSeqRef.current += 1;
      const seq = reqSeqRef.current;
      setOpenFolderId(folder.scene_id);
      setImageState(freshKind);
      setVideoState(freshKind);
      if (folder.image_count > 0) {
        void loadKindPage(folder.scene_id, "images", 0, imgKey, setImageState, seq, reqSeqRef, t("media.errors.loadMedia"), onItemsPageZeroError);
      }
      if (folder.video_count > 0) {
        void loadKindPage(folder.scene_id, "videos", 0, vidKey, setVideoState, seq, reqSeqRef, t("media.errors.loadMedia"), onItemsPageZeroError);
      }
    },
    [onItemsPageZeroError, t],
  );

  const loadMoreImages = useCallback(() => {
    if (openFolderId) {
      void loadKindPage(openFolderId, "images", imageState.nextOffset, imgKey, setImageState, reqSeqRef.current, reqSeqRef, t("media.errors.loadMedia"));
    }
  }, [openFolderId, imageState.nextOffset, t]);

  const loadMoreVideos = useCallback(() => {
    if (openFolderId) {
      void loadKindPage(openFolderId, "videos", videoState.nextOffset, vidKey, setVideoState, reqSeqRef.current, reqSeqRef, t("media.errors.loadMedia"));
    }
  }, [openFolderId, videoState.nextOffset, t]);

  const handleImage = useCallback(
    async (item: CanvasMediaImage) => {
      try {
        await onInsertImage(item);
        toast.success(t("media.toasts.imageInserted"));
      } catch (err) {
        toast.error(extractApiError(err, t("media.errors.insertMedia")));
      }
    },
    [onInsertImage, t],
  );

  const handleVideo = useCallback(
    (item: CanvasMediaVideo) => {
      try {
        onInsertVideo(item);
        toast.success(t("media.toasts.videoInserted"));
      } catch (err) {
        toast.error(extractApiError(err, t("media.errors.insertMedia")));
      }
    },
    [onInsertVideo, t],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 bg-dune p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          {openFolder ? (
            <>
              <button
                type="button"
                onClick={goBack}
                className="-ml-1 mb-0.5 flex w-fit items-center gap-1 text-xs font-medium text-sienna transition-colors hover:text-ember"
              >
                <ArrowLeft className="size-3.5" />
                {t("media.allCanvases")}
              </button>
              <SheetTitle className="flex items-center gap-1.5 text-foreground">
                <Folder className="size-4 shrink-0 text-sienna" />
                {openFolder.scene_title || t("media.untitled")}
              </SheetTitle>
              <SheetDescription>
                {folderCountLabel(t, openFolder.image_count, openFolder.video_count)}
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="text-foreground">{t("media.title")}</SheetTitle>
              <SheetDescription>
                {t("media.subtitle")}
              </SheetDescription>
            </>
          )}
        </SheetHeader>

        {foldersLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("media.loading")}
          </div>
        ) : foldersError ? (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-destructive">
            {foldersError}
          </div>
        ) : folders.length === 0 ? (
          <EmptyState icon={<Images className="size-8" />} label={t("media.empty")} />
        ) : openFolder ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {openFolder.image_count > 0 && (
              <div className="mb-5">
                <MediaSection
                  icon={<Images className="size-3.5" />}
                  label={t("media.sections.images")}
                  loadMoreLabel={t("media.loadMore.images")}
                  state={imageState}
                  onLoadMore={loadMoreImages}
                  renderItem={(img) => (
                    <ThumbButton
                      key={img.asset_id}
                      src={absoluteMediaUrl(img.url)}
                      alt={t("media.alt.image")}
                      title={t("media.insertIntoCanvas")}
                      onClick={() => void handleImage(img)}
                    />
                  )}
                />
              </div>
            )}
            {openFolder.video_count > 0 && (
              <MediaSection
                icon={<Film className="size-3.5" />}
                label={t("media.sections.videos")}
                loadMoreLabel={t("media.loadMore.videos")}
                state={videoState}
                onLoadMore={loadMoreVideos}
                renderItem={(vid) => (
                  <ThumbButton
                    key={vid.job_id}
                    src={vid.thumbnail_url ? absoluteMediaUrl(vid.thumbnail_url) : ""}
                    alt={t("media.alt.video")}
                    title={t("media.insertIntoCanvas")}
                    onClick={() => handleVideo(vid)}
                    overlay={
                      <span className="absolute bottom-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
                        <Play className="size-3 fill-current" />
                      </span>
                    }
                    placeholder={<Film className="size-7 text-muted-foreground/40" />}
                  />
                )}
              />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              {folders.map((f) => (
                <FolderCard
                  key={f.scene_id}
                  title={f.scene_title || t("media.untitled")}
                  count={folderCountLabel(t, f.image_count, f.video_count)}
                  cover={absoluteMediaUrl(f.cover_url)}
                  onClick={() => drillIn(f)}
                />
              ))}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function folderCountLabel(t: TFunction, imageCount: number, videoCount: number): string {
  const parts: string[] = [];
  if (imageCount > 0) parts.push(t("media.count.images", { count: imageCount }));
  if (videoCount > 0) parts.push(t("media.count.videos", { count: videoCount }));
  return parts.join(" · ");
}

/** One kind's section inside an open folder: label, item grid, and a "Load more"
 *  that appends the next page. Page-0 load shows a spinner in place of the grid. */
function MediaSection<T>({
  icon,
  label,
  loadMoreLabel,
  state,
  renderItem,
  onLoadMore,
}: {
  icon: React.ReactNode;
  label: string;
  loadMoreLabel: string;
  state: KindState<T>;
  renderItem: (item: T) => React.ReactNode;
  onLoadMore: () => void;
}) {
  return (
    <>
      <SectionLabel icon={icon}>{label}</SectionLabel>
      {state.items.length === 0 && state.loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">{state.items.map(renderItem)}</div>
          {state.hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={state.loading}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card py-2 text-xs font-medium text-sienna transition-colors hover:bg-card/70 disabled:opacity-50"
            >
              {state.loading && <Loader2 className="size-3.5 animate-spin" />}
              {loadMoreLabel}
            </button>
          )}
        </>
      )}
    </>
  );
}

function FolderCard({
  title,
  count,
  cover,
  onClick,
}: {
  title: string;
  count: string;
  cover: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "group relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-card text-left",
        "transition-shadow hover:ring-2 hover:ring-ember focus-visible:ring-2 focus-visible:ring-ember focus-visible:outline-none",
      )}
    >
      <SmartImage
        src={cover}
        alt={title}
        containerClassName="relative size-full"
        className="size-full object-cover"
        placeholder={<Folder className="size-8 text-muted-foreground/40" />}
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6">
        <div className="flex items-center gap-1.5 text-white">
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <p className="truncate text-[11px] text-white/70">{count}</p>
      </div>
    </button>
  );
}

function ThumbButton({
  src,
  alt,
  title,
  onClick,
  overlay,
  placeholder,
}: {
  src: string;
  alt: string;
  title: string;
  onClick: () => void;
  overlay?: React.ReactNode;
  placeholder?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "group relative aspect-square overflow-hidden rounded-lg border border-border bg-card",
        "transition-shadow hover:ring-2 hover:ring-ember focus-visible:ring-2 focus-visible:ring-ember focus-visible:outline-none",
      )}
    >
      <SmartImage
        src={src}
        alt={alt}
        containerClassName="relative size-full"
        className="size-full object-cover"
        placeholder={placeholder}
      />
      {overlay}
    </button>
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-sienna">
      {icon}
      {children}
    </div>
  );
}

function EmptyState({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground/60">
      {icon}
      <p className="text-sm">{label}</p>
    </div>
  );
}
