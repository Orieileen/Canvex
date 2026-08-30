import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Aperture, Blend, Clapperboard, Contrast, Download, Frame, Hexagon, Layers, Loader2, MessageSquarePlus, RotateCcw, RotateCw, Scissors, SlidersHorizontal, SplitSquareHorizontal, Wand2, X, type LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ExcalidrawImageElement } from "@excalidraw/excalidraw/element/types";

import { captureMockupAtSize } from "@/components/canvas/Mockup3dOverlay";
import { captureAdjustAtSize, hasAdjust } from "@/components/canvas/ImageAdjustOverlay";
import { triggerBlobDownload, pickImageExt } from "@/lib/download";

import { AngleCube } from "@/components/canvas/AngleCube";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toolbarSelectClass as selectClass } from "@/lib/canvas-toolbar-styles";
import { DEFAULT_CAMERA_ANGLES, type CameraAngles } from "@/lib/angle";
import {
  ADJUST_GROUPS,
  ADJUST_MAX,
  ADJUST_MIN,
  COLOR_BANDS,
  COLOR_BAND_META,
  type AdjustGroupSpec,
  type AdjustKey,
  type BandChannel,
  type ColorBand,
  type ColorMix,
} from "@/lib/image-adjustments";
import { isAdjustNeutral, type AdjustBinding } from "@/lib/canvas-adjust";
import { forwardWheelToExcalidrawCanvas } from "@/lib/excalidraw-wheel-forward";
import type { Mockup3dBinding } from "@/lib/canvas-mockup";
import type { DepthStatus } from "@/hooks/use-mockup";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import { buildSpatialPrompt } from "@/lib/canvas-spatial-prompt";
import {
  IMAGE_EDIT_COUNTS,
  IMAGE_EDIT_RESOLUTIONS,
  IMAGE_EDIT_SIZES,
  type ImageEditCount,
  type ImageEditResolution,
  type ImageEditSize,
} from "@/hooks/use-image-edit";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  type VideoAspectRatio,
  type VideoDuration,
} from "@/hooks/use-video-edit";
import { ImageModelSelector } from "@/components/canvas/ImageModelSelector";
import type { ChannelPicker } from "@/hooks/use-channel-pickers";

/**
 * Floating "edit this selection" toolbar — canvex-style horizontal row with
 * divider-separated groups, shadcn Tabs for Image / Video / Angle / Split modes.
 *
 * ChatOverlay 走 agent (text → 决策 → tool_call); 这里走直连 LLM, 可预测低延迟.
 *
 * Selection-mode awareness (canvex-style marquee core):
 *   - **single-image**: 全部 4 tab 启用
 *   - **image-with-shapes**: Image + Split 启用. Image 走 "plan B" —— 源图保持
 *     干净原图 (不烧 shape), 箭头/文字经 `buildSpatialPrompt` 转成带坐标的区域
 *     编辑指令, 结果图不含标注; Split 仍烧 shape; Video + Angle 禁用 (需要 URL).
 *   - **multi-image**: 只 Image tab 启用 —— 后端走 `source_images[]` 多部件上传,
 *     provider 收到 `image: [url1, url2, ...]` 数组. Shapes 按 per-image overlap
 *     烧进 PNG (跨图 shape 烧进每张被它覆盖的图; 不碰任一图的 orphan 被忽略).
 *     详见 `selectionToSourceFiles`. Video/Angle/Split 一张图语义, 禁用.
 */

type TabKey = "image" | "video" | "angle" | "split" | "merge" | "mockup";

type SupportMatrix = Record<TabKey, boolean>;

const TAB_ORDER: readonly TabKey[] = ["image", "video", "angle", "split", "merge", "mockup"];

function computeSupportMatrix(selection: CanvasSelection): SupportMatrix {
  const hasTexts = selection.texts.length > 0;
  switch (selection.kind) {
    case "single-image":
      // Merge w/o overlay would just re-encode the source — gate on hasTexts.
      // Mockup 只在单图时启用 —— 一张图既要进 receiving 模式接收 design,
      // 也要展示 binding 状态; 多图/带 shape 都没有清晰的 base 语义.
      return { image: true, video: true, angle: true, split: true, merge: hasTexts, mockup: true };
    case "image-with-shapes":
      // Image uploads the clean original (arrows → spatial prompt, see
      // composePrompt). Video/Angle provider take a URL and don't carry the
      // spatial-prompt arrows, so stay disabled here for now.
      return { image: true, video: false, angle: false, split: true, merge: true, mockup: false };
    case "multi-image":
      // Provider's `image: [url, ...]` array covers Image only; Video/Angle/
      // Split have single-image semantics.
      return { image: true, video: false, angle: false, split: false, merge: true, mockup: false };
  }
}

/** First enabled tab in canonical order. Image is always enabled across all
 *  selection kinds today, so this can't fall through in practice —— the `??`
 *  only exists to make TS happy about the (unreachable) empty-matrix case. */
function firstEnabledTab(support: SupportMatrix): TabKey {
  return TAB_ORDER.find((t) => support[t]) ?? "image";
}

/** The prompt actually sent for an image edit. image-with-shapes routes arrows
 *  through `buildSpatialPrompt` (clean source + "edit region (x%, y%)" text);
 *  single-image / multi-image keep the flat "canvas texts + user input" join
 *  (no arrows to place — multi bakes its shapes per-image instead). `userText`
 *  empty → the annotation-only preview shown in the toolbar's prompt tile. */
function composePrompt(selection: CanvasSelection, userText: string): string {
  if (selection.kind === "image-with-shapes") {
    return buildSpatialPrompt(
      { image: selection.image, shapes: selection.shapes, texts: selection.texts },
      userText,
    );
  }
  const fromTexts = selection.texts.map((tx) => tx.text.trim()).filter(Boolean).join("\n");
  // Canvas text is the prefix the user's input extends — keep canvas-text-first
  // to match the legacy Image order + VideoPanel/AnglePanel (and this docstring).
  return [fromTexts, userText.trim()].filter(Boolean).join("\n");
}

interface ImageEditBarProps {
  selection: CanvasSelection;
  /** Resolved display URL for single-image selections — `sourceUrl` (chat-
   *  pinned CDN) or dataURL fallback (Merge-flattened blob). Drives the cube
   *  texture + Video canPin gate. Null for multi-image / no source. */
  imageSourceUrl: string | null;
  /** Live thumbnails of the current selection (image + shape overlays
   *  rasterized via `exportToBlob`). One URL per upload File the provider
   *  will see —— single-image / image-with-shapes → 1; multi-image → N (one
   *  per source image, ordered by scene order). Empty array while first
   *  export is pending; component shows a pulsing skeleton in that window. */
  preview: { urls: string[] };
  image: {
    isSubmitting: boolean;
    error: string | null;
    onSubmit: (params: {
      prompt?: string;
      cutout?: boolean;
      size: ImageEditSize;
      resolution: ImageEditResolution;
      n: ImageEditCount;
    }) => void;
    onDismissError: () => void;
  };
  video: {
    isSubmitting: boolean;
    error: string | null;
    onSubmit: (params: {
      prompt: string;
      duration: VideoDuration;
      aspectRatio: VideoAspectRatio;
    }) => void;
    onDismissError: () => void;
  };
  angle: {
    isSubmitting: boolean;
    error: string | null;
    onSubmit: (params: { angles: CameraAngles }) => void;
    onDismissError: () => void;
  };
  split: {
    isSubmitting: boolean;
    error: string | null;
    onSubmit: (params: { resolution: ImageEditResolution }) => void;
    onDismissError: () => void;
  };
  /** 生图通道选择器 —— 同一份画布级 state, 聊天栏那个改的也是它。
   *  只发给 Image / Split 两个面板。Video / Angle 各有自己的一份 (接口形状不同, 模型集合
   *  不相交); Merge / Mockup 根本不调 API, 摆上选择器等于骗人。 */
  imageModel: ChannelPicker;
  /** Angle 通道选择器。跟上面是两份独立选择 —— fal 的视角模型发不了生图请求, 反之
   *  亦然, 所以它们的列表和粘性选择都各归各。 */
  angleModel: ChannelPicker;
  /** Video 通道选择器 —— 只发给 VideoPanel。 */
  videoModel: ChannelPicker;
  merge: {
    isProcessing: boolean;
    error: string | null;
    onSubmit: () => void;
    onDismissError: () => void;
  };
  mockup: {
    /** Current mockup binding on the selected base, or null. */
    binding: Mockup3dBinding | null;
    /** True when the selected base is currently in "receiving" state
     *  (waiting for user to drag a design onto it). */
    isReceiving: boolean;
    /** Depth-estimation pipeline status for the current base — drives the
     *  receiving-mode UI (loading spinner / ready hint / error). */
    depthStatus: DepthStatus;
    onEnter: () => void;
    onExit: () => void;
    onRemove: () => void;
    onStrengthChange: (strength: number) => void;
    onMaskThresholdChange: (threshold: number) => void;
    onOpacityChange: (opacity: number) => void;
  };
  adjust: {
    /** Whether the floating Adjust panel is open. The page renders the panel
     *  (anchored to the right of the image); this toolbar item is just a toggle. */
    isOpen: boolean;
    onToggle: () => void;
  };
  /** Send the selected single-image to the chat as an attachment. Page
   *  decides whether the action is reachable (e.g. multi-image selections
   *  pass undefined to hide the button). Local blob:/data: URLs are
   *  handled by the page handler via auto-upload — caller doesn't gate. */
  onSendToChat?: () => void;
}

const ANCHOR_GAP = 12;
const EDGE_MARGIN = 8;

const forwardWheelToCanvas = forwardWheelToExcalidrawCanvas;

export function ImageEditBar({ selection, imageSourceUrl, preview, image, video, angle, split, merge, mockup, adjust, imageModel, angleModel, videoModel, onSendToChat }: ImageEditBarProps) {
  const { t } = useTranslation("canvasUi");
  // 初始 placement 用 0,0 而不是 screenY+screenHeight+ANCHOR_GAP —— 后者在
  // 巨图 (screenHeight > 1000px) 下会把 absolute child 定位到 y=2000+, 撑大
  // document.scrollHeight 出全页纵向 scrollbar. useLayoutEffect 同帧覆盖,
  // 用户看不到这个 0,0 的 transient.
  const { screenX, screenY, screenWidth, screenHeight } = selection.bounds;
  const [placement, setPlacement] = useState<{ left: number; top: number; flipped: boolean; hidden: boolean }>({
    left: 0,
    top: 0,
    flipped: false,
    hidden: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;

    // Vertical: prefer below, flip above only if below overflows AND above fits.
    const belowTop = screenY + screenHeight + ANCHOR_GAP;
    const aboveTop = screenY - ANCHOR_GAP - th;
    const hasBelowSpace = belowTop + th <= ph - EDGE_MARGIN;
    const hasAboveSpace = aboveTop >= EDGE_MARGIN;
    // 图占满 (或超出) viewport 时既摆不下也摆不上 —— 此时 toolbar 会飘到
    // 视口外的图下沿处, 用户看不见还以为没反应; 而且这种状态下点图多半
    // 是看图不是编辑, 直接隐藏比较干净 (要编辑就缩小 / 选别处再回来).
    const hidden = !hasBelowSpace && !hasAboveSpace;
    const flipAbove = !hasBelowSpace && hasAboveSpace;
    // hidden 时把 top 钉到 0 —— 否则 invisible 的 toolbar 仍以 belowTop
    // (=screenY+screenHeight+gap, 巨图下 2000+) 占 absolute layout, 把
    // document.scrollHeight 撑到几千像素, 出现误导性纵向 scrollbar.
    const top = hidden ? 0 : flipAbove ? aboveTop : belowTop;

    // Horizontal: center on selection, clamp to parent bounds so the toolbar
    // never extends past the canvas pane's left/right edges.
    const centerX = screenX + screenWidth / 2;
    const halfW = tw / 2;
    const left = Math.max(halfW + EDGE_MARGIN, Math.min(centerX, pw - halfW - EDGE_MARGIN));

    setPlacement((prev) =>
      prev.left === left && prev.top === top && prev.flipped === flipAbove && prev.hidden === hidden
        ? prev // identity return avoids a no-op re-render when selection ticks on pan/zoom
        : { left, top, flipped: flipAbove, hidden },
    );
  }, [screenX, screenY, screenWidth, screenHeight, selection.kind]);

  const textsLength = selection.texts.length;
  const support = useMemo(
    () => computeSupportMatrix(selection),
    // selection identity changes per pan/zoom; matrix only reads kind + texts.length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.kind, textsLength],
  );

  // Store the user's last-clicked tab as intent; resolve to an actually
  // supported tab at render time. Avoids the "derived state in useState +
  // useEffect sync" anti-pattern (would show a stale tab on the frame before
  // the effect fires).
  const [userTab, setUserTab] = useState<TabKey>("image");
  const activeTab: TabKey = support[userTab] ? userTab : firstEnabledTab(support);

  // Pick the first tab with an active error (stable evaluation order = priority).
  // Dismiss routes back to that tab's callback so each mode owns its own lifecycle.
  // Mockup 不走异步后端, 没有 error 通道, 所以不参与这里.
  const firstWithError = [image, video, angle, split, merge].find((t) => t.error);
  const activeError = firstWithError?.error ?? null;
  const activeDismiss = firstWithError?.onDismissError;

  // Canvas-drawn text becomes a prompt prefix the user can extend in the input.
  // Drives Apply/Generate gating + placeholders (i.e. "are there any labels?").
  const promptFromTexts = selection.texts
    .map((tx) => tx.text.trim())
    .filter(Boolean)
    .join("\n");

  // What the toolbar's prompt tile shows: the annotation-only prompt (no user
  // input yet). For image-with-shapes this is the spatial region mapping; for
  // single-image it's just the joined canvas texts. Memoized on content so it
  // doesn't recompute the arrow geometry on every pan/zoom tick.
  const promptPreview = useMemo(
    () => composePrompt(selection, ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.contentFp, selection.kind],
  );

  return (
    <motion.div
      ref={rootRef}
      onWheel={forwardWheelToCanvas}
      data-image-edit-bar
      className={cn(
        "pointer-events-none absolute z-40 flex flex-row items-center gap-2",
        // visibility:hidden 保留布局尺寸供 useLayoutEffect 测量, 同时屏蔽
        // 子级 pointer-events-auto 的命中. display:none 会让测量失效.
        placement.hidden && "invisible",
      )}
      style={{
        left: placement.left,
        top: placement.top,
      }}
      // 入场: 柔和上浮+淡入。x 恒为 -50% 维持水平居中 (替代原 translate(-50%,0));
      // framer 接管 transform, 故 inline transform 移除。
      initial={{ opacity: 0, y: 6, x: "-50%" }}
      animate={{ opacity: 1, y: 0, x: "-50%" }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden={placement.hidden || undefined}
    >
      <SelectionPreview urls={preview.urls} promptPreview={promptPreview} />
      <Tabs
        value={activeTab}
        onValueChange={(v) => setUserTab(v as TabKey)}
        className="pointer-events-auto gap-1.5"
      >
        <div className="mx-auto flex items-center gap-2">
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="image" className="px-3 text-xs" disabled={!support.image}>{t("edit.tabImage")}</TabsTrigger>
            <TabsTrigger value="video" className="px-3 text-xs" disabled={!support.video}>{t("edit.tabVideo")}</TabsTrigger>
            <TabsTrigger value="angle" className="px-3 text-xs" disabled={!support.angle}>{t("edit.tabAngle")}</TabsTrigger>
            <TabsTrigger value="split" className="px-3 text-xs" disabled={!support.split}>{t("edit.tabSplit")}</TabsTrigger>
            <TabsTrigger value="merge" className="px-3 text-xs" disabled={!support.merge}>{t("edit.tabMerge")}</TabsTrigger>
            <TabsTrigger value="mockup" className="px-3 text-xs" disabled={!support.mockup}>{t("edit.tabMockup")}</TabsTrigger>
          </TabsList>
          {selection.kind === "single-image" && (
            <div className="pointer-events-auto flex items-center gap-2">
              {/* `!h-5` 必须: Separator 内部 data-[orientation=vertical]:h-full
                  在没明确父高度的 flex 行里会塌成 0, 这里用 important 压回. */}
              <Separator orientation="vertical" className="!h-5 bg-border/60" />
              <IconButton
                variant={adjust.isOpen ? "primary" : "ghost"}
                label={t("edit.tabAdjust")}
                disabled={false}
                onClick={adjust.onToggle}
              >
                <SlidersHorizontal className="size-4" />
              </IconButton>
              {onSendToChat && (
                <IconButton
                  variant="ghost"
                  label={t("edit.sendToChat")}
                  disabled={false}
                  onClick={onSendToChat}
                >
                  <MessageSquarePlus className="size-4" />
                </IconButton>
              )}
              {imageSourceUrl && (
                <IconButton
                  variant="ghost"
                  label={t("edit.download")}
                  disabled={false}
                  onClick={() => void handleImageDownload(selection.image, imageSourceUrl, t)}
                >
                  <Download className="size-4" />
                </IconButton>
              )}
            </div>
          )}
        </div>
        {support.image && (
          <TabsContent value="image">
            <ImagePanel
              selection={selection}
              multiImageCount={selection.kind === "multi-image" ? selection.images.length : 0}
              promptFromTexts={promptFromTexts}
              isSubmitting={image.isSubmitting}
              onSubmit={image.onSubmit}
              imageModel={imageModel}
            />
          </TabsContent>
        )}
        {support.video && (
          <TabsContent value="video">
            <VideoPanel
              videoModel={videoModel}
              canPin={!!imageSourceUrl}
              promptFromTexts={promptFromTexts}
              isSubmitting={video.isSubmitting}
              onSubmit={video.onSubmit}
            />
          </TabsContent>
        )}
        {support.angle && (
          <TabsContent value="angle">
            <AnglePanel
              sourceUrl={imageSourceUrl}
              isSubmitting={angle.isSubmitting}
              onSubmit={angle.onSubmit}
              angleModel={angleModel}
            />
          </TabsContent>
        )}
        {support.split && (
          <TabsContent value="split">
            <SplitPanel
              isSubmitting={split.isSubmitting}
              onSubmit={split.onSubmit}
              imageModel={imageModel}
            />
          </TabsContent>
        )}
        {support.merge && (
          <TabsContent value="merge">
            <MergePanel isProcessing={merge.isProcessing} onSubmit={merge.onSubmit} />
          </TabsContent>
        )}
        {support.mockup && (
          <TabsContent value="mockup">
            <MockupPanel
              binding={mockup.binding}
              isReceiving={mockup.isReceiving}
              depthStatus={mockup.depthStatus}
              onEnter={mockup.onEnter}
              onExit={mockup.onExit}
              onRemove={mockup.onRemove}
              onStrengthChange={mockup.onStrengthChange}
              onMaskThresholdChange={mockup.onMaskThresholdChange}
              onOpacityChange={mockup.onOpacityChange}
            />
          </TabsContent>
        )}
      </Tabs>

      {activeError && (
        <button
          type="button"
          onClick={activeDismiss}
          className={cn(
            "pointer-events-auto max-w-md rounded-lg border border-destructive/30",
            "bg-destructive/10 px-3 py-1.5 text-left text-[11px] text-destructive shadow-sm",
          )}
        >
          {activeError}
          <span className="ml-2 text-muted-foreground">· {t("edit.dismiss")}</span>
        </button>
      )}
    </motion.div>
  );
}

// ─── Selection preview ───────────────────────────────────────────────────────

/** Pulsing skeleton holds the slot until the first debounced export mints
 *  blobs. Once loaded, each blob becomes its own clickable thumbnail in a
 *  left-to-right row (multi-image selections see N tiles, one per source image
 *  the provider will receive). Clicking a thumb opens a Dialog with that blob
 *  at full resolution so the user can verify what the provider will see. */
function SelectionPreview({ urls, promptPreview }: { urls: string[]; promptPreview: string }) {
  // self-end aligns the preview row to the bottom of the toolbar root so the
  // thumbs sit on the same line as the form's input row (TabsList sits above).
  if (urls.length === 0 && !promptPreview) {
    return (
      <div className="size-10 self-end animate-pulse rounded-md border border-dashed border-border/60" />
    );
  }
  return (
    <div className="pointer-events-auto flex flex-row items-center gap-1 self-end">
      {urls.map((url, i) => (
        <PreviewThumb key={url} url={url} index={i} total={urls.length} />
      ))}
      {promptPreview && <PromptTile prompt={promptPreview} />}
    </div>
  );
}

function PromptTile({ prompt }: { prompt: string }) {
  const { t } = useTranslation("canvasUi");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("edit.showPromptFromText")}
          title={t("edit.promptFromTextExpand")}
          className={cn(
            "flex size-10 items-center justify-center rounded-md",
            "border border-border/60 bg-transparent text-[10px] font-medium uppercase tracking-wider",
            "text-muted-foreground transition-transform hover:scale-110 hover:border-border hover:text-foreground",
          )}
        >
          {t("edit.textBadge")}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl p-4">
        <DialogTitle className="text-sm">{t("edit.promptFromText")}</DialogTitle>
        <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm text-foreground">
          {prompt}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function PreviewThumb({ url, index, total }: { url: string; index: number; total: number }) {
  const { t } = useTranslation("canvasUi");
  const label =
    total > 1
      ? t("edit.expandPreview", { index: index + 1, total })
      : t("edit.expandPreviewSimple");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={t("edit.expandHint", { label })}
          className="size-10 overflow-hidden rounded-md bg-transparent transition-transform hover:scale-110"
        >
          <PreviewImage url={url} className="h-full w-full" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl p-2">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <PreviewImage url={url} className="mx-auto max-h-[80vh] max-w-full" />
      </DialogContent>
    </Dialog>
  );
}

function PreviewImage({ url, className }: { url: string; className?: string }) {
  const { t } = useTranslation("canvasUi");
  return (
    <img
      src={url}
      alt={t("edit.selectionPreview")}
      className={cn("object-contain", className)}
    />
  );
}

// ─── Image panel ────────────────────────────────────────────────────────────

interface ImagePanelProps {
  /** Drives the final prompt: image-with-shapes routes arrows through
   *  `buildSpatialPrompt`, other kinds use the flat canvas-text join. */
  selection: CanvasSelection;
  /** >0 when selection is multi-image (used to hint the user and block cutout,
   *  which has no multi-image semantics —— rembg is single-image only). 0 for
   *  single-image / image-with-shapes selections. */
  multiImageCount: number;
  /** Canvas text labels joined (gating + placeholder only). Apply enabled if
   *  EITHER this or the user's input is non-empty. */
  promptFromTexts: string;
  isSubmitting: boolean;
  onSubmit: (params: {
    prompt?: string;
    cutout?: boolean;
    size: ImageEditSize;
    resolution: ImageEditResolution;
    n: ImageEditCount;
  }) => void;
  imageModel: ChannelPicker;
}

function ImagePanel({ selection, multiImageCount, promptFromTexts, isSubmitting, onSubmit, imageModel }: ImagePanelProps) {
  const { t } = useTranslation("canvasUi");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ImageEditSize>("auto");
  const [resolution, setResolution] = useState<ImageEditResolution>("2K");
  const [n, setN] = useState<ImageEditCount>(1);

  const isMulti = multiImageCount > 0;
  const trimmed = prompt.trim();
  const canApply = !isSubmitting && (trimmed.length > 0 || promptFromTexts.length > 0);

  // 这个模型**真的收**哪几种比例 —— 后端下发 (已经合并过三层配置)。空 = 不限制。
  // 选不中的东西就不该出现在列表里: 实测 apimart 的 gemini-3.1-flash-image-preview 只收
  // 15 种、别的直接 400, 而同一家的 gpt-image-2 什么都收 —— 这是 per-model 的事实, 所以
  // 只能问后端, 前端写不出一张表来。
  //
  // 交集为空时退回完整列表: 模型收的比例可能一个都不在画布这十个里 (4:5 / 8:1 之类),
  // 那时给一个空下拉是最糟的结果 —— 宁可让用户选、后端兜底映射到最近的一个。
  const allowedKey = (imageModel.models.find((m) => m.id === imageModel.value)
    ?.allowed_ratios ?? []).join(",");
  const sizes = useMemo(() => {
    const allowed = allowedKey ? allowedKey.split(",") : [];
    const hit = IMAGE_EDIT_SIZES.filter((s) => allowed.includes(s.value));
    return hit.length ? hit : IMAGE_EDIT_SIZES;
  }, [allowedKey]);

  // 换了模型之后旧选择可能不在新列表里 —— select 的 value 找不到对应 option 会显示成
  // 空白, 而用户以为自己选了个东西。
  useEffect(() => {
    if (!sizes.some((s) => s.value === size)) setSize(sizes[0].value);
  }, [sizes, size]);

  function submitApply() {
    if (!canApply) return;
    const finalPrompt = composePrompt(selection, trimmed);
    onSubmit({ prompt: finalPrompt, size, resolution, n });
    setPrompt("");
  }

  function submitCutout() {
    if (isSubmitting || isMulti) return;
    // Carry the marquee prompt (box region / arrows / text + typed input) so the
    // backend can fold it into CUTOUT_LLM_PROMPT. Empty when nothing's annotated
    // → plain cutout. Same prompt Apply would build, so the input box is consistent.
    const marqueePrompt = composePrompt(selection, trimmed);
    onSubmit({ cutout: true, prompt: marqueePrompt, size, resolution, n });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submitApply();
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitApply();
    }
  }

  return (
    <form onSubmit={handleSubmit} className={toolbarClass}>
      <input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKey}
        placeholder={
          isMulti
            ? t("edit.placeholderCombine", { count: multiImageCount })
            : promptFromTexts
            ? t("edit.placeholderAddText")
            : t("edit.placeholderDescribe")
        }
        disabled={isSubmitting}
        className={inputClass}
      />
      <Divider />
      <ImageModelSelector {...imageModel} variant="text" buttonDisabled={isSubmitting} />
      <Divider />
      <select
        value={size}
        onChange={(e) => setSize(e.target.value as ImageEditSize)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {sizes.map((s) => (
          <option key={s.value} value={s.value}>
            {s.value === "auto" ? t("edit.sizeAuto") : s.label}
          </option>
        ))}
      </select>
      <Divider />
      <select
        value={resolution}
        onChange={(e) => setResolution(e.target.value as ImageEditResolution)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {IMAGE_EDIT_RESOLUTIONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <Divider />
      <select
        value={String(n)}
        onChange={(e) => setN(Number(e.target.value) as ImageEditCount)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {IMAGE_EDIT_COUNTS.map((c) => (
          <option key={c} value={c}>×{c}</option>
        ))}
      </select>
      <Divider />
      <IconButton
        onClick={submitCutout}
        disabled={isSubmitting || isMulti}
        label={isMulti ? t("edit.cutoutUnavailable") : t("edit.cutout")}
        variant="ghost"
      >
        <Scissors className="size-4" strokeWidth={1.5} />
      </IconButton>
      <IconButton
        type="submit"
        disabled={!canApply}
        label={t("edit.apply")}
        variant="primary"
      >
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        ) : (
          <Wand2 className="size-4" strokeWidth={1.5} />
        )}
      </IconButton>
    </form>
  );
}

// ─── Video panel ────────────────────────────────────────────────────────────

interface VideoPanelProps {
  videoModel: ChannelPicker;
  /** False if the selected image has no public URL (only a local dataURL).
   *  External video provider can't fetch a local blob, so Generate is locked. */
  canPin: boolean;
  promptFromTexts: string;
  isSubmitting: boolean;
  onSubmit: (params: {
    prompt: string;
    duration: VideoDuration;
    aspectRatio: VideoAspectRatio;
  }) => void;
}

function VideoPanel({ videoModel, canPin, promptFromTexts, isSubmitting, onSubmit }: VideoPanelProps) {
  const { t } = useTranslation("canvasUi");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<VideoDuration>(5);
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>("16:9");

  const trimmed = prompt.trim();
  const canGenerate = canPin && !isSubmitting && (trimmed.length > 0 || promptFromTexts.length > 0);

  function submitGenerate() {
    if (!canGenerate) return;
    const finalPrompt = [promptFromTexts, trimmed].filter(Boolean).join("\n");
    onSubmit({ prompt: finalPrompt, duration, aspectRatio });
    setPrompt("");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submitGenerate();
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitGenerate();
    }
  }

  return (
    <form onSubmit={handleSubmit} className={toolbarClass}>
      <input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKey}
        placeholder={
          !canPin
            ? t("edit.pinFirst")
            : promptFromTexts
            ? t("edit.placeholderAddText")
            : t("edit.describeVideo")
        }
        disabled={!canPin || isSubmitting}
        className={inputClass}
      />
      <Divider />
      <ImageModelSelector
        {...videoModel}
        variant="text"
        buttonDisabled={isSubmitting}
        title={t("imageModels.videoTitle")}
      />
      <Divider />
      <select
        value={String(duration)}
        onChange={(e) => setDuration(Number(e.target.value) as VideoDuration)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {VIDEO_DURATIONS.map((d) => (
          <option key={d} value={d}>{t("edit.durationSuffix", { n: d })}</option>
        ))}
      </select>
      <Divider />
      <select
        value={aspectRatio}
        onChange={(e) => setAspectRatio(e.target.value as VideoAspectRatio)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {VIDEO_ASPECT_RATIOS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <Divider />
      <IconButton
        type="submit"
        disabled={!canGenerate}
        label={canPin ? t("edit.generateVideo") : t("edit.pinFirst")}
        variant="primary"
      >
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        ) : (
          <Clapperboard className="size-4" strokeWidth={1.5} />
        )}
      </IconButton>
    </form>
  );
}

// ─── Angle panel ────────────────────────────────────────────────────────────

interface AnglePanelProps {
  /** Selected image's public URL (null for user drag-dropped images that only
   *  have a local dataURL). The cube shows the texture when we have a URL;
   *  Generate stays locked when we don't — fal can't fetch local blobs. */
  sourceUrl: string | null;
  isSubmitting: boolean;
  onSubmit: (params: { angles: CameraAngles }) => void;
  angleModel: ChannelPicker;
}

function AnglePanel({ sourceUrl, isSubmitting, onSubmit, angleModel }: AnglePanelProps) {
  const { t } = useTranslation("canvasUi");
  const [angles, setAngles] = useState<CameraAngles>(DEFAULT_CAMERA_ANGLES);

  const canGenerate = !!sourceUrl && !isSubmitting;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canGenerate) return;
    onSubmit({ angles });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-2 p-2", panelChromeClass)}
    >
      <AngleCube
        imageUrl={sourceUrl}
        angles={angles}
        onAnglesChange={setAngles}
        width={320}
        height={240}
      />
      <div className="flex items-center">
        <div className="flex-1 px-3 text-xs text-muted-foreground">
          {t("edit.dragCube")}
        </div>
        <Divider />
        <ImageModelSelector
          {...angleModel}
          variant="text"
          buttonDisabled={isSubmitting}
          title={t("imageModels.angleTitle")}
        />
        <Divider />
        <IconButton
          type="submit"
          disabled={!canGenerate}
          label={sourceUrl ? t("edit.generateAngle") : t("edit.pinFirst")}
          variant="primary"
        >
          {isSubmitting ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
          ) : (
            <RotateCw className="size-4" strokeWidth={1.5} />
          )}
        </IconButton>
      </div>
    </form>
  );
}

// ─── Split panel ────────────────────────────────────────────────────────────

interface SplitPanelProps {
  isSubmitting: boolean;
  onSubmit: (params: { resolution: ImageEditResolution }) => void;
  imageModel: ChannelPicker;
}

/** Split = subject cutout + clean-bg inpaint (fixed pipeline); the knobs are the
 *  resolution tier (1K/2K/4K) and which model runs the inpaint leg. For other
 *  tweaks, switch to the Image tab. */
function SplitPanel({ isSubmitting, onSubmit, imageModel }: SplitPanelProps) {
  const { t } = useTranslation("canvasUi");
  const [resolution, setResolution] = useState<ImageEditResolution>("2K");
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    onSubmit({ resolution });
  }
  return (
    <form onSubmit={handleSubmit} className={toolbarClass}>
      <div className="flex-1 px-3 text-xs text-muted-foreground">{t("edit.splitDesc")}</div>
      <Divider />
      <ImageModelSelector {...imageModel} variant="text" buttonDisabled={isSubmitting} />
      <Divider />
      <select
        value={resolution}
        onChange={(e) => setResolution(e.target.value as ImageEditResolution)}
        disabled={isSubmitting}
        className={selectClass}
      >
        {IMAGE_EDIT_RESOLUTIONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <Divider />
      <IconButton type="submit" disabled={isSubmitting} label={t("edit.splitBtn")} variant="primary">
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        ) : (
          <SplitSquareHorizontal className="size-4" strokeWidth={1.5} />
        )}
      </IconButton>
    </form>
  );
}

// ─── Merge panel ────────────────────────────────────────────────────────────

interface MergePanelProps {
  isProcessing: boolean;
  onSubmit: () => void;
}

function MergePanel({ isProcessing, onSubmit }: MergePanelProps) {
  const { t } = useTranslation("canvasUi");
  return (
    <NoInputPanel
      description={t("edit.mergeDesc")}
      label={t("edit.mergeBtn")}
      icon={<Layers className="size-4" strokeWidth={1.5} />}
      isSubmitting={isProcessing}
      onSubmit={onSubmit}
    />
  );
}

// ─── Mockup panel ───────────────────────────────────────────────────────────

interface MockupPanelProps {
  binding: Mockup3dBinding | null;
  isReceiving: boolean;
  depthStatus: DepthStatus;
  onEnter: () => void;
  onExit: () => void;
  onRemove: () => void;
  onStrengthChange: (strength: number) => void;
  onMaskThresholdChange: (threshold: number) => void;
  onOpacityChange: (opacity: number) => void;
}

/** Four states:
 *   - bound: 已经有 mockup binding → Depth + Mask + Opacity sliders + Remove
 *     (size + rotate are edited via the in-canvas gizmo)
 *   - receiving + depth loading: spinner
 *   - receiving + depth ready: "Drop a design here" hint + Cancel
 *   - idle: "Set as mockup target" button */
function MockupPanel({
  binding, isReceiving, depthStatus,
  onEnter, onExit, onRemove,
  onStrengthChange, onMaskThresholdChange, onOpacityChange,
}: MockupPanelProps) {
  const { t } = useTranslation("canvasUi");
  if (binding) {
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); onRemove(); }}
        className={cn("flex flex-col gap-2 p-2", panelChromeClass)}
      >
        <SliderRow label={t("edit.sliderDepth")} min={0} max={1} step={0.01} unit="%"
          value={binding.strength} onChange={onStrengthChange}
          format={(v) => Math.round(v * 100).toString()} />
        <SliderRow label={t("edit.sliderMask")} min={0} max={1} step={0.01} unit="%"
          value={binding.maskThreshold ?? 0.5} onChange={onMaskThresholdChange}
          format={(v) => Math.round(v * 100).toString()} />
        <SliderRow label={t("edit.sliderOpacity")} min={0} max={1} step={0.01} unit="%"
          value={binding.opacity ?? 1} onChange={onOpacityChange}
          format={(v) => Math.round(v * 100).toString()} />
        <div className="flex items-center justify-between gap-1 px-2">
          <span className="text-[11px] text-muted-foreground">
            {t("edit.reposition")}
          </span>
          <IconButton type="submit" disabled={false} label={t("edit.removeMockup")} variant="ghost">
            <X className="size-4" strokeWidth={1.5} />
          </IconButton>
        </div>
      </form>
    );
  }
  if (isReceiving) {
    const message = t(`edit.depth.${depthStatus}`);
    const tone = depthStatus === "error" ? "text-destructive" : "text-primary";
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); onExit(); }}
        className={toolbarClass}
      >
        <div className={cn("flex-1 px-3 text-xs", tone)}>{message}</div>
        <Divider />
        <IconButton type="submit" disabled={false} label={t("edit.cancel")} variant="ghost">
          <X className="size-4" strokeWidth={1.5} />
        </IconButton>
      </form>
    );
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onEnter(); }}
      className={toolbarClass}
    >
      <div className="flex-1 px-3 text-xs text-muted-foreground">
        {t("edit.mockupInstruction")}
      </div>
      <Divider />
      <IconButton type="submit" disabled={false} label={t("edit.setMockupTarget")} variant="primary">
        <Frame className="size-4" strokeWidth={1.5} />
      </IconButton>
    </form>
  );
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
  format: (v: number) => string;
}

function SliderRow({ label, min, max, step, value, unit, onChange, format }: SliderRowProps) {
  return (
    <label className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
      <span className="w-12">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-primary"
      />
      <span className="w-10 text-right tabular-nums text-foreground">
        {format(value)}{unit}
      </span>
    </label>
  );
}

// ─── Adjust (调色) panel ─────────────────────────────────────────────────────

// Section-jump icons (≈ the 4 group glyphs in the reference). Click scrolls the
// single column to that group — they navigate, they don't switch content.
const ADJUST_GROUP_ICONS: Record<AdjustGroupSpec["id"], LucideIcon> = {
  light: Contrast,
  color: Blend,
  detail: Aperture,
  effects: Hexagon,
};

interface AdjustPanelProps {
  /** Current adjust binding (neutral default when the image has none yet). */
  binding: AdjustBinding | null;
  onChange: (key: AdjustKey, value: number) => void;
  onBandChange: (band: ColorBand, channel: BandChannel, value: number) => void;
  onReset: () => void;
  onAuto: () => void;
  onClose: () => void;
}

/** 调整面板:单列滚动,顶部图标跳转到对应分组(不切换内容)。值持久化在图片
 *  customData(就地、无新图,常驻 overlay 实时渲染);重置(仅有调整时显示)删绑定
 *  还原原图。面板无本地态 —— 值由页面从 customData 重算下传。 */
export function AdjustPanel({ binding, onChange, onBandChange, onReset, onAuto, onClose }: AdjustPanelProps) {
  const { t } = useTranslation("canvasUi");
  const sectionRefs = useRef<Partial<Record<AdjustGroupSpec["id"], HTMLElement | null>>>({});
  if (!binding) return null;
  const dirty = !isAdjustNeutral(binding);

  return (
    <div
      // Wheel over the panel scrolls the panel only — stop it bubbling to the
      // toolbar root's forwardWheelToCanvas (which would also pan the canvas).
      onWheel={(e) => e.stopPropagation()}
      className={cn("flex w-[300px] flex-col", panelChromeClass)}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
        <span className="text-sm font-medium text-foreground">{t("edit.adjust.title")}</span>
        <div className="flex items-center gap-1 text-muted-foreground">
          <button type="button" onClick={onAuto} title={t("edit.adjust.auto")} className="rounded p-0.5 hover:text-foreground">
            <Wand2 className="size-4" strokeWidth={1.5} />
          </button>
          {dirty && (
            <button type="button" onClick={onReset} title={t("edit.adjust.reset")} className="rounded p-0.5 hover:text-foreground">
              <RotateCcw className="size-4" strokeWidth={1.5} />
            </button>
          )}
          <button type="button" onClick={onClose} title={t("edit.adjust.close")} className="rounded p-0.5 hover:text-foreground">
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-around border-b border-border/50 px-2 pb-1.5">
        {ADJUST_GROUPS.map((g) => {
          const Icon = ADJUST_GROUP_ICONS[g.id];
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => sectionRefs.current[g.id]?.scrollIntoView({ behavior: "smooth", block: "start" })}
              title={t(`edit.adjust.group_${g.id}`)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Icon className="size-4" strokeWidth={1.5} />
            </button>
          );
        })}
      </div>
      <div className="flex max-h-[30vh] flex-col gap-3 overflow-y-auto overscroll-contain p-3">
        {ADJUST_GROUPS.map((g) => (
          <section
            key={g.id}
            ref={(el) => { sectionRefs.current[g.id] = el; }}
            className="flex scroll-mt-1 flex-col gap-2"
          >
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
              {t(`edit.adjust.group_${g.id}`)}
            </span>
            {g.sliders.map((s) => (
              <AdjustSliderRow
                key={s.key}
                label={t(`edit.adjust.${s.key}`)}
                value={binding.values[s.key]}
                min={s.min ?? ADJUST_MIN}
                gradient={s.gradient}
                onChange={(v) => onChange(s.key, v)}
              />
            ))}
            {g.id === "color" && (
              <ColorMixSection colorMix={binding.colorMix} onBandChange={onBandChange} />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

// Gradient tracks for the white-balance sliders (blue→neutral→yellow / magenta→
// neutral→green) — a recognizable affordance matching photo-editor convention.
const ADJUST_GRADIENT: Record<"temperature" | "tint", string> = {
  temperature: "linear-gradient(90deg, #4a90d9 0%, #e9eaec 50%, #f5c842 100%)",
  tint: "linear-gradient(90deg, #d94ad9 0%, #e9eaec 50%, #4ad94a 100%)",
};

interface AdjustSliderRowProps {
  label: string;
  value: number;
  min: number;
  gradient?: "temperature" | "tint";
  onChange: (v: number) => void;
}

/** Slider centered at 0 when bidirectional (min<0); double-click resets to 0.
 *  Color sliders show a gradient track. */
function AdjustSliderRow({ label, value, min, gradient, onChange }: AdjustSliderRowProps) {
  const showSign = min < 0;
  return (
    <label className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
      <span className="w-20 shrink-0 truncate">{label}</span>
      <input
        type="range"
        min={min}
        max={ADJUST_MAX}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        onDoubleClick={() => onChange(0)}
        className={cn(
          "h-1.5 flex-1 cursor-pointer appearance-none rounded-full",
          !gradient && "bg-border",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background",
          "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background",
        )}
        style={gradient ? { background: ADJUST_GRADIENT[gradient] } : undefined}
      />
      <span className="w-8 shrink-0 text-right tabular-nums text-foreground">
        {showSign && value > 0 ? `+${value}` : value}
      </span>
    </label>
  );
}

// Per-color HSL mixer (Photoshop Hue/Saturation style): pick a band swatch,
// then adjust its 色相 / 饱和度 / 明度. The 8 bands' values live in the hook.
const BAND_CHANNELS: { key: BandChannel; labelKey: string }[] = [
  { key: "h", labelKey: "edit.adjust.bandHue" },
  { key: "s", labelKey: "edit.adjust.bandSat" },
  { key: "l", labelKey: "edit.adjust.bandLum" },
];

interface ColorMixSectionProps {
  colorMix: ColorMix;
  onBandChange: (band: ColorBand, channel: BandChannel, value: number) => void;
}

function ColorMixSection({ colorMix, onBandChange }: ColorMixSectionProps) {
  const { t } = useTranslation("canvasUi");
  const [active, setActive] = useState<ColorBand>("red");
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/50 pt-2">
      <div className="flex items-center justify-between px-1">
        {COLOR_BANDS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setActive(b)}
            title={t(`edit.adjust.band_${b}`)}
            aria-pressed={active === b}
            className={cn(
              "size-5 rounded-full border transition hover:scale-110",
              active === b ? "border-foreground ring-2 ring-foreground/30" : "border-border/70",
            )}
            style={{ backgroundColor: COLOR_BAND_META[b].swatch }}
          />
        ))}
      </div>
      {BAND_CHANNELS.map((ch) => (
        <AdjustSliderRow
          key={ch.key}
          label={t(ch.labelKey)}
          value={colorMix[active][ch.key]}
          min={ADJUST_MIN}
          onChange={(v) => onBandChange(active, ch.key, v)}
        />
      ))}
    </div>
  );
}

export interface AdjustAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloatingAdjustPanelProps extends AdjustPanelProps {
  /** The anchored image's screen rect (canvas-pane-relative). */
  anchorRect: AdjustAnchorRect;
}

/** Floating wrapper: positions the AdjustPanel to the right of the anchored
 *  image (flips to the image's left when there's no room), clamped to the
 *  canvas pane. Invisible until measured — mirrors the toolbar's placement. */
export function FloatingAdjustPanel({ anchorRect, ...panelProps }: FloatingAdjustPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number; visible: boolean }>({
    left: 0,
    top: 0,
    visible: false,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent as HTMLElement | null;
    if (!el || !pane) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pw = pane.clientWidth;
    const ph = pane.clientHeight;
    const GAP = 12;
    let left = anchorRect.left + anchorRect.width + GAP;
    if (left + w > pw - 8) left = anchorRect.left - w - GAP; // flip to the image's left
    left = Math.max(8, Math.min(left, pw - w - 8));
    const top = Math.max(8, Math.min(anchorRect.top, ph - h - 8));
    setPlaced({ left, top, visible: true });
  }, [anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height]);

  return (
    <div
      ref={ref}
      className={cn("pointer-events-auto absolute z-50", !placed.visible && "invisible")}
      style={{ left: placed.left, top: placed.top }}
    >
      <AdjustPanel {...panelProps} />
    </div>
  );
}

interface NoInputPanelProps {
  description: string;
  label: string;
  icon: React.ReactNode;
  isSubmitting: boolean;
  onSubmit: () => void;
}

function NoInputPanel({ description, label, icon, isSubmitting, onSubmit }: NoInputPanelProps) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    onSubmit();
  }
  return (
    <form onSubmit={handleSubmit} className={toolbarClass}>
      <div className="flex-1 px-3 text-xs text-muted-foreground">{description}</div>
      <Divider />
      <IconButton type="submit" disabled={isSubmitting} label={label} variant="primary">
        {isSubmitting ? <Loader2 className="size-4 animate-spin" strokeWidth={1.5} /> : icon}
      </IconButton>
    </form>
  );
}

// ─── Shared toolbar primitives ──────────────────────────────────────────────

// Card chrome shared by all three panels — keeps border/background/shadow
// identical so switching tabs doesn't cause a visual jump. Layout classes
// (flex direction, padding, gap) live on the individual forms since they
// diverge between horizontal (image/video) and stacked (angle) layouts.
const panelChromeClass =
  "rounded-xl border border-border/60 bg-frost shadow-lg ring-1 ring-black/8 backdrop-blur-md";

const toolbarClass = cn("flex items-center gap-0", panelChromeClass);

const inputClass = cn(
  "h-10 min-w-[220px] flex-1 bg-transparent px-3 text-sm outline-none",
  "placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-60",
);

function Divider() {
  return <Separator orientation="vertical" className="h-5 bg-border/60" />;
}

/** 选中图下载 —— 导出"画布上所见": 尊重裁剪 + 画布缩放(= HUD 显示的像素),
 *  并把 adjust / 3D mockup 实时图层合进去。
 *
 *  effects(adjust/mockup)是 WebGL / Three.js 实时渲染到 overlay 的, 不在
 *  Excalidraw 的导出里, 所以这里手动合成:
 *   1. 在 base 原分辨率(= crop 的 natural 坐标系)下合出"完整效果图" ——
 *      captureAdjust/MockupAtSize 让 renderer 临时 resize 到原分辨率重渲一次,
 *      拿到锐利的 overlay, 屏幕上看不见中间状态。
 *   2. 按 el.crop 抠出可见区域, 再缩放到 el 的画布尺寸(所见即所得)。
 *  无 effect + 无裁剪 + 未缩放 → 直接下原图字节(保留格式, 不重编码)。
 *
 *  用 createImageBitmap 读底图: 跨域 blob 解码 off-thread, 也避开
 *  HTMLImageElement 的 tainted-canvas 限制。
 *  注: 旋转 / 翻转 暂不处理(沿用旧行为)。 */
async function handleImageDownload(el: ExcalidrawImageElement, imageSourceUrl: string, t: TFunction) {
  try {
    const res = await fetch(imageSourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const baseImg = await createImageBitmap(blob);

    try {
      const baseId = el.id;
      const crop = el.crop;
      // Output = on-canvas size (what the HUD shows / "what you see").
      const outW = Math.max(1, Math.round(el.width));
      const outH = Math.max(1, Math.round(el.height));
      // Effects composite at full source resolution, in the crop's coord space,
      // BEFORE crop+scale — so crop offsets line up and the downscale stays crisp.
      const fullW = crop?.naturalWidth ?? baseImg.width;
      const fullH = crop?.naturalHeight ?? baseImg.height;
      const wantsAdjust = hasAdjust(baseId);
      const adjusted = wantsAdjust ? captureAdjustAtSize(baseId, fullW, fullH) : null;
      // `hasAdjust` true but capture returned null = the adjust GL texture isn't
      // ready yet (race: download clicked mid texture-load). Abort rather than
      // silently exporting the UN-adjusted image.
      if (wantsAdjust && !adjusted) {
        toast.error(t("edit.downloadFailed"));
        return;
      }
      const overlay = captureMockupAtSize(baseId, fullW, fullH);

      // Untouched (no effects, no crop, not resized) → original bytes, no re-encode.
      if (!adjusted && !overlay && !crop && outW === baseImg.width && outH === baseImg.height) {
        triggerBlobDownload(blob, `canvex-canvas-${formatDownloadTimestamp()}.${pickImageExt(blob, imageSourceUrl)}`);
        return;
      }

      // 1) Full-res composite (adjusted base, then mockup decal) in source coords.
      const full = document.createElement("canvas");
      full.width = fullW;
      full.height = fullH;
      const fctx = full.getContext("2d");
      if (!fctx) throw new Error("canvas 2d context unavailable");
      fctx.drawImage(adjusted ?? baseImg, 0, 0, fullW, fullH);
      if (overlay) fctx.drawImage(overlay, 0, 0, fullW, fullH);

      // 2) Crop region (native px) → on-canvas output size. No crop → whole image.
      const { x: sx, y: sy, width: sw, height: sh } = crop ?? { x: 0, y: 0, width: fullW, height: fullH };
      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const octx = out.getContext("2d");
      if (!octx) throw new Error("canvas 2d context unavailable");
      octx.drawImage(full, sx, sy, sw, sh, 0, 0, outW, outH);

      const compositeBlob = await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png"),
      );
      triggerBlobDownload(compositeBlob, `canvex-canvas-${formatDownloadTimestamp()}.png`);
    } finally {
      baseImg.close();
    }
  } catch (err) {
    console.error("[canvas] image download failed:", err);
    toast.error(t("edit.downloadFailed"));
  }
}

function formatDownloadTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

interface IconButtonProps {
  type?: "button" | "submit";
  onClick?: () => void;
  disabled: boolean;
  label: string;
  variant: "ghost" | "primary";
  children: React.ReactNode;
}

/** Thin wrapper over shadcn `<Button size="icon-sm">`: normalises
 *  ghost (muted → foreground hover) and primary (ember bg) against
 *  canvex's toolbar look, adds `m-1` margin to create visual breathing
 *  room between the icon and the divider/input. */
function IconButton({ type = "button", onClick, disabled, label, variant, children }: IconButtonProps) {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      size="icon-sm"
      variant={variant === "ghost" ? "ghost" : "default"}
      title={label}
      aria-label={label}
      className={cn(
        "m-1 rounded-lg",
        variant === "ghost" &&
          "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40",
        variant === "primary" && "ml-0 disabled:opacity-50",
      )}
    >
      {children}
    </Button>
  );
}
