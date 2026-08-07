import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import { History, Loader2, Map as MapIcon } from "lucide-react";

import { Minimap } from "@/components/canvas/Minimap";
import { ImageAdjustOverlay } from "@/components/canvas/ImageAdjustOverlay";
import { Mockup3dOverlay } from "@/components/canvas/Mockup3dOverlay";
import { CanvasMeasureOverlay } from "@/components/canvas/CanvasMeasureOverlay";
import { CanvasImagePlacementOverlay } from "@/components/canvas/CanvasImagePlacementOverlay";
import { CanvasGeneratingOverlay } from "@/components/canvas/CanvasGeneratingOverlay";
import { CanvasLandingOverlay } from "@/components/canvas/CanvasLandingOverlay";
import { excalidrawLangCode, useLanguageToggle } from "@/hooks/use-language";
import { ChatFrameOverlay } from "@/components/canvas/ChatFrameOverlay";
import { CanvasSidebar, CANVAS_OPEN_MEDIA_LIBRARY_EVENT } from "@/components/canvas/CanvasSidebar";
import { MediaLibrary } from "@/components/canvas/MediaLibrary";
import { Button } from "@/components/ui/button";
import { cn, clearIfNonEmpty } from "@/lib/utils";
import { canvasService, waitForCanvasJob } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import {
  pinCanvasJobResult,
  useCanvasPinning,
  type JobKind,
  type PinPlaceholder,
} from "@/hooks/use-canvas-pinning";
import { useResumeCanvasJobs } from "@/hooks/use-resume-canvas-jobs";
import { useCanvasSelection, type CanvasSelection } from "@/hooks/use-canvas-selection";
import { useAngleEdit } from "@/hooks/use-angle-edit";
import { useBackToLatest } from "@/hooks/use-back-to-latest";
import { useCanvasImageImport } from "@/hooks/use-canvas-image-import";
import { useSuppressSwipeNav } from "@/hooks/use-suppress-swipe-nav";
import { useImageEdit } from "@/hooks/use-image-edit";
import { useMockup } from "@/hooks/use-mockup";
import { useImageAdjust } from "@/hooks/use-image-adjust";
import { useSelectionPreview } from "@/hooks/use-selection-preview";
import { useMergeLayer } from "@/hooks/use-merge-layer";
import { useSplit } from "@/hooks/use-split";
import { useVideoEdit } from "@/hooks/use-video-edit";
import { getMockupBinding, worldPointToBaseUv } from "@/lib/canvas-mockup";
import { DEFAULT_ADJUST_BINDING, getAdjustBinding } from "@/lib/canvas-adjust";
import { elementScreenRect, screenPointToWorld } from "@/lib/excalidraw-bounds";
import {
  hydrateUrlBackedFiles,
  stripHydratableFiles,
} from "@/lib/canvas-scene-files";
import { skillSlugFromToolCall, toolArgAsNonNegInt, toolArgAsString } from "@/lib/canvas-skill-events";
import { imageEditOutputSize } from "@/lib/canvas-image-output-size";
import { absoluteMediaUrl } from "@/lib/canvas-media-url";
import type {
  CanvasChatMessage,
  CanvasMediaImage,
  CanvasMediaVideo,
  CanvasScene,
  CanvasSceneData,
  CanvasSkill,
  ChatAttachment,
} from "@/types/canvex";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/excalidraw/element/types";

import { ChatOverlay, type ChatOverlayStatus } from "@/components/canvas/ChatOverlay";
import { FloatingAdjustPanel, ImageEditBar } from "@/components/canvas/ImageEditBar";

const SAVE_DEBOUNCE_MS = 1500;
const STATUS_FADE_MS = 2500;

// Canvas product policy, forced into every scene's appState by buildInitialData
// on load (so they win over stale values older autosaves persisted):
//   - Figma/Lovart-style object snapping (alignment guides + equal-gap hints +
//     edge/center 吸附) is always on. Hold Ctrl/⌘ to suspend it mid-drag.
//   - new text defaults to 64px (a custom size above Excalidraw's largest preset, XL=36).
// The `<Excalidraw objectsSnapModeEnabled>` prop below is a now-redundant seed
// kept as a harmless fallback. Forcing currentItemFontSize only sets the size of
// NEWLY-created text — existing text elements keep their own fontSize.
const FORCE_OBJECTS_SNAP = true;
const DEFAULT_TEXT_FONT_SIZE = 64;
// Canvas paper color = 页面 --background (纯白). Forced into appState below (wins
// over any viewBackgroundColor older autosaves persisted; Excalidraw's native bg
// picker is hidden, so this is the only knob).
const CANVAS_BG_COLOR = "#ffffff";

// `idle` = scene 刚加载没动作过, 不渲染 pill; 其他四态显示对应 label + 配色.
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

// 所有状态共用同一磨砂胶囊底。注意: 当前 pending/saving/error 文字都是橙 (--destructive
// 暂 = --primary), 只有 saved 是灰 —— 颜色不再区分各态, 区分靠下方 SAVE_STATUS_LABEL 文案。
const SAVE_STATUS_CHROME = "border-border/60 bg-frost ring-1 ring-black/8";
const SAVE_STATUS_TEXT: Record<Exclude<SaveState, "idle">, string> = {
  pending: "text-primary",
  saving: "text-primary",
  saved: "text-muted-foreground",
  error: "text-destructive",
};
// The non-idle SaveState values are exactly the sub-keys under
// `workspace.saveStatus.*`, so the label resolves directly via
// t(`workspace.saveStatus.${saveState}`) — no lookup table needed.

// Tool results include a confirmation string like
//   "Image generation queued (job_id=<UUID>, n=1). …"
// We pluck the UUID out so we know which job to poll for the final asset URL.
const JOB_ID_PATTERN = /job_id=([0-9a-fA-F-]{36})/;

// Mirror backend's `enqueue_image_generation` clamp (1..4) so args.n=10 /
// negative / NaN all collapse the same way. Video / angle don't take `n`.
// Keep in sync with `backend/apps/canvas/services/agent/tools/image.py` —
// if the backend cap changes, frontend silently under-reserves and surplus
// results fall through to the spillover pinImage stack (graceful degradation,
// but slot count won't match user's request).
const IMAGE_MAX_N = 4;
function placeholderCountForToolCall(
  kind: JobKind,
  args: Record<string, unknown> | undefined,
): number {
  if (kind !== "image") return 1;
  const raw = args?.n;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(IMAGE_MAX_N, Math.floor(n));
}

// Markdown image syntax: `![alt](https://...)`. Some provider proxies (e.g.
// tu-zi.com) embed image generation inline into the chat completion rather
// than exposing a separate tool — the model's final reply just includes
// markdown image URLs. We pin those as a fallback to the proper tool_call
// path so the UX works on both provider shapes.
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;

// Maps the agent's tool name → which job endpoint/pin path handles its result.
// Add a row here when wiring a new agent tool that produces a canvas-pinnable
// asset; avoids hardcoding tool-name strings at each dispatch site.
const TOOL_TO_JOB_KIND: Record<string, JobKind> = {
  generate_image: "image",
  generate_video: "video",
};

// 左下角浮动按钮 (Back-to-latest, Map) 共用样式 + 几何:
//   bottom-[21px] = chat input (顶 16 + 高 42, 中心 37) - button 32 / 2 = 21
//   left 步进: 16 (起始) → +32 (button) +8 (gap) = 56 → 96 ...
// mobile bar 出现时 CSS sibling selector 把按钮顶到 bottom: 61, 见 index.css.
const FLOATING_BTN_BASE = "absolute bottom-[21px] z-50 rounded-md border shadow-lg backdrop-blur ring-1 ring-black/8";
const FLOATING_BTN_HOVER = "hover:bg-ember hover:text-primary-foreground";

function extractMarkdownImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    urls.push(m[1]);
  }
  return urls;
}

/** Append a chat message to the transcript, skipping it if its id is already
 *  present (stream can re-emit; history may already hold it). */
function appendUniqueMessage(
  prev: CanvasChatMessage[],
  message: CanvasChatMessage,
): CanvasChatMessage[] {
  return prev.some((m) => m.id === message.id) ? prev : [...prev, message];
}

/**
 * Excalidraw's `appState.collaborators` is a `Map` at runtime; JSON round-trip
 * turns it into `{}`, and Excalidraw's internal `.forEach` then throws. Strip
 * it on the way out to storage — Excalidraw re-seeds an empty Map when missing
 * on rehydrate.
 */
function sanitizeAppState(
  appState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!appState) return {};
  if (!("collaborators" in appState)) return appState;
  const rest = { ...appState };
  delete rest.collaborators;
  return rest;
}

type InitialData = Parameters<typeof Excalidraw>[0]["initialData"];

/** Resolve the display URL of a single-image selection: chat-pinned CDN URL,
 *  or dataURL fallback for client-rasterized blobs (Merge-flattened images). */
function resolveImageSourceUrl(
  selection: CanvasSelection,
  api: ExcalidrawImperativeAPI | null,
): string | null {
  if (selection.kind !== "single-image") return null;
  if (selection.sourceUrl) return selection.sourceUrl;
  if (!api || !selection.fileId) return null;
  return api.getFiles()[selection.fileId]?.dataURL ?? null;
}

function buildInitialData(data: unknown): InitialData {
  // Always seed appState (even for a brand-new scene, whose data is `{}`) so the
  // forced product defaults below apply on first load too — there's no
  // `<Excalidraw>` prop for the font-size default the way there is for snapping.
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    elements: record.elements ?? [],
    appState: {
      ...sanitizeAppState(record.appState as Record<string, unknown> | undefined),
      // Forced AFTER the saved-appState spread so they override any stale value
      // older autosaves persisted (see FORCE_OBJECTS_SNAP / DEFAULT_TEXT_FONT_SIZE).
      objectsSnapModeEnabled: FORCE_OBJECTS_SNAP,
      currentItemFontSize: DEFAULT_TEXT_FONT_SIZE,
      viewBackgroundColor: CANVAS_BG_COLOR,
    },
    files: record.files,
  } as InitialData;
}

/**
 * Top-level Canvex workspace. Single-route (`/`): the active scene is held in
 * local state (no router param) and driven by the in-page CanvasSidebar's
 * select / create / delete actions. Renders the sidebar + the canvas pane.
 */
export default function CanvexWorkspacePage() {
  // 当前 scene 由 sidebar 选择驱动 —— 不走路由参数 (Canvex 单页)。
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  return (
    <div className="flex h-screen min-h-0">
      <CanvasSidebar
        activeSceneId={activeSceneId}
        onSelectScene={setActiveSceneId}
        onSceneCreated={setActiveSceneId}
        onSceneDeleted={() => setActiveSceneId(null)}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeSceneId ? (
          // key 强制 scene 切换时整棵 CanvasArea 重挂载, 干净重置所有 ref /
          // Excalidraw 实例 —— 比手动收口每个 ref 可靠。
          <CanvasArea key={activeSceneId} sceneId={activeSceneId} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

interface CanvasAreaProps {
  sceneId: string;
}

function CanvasArea({ sceneId }: CanvasAreaProps) {
  const { t } = useTranslation("canvasUi");
  // Always-current `t` for use inside effects that must NOT re-run on language
  // change (react-i18next returns a new `t` ref each `languageChanged`). Without
  // this, the scene-load effect below would list `t` in its deps and a language
  // toggle mid-stream would abort the live reply + job polls and wipe the chat.
  const tRef = useRef(t);
  tRef.current = t;
  // Keep Excalidraw's own native UI (crop hints, context menus) in sync with the
  // app language toggle.
  const { lang } = useLanguageToggle();
  const excalidrawLang = excalidrawLangCode(lang);
  const activeSceneId = sceneId;

  const [scene, setScene] = useState<CanvasScene | null>(null);
  // Stable initialData reference. The inline buildInitialData(scene.data) below
  // ran on EVERY render (setExcalidrawTick bumps ~60x/s during any interaction),
  // handing Excalidraw a fresh object each time; re-applying it left the loaded
  // scene non-interactive (selectable but not draggable) until the first local
  // edit committed it — drawing any shape "unstuck" everything.
  //
  // Keyed on scene.id (not the scene object) to mirror Excalidraw's own
  // `key={scene.id}` remount — initialData is consumed once per scene, so a
  // future post-load setScene with the same id can't churn this reference and
  // re-break interactivity.
  const initialData = useMemo(
    () => (scene ? buildInitialData(scene.data) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per-scene-id mount-only data
    [scene?.id],
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // ── chat stream state ─────────────────────────────────────────────────────
  const [isStreaming, setIsStreaming] = useState(false);
  // Chat transcript shown in the frame-anchored ChatFrameOverlay (no longer
  // pinned to the canvas as text). Loaded from history on scene mount, appended
  // during streaming.
  const [chatMessages, setChatMessages] = useState<CanvasChatMessage[]>([]);
  // Live assistant text accumulated from `assistant_delta` tokens (typewriter).
  // Cleared the moment the persisted `assistant` message lands (same React batch,
  // so the live bubble swaps to the real one with no flicker).
  const [streamingText, setStreamingText] = useState("");
  // True once the persisted `assistant` arrived: the typewriter should finish
  // dripping its remaining text, then swap in the persisted bubble.
  const [streamFinalizing, setStreamFinalizing] = useState(false);
  // AIMessageChunk id of the delta run currently accumulating — when it changes
  // (a fresh assistant segment after a tool call), the buffer resets.
  const streamDeltaIdRef = useRef<string | null>(null);
  // Persisted assistant message held until the typewriter catches up, so the
  // live bubble and the final bubble swap with identical text (no jump).
  const pendingAssistantRef = useRef<CanvasChatMessage | null>(null);
  // Single reset for all streaming state. `commitPending` first flushes a held
  // persisted message into the transcript — used both when the typewriter settles
  // and when a new turn starts before the previous one finished, so a fast
  // re-submit never silently drops the prior reply.
  const resetStream = useCallback((commitPending: boolean) => {
    const pending = pendingAssistantRef.current;
    pendingAssistantRef.current = null;
    if (commitPending && pending) {
      setChatMessages((prev) => appendUniqueMessage(prev, pending));
    }
    setStreamingText("");
    setStreamFinalizing(false);
    streamDeltaIdRef.current = null;
  }, []);
  // Typewriter reached the full text AND a reply is finalizing → commit the
  // persisted bubble + clear the live one in one batch.
  const handleStreamSettled = useCallback(() => resetStream(true), [resetStream]);
  const [chatStatus, setChatStatus] = useState<ChatOverlayStatus | null>(null);
  const [toolBadge, setToolBadge] = useState<string | null>(null);
  // Skills loaded this turn — sniffed from read_file tool_calls via
  // skillSlugFromToolCall, surfaced as pills next to the Thinking indicator.
  const [skillBadges, setSkillBadges] = useState<string[]>([]);
  // 全局 skill list — agent 当前加载了哪些 skill, 让 ChatOverlay 渲染选择 popover.
  // 拉一次就 cache (skills 是后端进程级常量, 改 SKILL.md 要重启 web service);
  // 失败时静默吞错误 + skills 留空 → SkillSelector 不渲染, UI 等价于关闭该特性,
  // 不阻塞 chat 主流程
  const [skills, setSkills] = useState<CanvasSkill[]>([]);
  // Per-message canvas image attachments queued for the next chat turn.
  // Filled by ImageEditBar's "Send to chat" button; rendered as chips above
  // the textarea; cleared after every successful send. Per-message ephemeral
  // (matches disabledSkills lifetime).
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showMinimap, setShowMinimap] = useState(false);
  // Bump 每次 Excalidraw 写入新 api —— 给 Minimap 一个 effect dep, 比靠 ref
  // 时序猜测可靠 (scene 切换 + StrictMode + HMR 多次重 mount, ref 反复换).
  const [apiVersion, setApiVersion] = useState(0);
  // Bumped on every Excalidraw onChange tick; MockupOverlay needs to re-read
  // live API state (viewport + element positions) every change.
  const [excalidrawTick, setExcalidrawTick] = useState(0);

  const latestDataRef = useRef<CanvasSceneData>({});
  // Content hash `length:versionSum:fileCount` —— element.version 只在真实改动
  // 时 bump, pan/zoom/cursor 不影响, mount 时 Excalidraw 多 fire 同内容也认得.
  // null = 没 baseline, scene 加载后第一次 onChange 只播 seed 不 PATCH.
  const handleChangeHashRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Scene-lifetime abort — kills in-flight polls when user navigates away. Kept
  // separate from streamAbortRef so that re-submitting chat (which aborts the
  // stream) doesn't kill background polls that should finish pinning.
  const sceneAbortRef = useRef<AbortController | null>(null);
  const statusFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // De-dupe job polls across the scene's lifetime: a duplicate tool_result
  // (retry, replay, etc.) would otherwise fire a second waitForCanvasJob loop
  // hammering the API every 2s until it saw the same SUCCEEDED row.
  const polledJobIdsRef = useRef<Set<string>>(new Set());

  // Mockup drop detection: track which image element was most recently
  // modified (drag, resize, anything that bumps element.version). On
  // pointerup over the receiving base, that's our design candidate.
  // Per-element version map detects modification; recent ref records the
  // last touched non-base image. Stale entries (>1s) are discarded at use.
  const lastImageVersionsRef = useRef<Map<string, number>>(new Map());
  const recentlyTouchedImageRef = useRef<{ id: string; ts: number } | null>(null);
  // Container ref for pointer → world coord conversion (need the canvas
  // pane's bounding rect to subtract page offset).
  const canvasPaneRef = useRef<HTMLDivElement>(null);

  // Load skill registry once. Skills are process-level constants on the
  // backend; refetching per scene would be wasted bandwidth. Failure path:
  // log + empty list → SkillSelector renders nothing (feature gracefully
  // hides instead of breaking chat).
  useEffect(() => {
    let cancelled = false;
    canvasService
      .listSkills()
      .then((resp) => {
        if (!cancelled) setSkills(resp.data);
      })
      .catch((err) => {
        // 静默 — 拉 skill 失败不阻塞 chat 主流程, 只是没法用 SkillSelector
        console.warn("[canvas] failed to load skill list", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pinning = useCanvasPinning(excalidrawApiRef);
  const {
    ensureChatFrame,
    pinImage,
    pinVideo,
    createPlaceholder,
    markPlaceholderFailed,
    markPlaceholdersFailed,
    replacePlaceholderWithImage,
    replacePlaceholderWithVideo,
    reset: resetPinning,
    resetPackRow,
  } = pinning;

  // 素材库面板挂在这里 (而非外层 CanvasSidebar 所在组件) —— 插入要用本组件的
  // pinImage/pinVideo + 当前 sceneId。侧栏按钮发 window 事件, 这里接住打开。
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  useEffect(() => {
    const open = () => setMediaLibraryOpen(true);
    window.addEventListener(CANVAS_OPEN_MEDIA_LIBRARY_EVENT, open);
    return () => window.removeEventListener(CANVAS_OPEN_MEDIA_LIBRARY_EVENT, open);
  }, []);
  // 库里的 url 跟生成结果同形 (图片相对 /media, 视频 provider 外链), 原样交给
  // pinImage/pinVideo —— 内部 fetchAsBlob 自己补 base / 透传; dedupKey 用 id 防重复 pin。
  const handleInsertLibraryImage = useCallback(
    (item: CanvasMediaImage) => pinImage({ url: item.url, dedupKey: item.asset_id }),
    [pinImage],
  );
  const handleInsertLibraryVideo = useCallback(
    (item: CanvasMediaVideo) => pinVideo({ videoUrl: item.url, dedupKey: item.job_id }),
    [pinVideo],
  );

  const { selection, update: updateSelection } = useCanvasSelection();
  const { previewUrls } = useSelectionPreview(selection, excalidrawApiRef);
  const imageEdit = useImageEdit({
    sceneId: activeSceneId,
    excalidrawApiRef,
    pinning,
    sceneAbortRef,
  });
  const videoEdit = useVideoEdit({
    sceneId: activeSceneId,
    excalidrawApiRef,
    pinning,
    sceneAbortRef,
  });
  const angleEdit = useAngleEdit({
    sceneId: activeSceneId,
    excalidrawApiRef,
    pinning,
    sceneAbortRef,
  });
  const splitEdit = useSplit({
    sceneId: activeSceneId,
    excalidrawApiRef,
    pinning,
    sceneAbortRef,
  });
  const mergeLayer = useMergeLayer({
    excalidrawApiRef,
    pinMergedImage: pinning.pinMergedImage,
  });
  const mockup = useMockup({ excalidrawApiRef });
  const imageAdjust = useImageAdjust({ excalidrawApiRef });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const { jumpToLatest } = useBackToLatest(excalidrawApiRef);
  // Image import (drop / paste / toolbar image tool / "9"): upload original →
  // pin full-res URL-backed, bypassing Excalidraw's resize-to-1440. Toolbar /
  // paste enter cursor-follow placement (the ghost overlay below); drop lands at
  // the drop point.
  const {
    placement: imagePlacement,
    placeAt: placeImageAt,
    cancelPlacement: cancelImagePlacement,
  } = useCanvasImageImport({
    paneRef: canvasPaneRef,
    excalidrawApiRef,
    sceneId: activeSceneId,
    pinImage,
  });

  // 页面级压掉 macOS 双指横滑返回手势(覆盖画布 + 侧栏 + overlay); 细节见 hook 文档。
  useSuppressSwipeNav();

  // Mockup binding on the currently selected base (single-image selections only).
  // Drives the four-state MockupPanel.
  const selectedBinding =
    selection?.kind === "single-image" ? getMockupBinding(selection.image) : null;
  // Adjust binding on the selected base — neutral default so the panel can edit
  // an image with no binding yet (created lazily on first non-zero change).
  // Only read/allocate the binding when the panel is actually open — getAdjustBinding
  // re-spreads nested objects, and selection identity churns every tick.
  const selectedAdjustBinding =
    adjustOpen && selection?.kind === "single-image"
      ? getAdjustBinding(selection.image) ?? DEFAULT_ADJUST_BINDING
      : null;
  const selectedImageId = selection?.kind === "single-image" ? selection.image.id : null;
  // Close the floating Adjust panel when the selected image changes / deselects —
  // opening is per-image-intentional via the toolbar's 调整 button.
  useEffect(() => {
    setAdjustOpen(false);
  }, [selectedImageId]);
  // Screen rect of the selected image, for anchoring the floating panel to its
  // right (excalidrawTick drives pan/zoom re-renders so this stays in sync).
  const adjustAnchorRect = (() => {
    if (!adjustOpen || selection?.kind !== "single-image") return null;
    const api = excalidrawApiRef.current;
    if (!api) return null;
    const a = api.getAppState();
    const zoom = a.zoom?.value ?? 1;
    const scrollX = a.scrollX ?? 0;
    const scrollY = a.scrollY ?? 0;
    return elementScreenRect(selection.image, { zoom, scrollX, scrollY });
  })();
  const isReceivingSelected =
    selection?.kind === "single-image" && selection.image.id === mockup.receivingBaseId;
  const selectedDepthStatus =
    selection?.kind === "single-image" ? mockup.depthStatusFor(selection.image.id) : "idle";

  // Esc cancels receiving mode (the ring is sticky — it doesn't auto-exit on
  // selection change so the user can pick a different image to drag onto the
  // base — so we need a global keyboard escape hatch).
  useEffect(() => {
    if (!mockup.receivingBaseId) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") mockup.exitReceiving();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [mockup]);

  // Drop detection: when the user releases pointer in receiving mode AND a
  // non-base image was recently moved AND the cursor is inside the base bbox,
  // bind. The "recently moved image" signal is maintained by handleExcalidraw
  // Change tracking element.version increments per image.
  useEffect(() => {
    const baseId = mockup.receivingBaseId;
    if (!baseId) return;
    const handlePointerUp = (e: PointerEvent) => {
      const api = excalidrawApiRef.current;
      const pane = canvasPaneRef.current;
      if (!api || !pane) return;
      const recent = recentlyTouchedImageRef.current;
      if (!recent) return;
      // Stale guard: a months-old recentlyTouched ref shouldn't bind if the
      // user happens to click on the base. 1s window covers any reasonable
      // drag-drop interval; anything older is unrelated.
      if (Date.now() - recent.ts > 1000) return;
      if (recent.id === baseId) return;
      const elements = api.getSceneElements();
      const base = elements.find(
        (el) => el.id === baseId && el.type === "image" && !el.isDeleted,
      ) as ExcalidrawImageElement | undefined;
      const design = elements.find(
        (el) => el.id === recent.id && el.type === "image" && !el.isDeleted,
      ) as ExcalidrawImageElement | undefined;
      if (!base || !design || !design.fileId) return;
      // Pointer page coords → world.
      const appState = api.getAppState();
      const { x: worldX, y: worldY } = screenPointToWorld(
        { clientX: e.clientX, clientY: e.clientY },
        pane.getBoundingClientRect(),
        { zoom: appState.zoom?.value ?? 1, scrollX: appState.scrollX ?? 0, scrollY: appState.scrollY ?? 0 },
      );
      if (worldX < base.x || worldX > base.x + base.width) return;
      if (worldY < base.y || worldY > base.y + base.height) return;
      // Only bind if depth is ready — otherwise the visual would have no
      // surface to project onto.
      if (mockup.depthStatusFor(baseId) !== "ready") return;
      const anchor = worldPointToBaseUv(base, worldX, worldY);
      mockup.bindDesignToBase({
        baseId,
        designId: design.id,
        designFileId: design.fileId,
        anchor,
      });
      recentlyTouchedImageRef.current = null;
    };
    document.addEventListener("pointerup", handlePointerUp);
    return () => document.removeEventListener("pointerup", handlePointerUp);
  }, [mockup]);

  useEffect(() => {
    // CanvasArea is keyed by sceneId at the parent — mount === new scene, so
    // activeSceneId is always non-null here. One AbortController per scene for
    // any polls kicked off during this scene's lifetime; the stream aborts
    // independently via streamAbortRef.
    let cancelled = false;
    sceneAbortRef.current = new AbortController();
    polledJobIdsRef.current.clear();
    setLoading(true);
    setLoadError(null);
    setChatMessages([]);
    (async () => {
      try {
        const { data } = await canvasService.retrieveScene(activeSceneId);
        if (cancelled) return;
        // Hydrate before setScene so Excalidraw's first paint has the dataURLs
        // ready (no broken-image flash).
        const hydrated = await hydrateUrlBackedFiles(data.data || {});
        if (cancelled) return;
        setScene({ ...data, data: hydrated });
        latestDataRef.current = hydrated;
        handleChangeHashRef.current = null;
        setSaveState("idle");
        resetPinning();
        // Chat history → frame-anchored panel (best-effort; non-critical to load).
        // Merge (don't replace): if a slow history response lands AFTER the user
        // already sent a message this session, keep those just-streamed messages
        // (appended to `live`) instead of clobbering them with stale history.
        canvasService
          .listChat(activeSceneId, 50)
          .then(({ data: history }) => {
            if (cancelled) return;
            setChatMessages((live) => {
              const ids = new Set(history.map((m) => m.id));
              return [...history, ...live.filter((m) => !ids.has(m.id))];
            });
          })
          .catch(() => {
            /* leave the panel empty — chat history is non-critical */
          });
      } catch (err) {
        if (cancelled) return;
        setLoadError(extractApiError(err, tRef.current("workspace.error.loadFailed")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Runs on unmount (scene switch remounts via key) — React calls effect
    // cleanups on unmount, so this is our single teardown path.
    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (statusFadeTimerRef.current) {
        clearTimeout(statusFadeTimerRef.current);
        statusFadeTimerRef.current = null;
      }
      // Abort in-flight stream + polls on scene switch — otherwise their pin
      // callbacks would fire against the wrong scene's canvas.
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      sceneAbortRef.current?.abort();
      sceneAbortRef.current = null;
    };
    // `t` intentionally NOT a dep (we read it via tRef) — re-running this
    // scene-load effect on a language toggle would abort the live stream + wipe
    // the chat. eslint is satisfied because tRef.current isn't reactive.
  }, [activeSceneId, resetPinning]);

  const performSave = useCallback(async () => {
    if (!scene) return;
    // Sanitize only at save time — Excalidraw onChange fires on every pan /
    // zoom / cursor move, and we don't want to allocate per tick just so the
    // final 1.5s-debounced save can see a clean appState.
    const raw = latestDataRef.current as Record<string, unknown>;
    // onChange's `elements` arg is filtered to non-deleted, but the Mockup
    // feature relies on isDeleted source design elements surviving save
    // (so detach/undo can revive them). Pull the unfiltered list here.
    const api = excalidrawApiRef.current;
    const elementsForSave = api?.getSceneElementsIncludingDeleted() ?? raw.elements;
    const payload = stripHydratableFiles({
      ...raw,
      elements: elementsForSave,
      appState: sanitizeAppState(raw.appState as Record<string, unknown> | undefined),
    });
    setSaveState("saving");
    try {
      await canvasService.updateScene(activeSceneId, {
        title: scene.title,
        data: payload,
      });
      setSaveState("saved");
    } catch (err) {
      // 不 toast: 持久 red pill 已够; 连续失败一帧一个 toast 会刷屏.
      console.warn("CanvexWorkspacePage: autosave failed", err);
      setSaveState("error");
    }
  }, [activeSceneId, scene]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void performSave();
    }, SAVE_DEBOUNCE_MS);
  }, [performSave]);

  // Stable callback for Excalidraw's `excalidrawAPI` prop — inline arrow
  // recreates per render and (depending on Excalidraw's internal effect deps)
  // can cascade into a setState loop with sibling state updates.
  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawApiRef.current = api;
    setApiVersion((v) => v + 1);
  }, []);

  const handleExcalidrawChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      // Selection tracking runs on every tick (incl. pan/zoom) — toolbar has
      // to follow the element. Internal fingerprint dedup keeps it cheap.
      updateSelection(
        elements as readonly ExcalidrawElement[],
        appState,
      );
      // Drive MockupOverlay re-renders on every tick — it needs to follow
      // viewport + element movement. setState batching keeps this cheap;
      // the inline-arrow excalidrawAPI prop loop trap is fixed via
      // handleExcalidrawApi useCallback.
      setExcalidrawTick((t) => t + 1);
      // Mockup drop detection: track per-image version increments so the
      // pointerup listener can identify the most recently dragged image.
      // O(N) per tick over images only; selection bookkeeping already pays
      // a similar cost.
      const lastVersions = lastImageVersionsRef.current;
      const seen = new Set<string>();
      for (const raw of elements) {
        const el = raw as ExcalidrawElement;
        if (el.type !== "image" || el.isDeleted) continue;
        seen.add(el.id);
        const last = lastVersions.get(el.id);
        if (last !== undefined && el.version !== last) {
          recentlyTouchedImageRef.current = { id: el.id, ts: Date.now() };
        }
        lastVersions.set(el.id, el.version);
      }
      // Drop entries for images that disappeared (deleted, scene switch) so
      // the map doesn't grow unbounded across the scene's lifetime.
      for (const id of lastVersions.keys()) {
        if (!seen.has(id)) lastVersions.delete(id);
      }
      // 廉价 content fingerprint: count + version 总和 + file count.
      // element.version 在真改动时 bump, pan/zoom/cursor 不动 — 同时去掉 viewport
      // tick 跟 mount-时多 fire 同内容. hash 相等 = 没什么值得 save.
      let versionSum = 0;
      for (const raw of elements) {
        versionSum += (raw as { version?: number }).version ?? 0;
      }
      const fileCount =
        typeof files === "object" && files !== null
          ? Object.keys(files).length
          : 0;
      const quickHash = `${elements.length}:${versionSum}:${fileCount}`;
      const prevHash = handleChangeHashRef.current;
      if (prevHash === quickHash) return;
      handleChangeHashRef.current = quickHash;
      // 加载后第一次 onChange 只 seed baseline — Excalidraw mount-时一阵不同
      // array ref 但同内容的 fire, 不该 PATCH 一个没动过的 scene.
      if (prevHash === null) return;
      // Stash raw refs; performSave strips appState.collaborators before POSTing
      // so we avoid the per-tick allocation.
      latestDataRef.current = { elements, appState, files } as CanvasSceneData;
      setSaveState("pending");
      scheduleSave();
    },
    [scheduleSave, updateSelection],
  );

  const showTransientStatus = useCallback(
    (next: ChatOverlayStatus) => {
      if (statusFadeTimerRef.current) clearTimeout(statusFadeTimerRef.current);
      setChatStatus(next);
      statusFadeTimerRef.current = setTimeout(() => {
        setChatStatus(null);
      }, STATUS_FADE_MS);
    },
    [],
  );

  /** Poll a queued image/video job and pin the result to canvas on SUCCEEDED.
   *  Fire-and-forget — runs independently of the chat stream so long-running
   *  video generation (1-5 min) doesn't block the chat UI.
   *
   *  `placeholders` is the array of pre-reserved slots (empty = markdown-
   *  fallback path with no on-canvas surface; length-1 = toolbar / resume;
   *  length-N = chat n>1 reservation). Index-paired replacement happens in
   *  `pinCanvasJobResult`; this function only owns dedup + error tombstones. */
  const pollAndPinJob = useCallback(
    async (kind: JobKind, jobId: string, placeholders: PinPlaceholder[]) => {
      if (polledJobIdsRef.current.has(jobId)) return;
      polledJobIdsRef.current.add(jobId);
      const signal = sceneAbortRef.current?.signal;
      try {
        const job = await waitForCanvasJob(kind, jobId, { signal });
        if (signal?.aborted) return;
        const result = await pinCanvasJobResult(kind, job, jobId, placeholders, {
          markPlaceholdersFailed, replacePlaceholderWithImage, replacePlaceholderWithVideo, pinImage, pinVideo,
        });
        // No placeholder = markdown-fallback path with no on-canvas surface;
        // toast the failure so user knows the inline-image rendering failed.
        if (!result.ok && placeholders.length === 0) {
          toast.error(t("workspace.toast.generationFailed", { kind: t(`workspace.kindNames.${kind}`), reason: result.reason }));
        }
      } catch (err) {
        // AbortError from scene switch = expected, stay quiet
        if ((err as DOMException)?.name === "AbortError") return;
        const reason = extractApiError(err, t("workspace.tombstone.pollingFailed"));
        if (placeholders.length > 0) {
          markPlaceholdersFailed(placeholders, reason);
        } else {
          toast.error(extractApiError(err, t("workspace.toast.jobPollingFailed", { kind: t(`workspace.kindNames.${kind}`) })));
        }
      }
    },
    [markPlaceholdersFailed, pinImage, pinVideo, replacePlaceholderWithImage, replacePlaceholderWithVideo, t],
  );

  useResumeCanvasJobs({
    sceneId: activeSceneId,
    scene, apiVersion, excalidrawApiRef,
    pollAndPinJob, markPlaceholderFailed, createPlaceholder,
  });

  // "Send to chat" handler bound on ImageEditBar's icon button. Pushes a
  // ChatAttachment for the currently-selected single image into the queue
  // (dedup by URL — clicking twice on the same image is a no-op so the
  // user doesn't accumulate identical chips). Multi-image / image-with-shapes
  // selections aren't supported in v1 because their preview URLs are local
  // blob:// URLs the agent backend can't fetch; user can Merge → flatten
  // to a CDN-pinned single image first if they want those in chat.
  const handleSendSelectionToChat = useCallback(
    async (selectionForSend: CanvasSelection, sourceUrl: string) => {
      if (selectionForSend.kind !== "single-image") return;
      try {
        // Root-relative `/media/...` (media-library inserts, job results) points
        // at an already-persisted asset — absolutize to the same shape the upload
        // round-trip returns so it takes the direct-attach branch. The backend
        // maps any our-media URL (even an unreachable localhost one) back to
        // storage and inlines it, so it's directly attachable; re-uploading via
        // fetch("/media/...") would instead hit the Vite SPA fallback (no /media
        // proxy) and upload index.html → backend PIL "cannot identify image".
        const resolvedUrl = absoluteMediaUrl(sourceUrl);
        // http(s) URL = already public CDN (chat-pinned or agent-generated) or an
        // absolutized our-media asset — attach directly. blob:/data: URL =
        // locally-uploaded into Excalidraw, needs round-trip through backend to
        // get a fetchable CDN URL because the agent + image provider can't fetch
        // browser-local URLs.
        let attachment: ChatAttachment;
        if (resolvedUrl.startsWith("http://") || resolvedUrl.startsWith("https://")) {
          const { width, height } = selectionForSend.image;
          attachment = { url: resolvedUrl, width, height };
        } else {
          // fetch() works for both blob: and data: URLs in the browser
          const blob = await fetch(resolvedUrl).then((r) => r.blob());
          const file = new File(
            [blob],
            `canvas-attachment-${Date.now()}.${blob.type.split("/")[1] || "png"}`,
            { type: blob.type },
          );
          const resp = await canvasService.uploadAttachment(activeSceneId, file);
          attachment = resp.data;
        }
        setAttachments((prev) => {
          if (prev.some((a) => a.url === attachment.url)) return prev;
          return [...prev, attachment];
        });
      } catch (err) {
        toast.error(extractApiError(err, t("workspace.toast.attachFailed")));
      }
    },
    [activeSceneId, t],
  );

  const handleRemoveAttachment = useCallback((url: string) => {
    setAttachments((prev) => prev.filter((a) => a.url !== url));
  }, []);

  // Stop button: abort the in-flight chat stream. The for-await in
  // handleChatSubmit rejects with AbortError → its catch returns quietly and the
  // finally tears down (drops the partial reply, clears the typewriter).
  const handleStopStream = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);

  const handleChatSubmit = useCallback(
    async (
      content: string,
      disabledSkills: string[],
      attachments: ChatAttachment[],
    ) => {
      // Abort any in-flight stream before starting a new one — can happen if the
      // previous stream is still draining and the user hits send again quickly
      streamAbortRef.current?.abort();
      const abort = new AbortController();
      streamAbortRef.current = abort;

      // Stream-local state. Kept off refs so two back-to-back chats can't leak
      // entries into each other's dispatch and can't race on clear(). For n>1
      // image generation the agent reserves N slots so the user sees N
      // "Generating image…" boxes; `pinAssetResultRows` zips them with results
      // by index. Leftovers (tool_call with no matching tool_result = agent
      // aborted mid-call) get tombstoned in `finally`.
      const pendingCalls = new Map<
        string,
        { kind: JobKind; placeholders: PinPlaceholder[] }
      >();

      setIsStreaming(true);
      setChatStatus(null);
      setToolBadge(null);
      // Flush any prior pending reply before starting a new turn (fast re-submit).
      resetStream(true);
      // Make sure the scene has a chat frame for the panel to anchor to (created
      // on the first message; no-op thereafter). Recreates it if the user deleted it.
      ensureChatFrame();
      // Per-message ephemeral: drop attachment chips immediately on send.
      setAttachments(clearIfNonEmpty);
      // Pack-mode 横排状态是 per-turn 的:本轮若不重置, turn-2 的 slot 复用
      // turn-1 的 stale row y, 整套图叠在旧 pack 上面。reset() 只在 scene 切换
      // 时清, 同 scene 内的两次连发不触发, 因此这里显式重置。
      resetPackRow();

      try {
        for await (const event of canvasService.postChatStream(
          activeSceneId,
          content,
          { signal: abort.signal, disabledSkills, attachments },
        )) {
          switch (event.event) {
            case "user_created":
              setChatMessages((prev) => appendUniqueMessage(prev, event.message));
              break;
            case "tool_call": {
              // A tool call ends the current assistant text segment. The persisted
              // reply keeps only the LAST segment (the text after the last tool —
              // last_ai_text), so reset the live buffer here to match; otherwise a
              // "text → tool → text" turn would show the pre-tool text concatenated
              // with the final and then jump on settle.
              setStreamingText("");
              streamDeltaIdRef.current = null;
              // Skill loads route to skillBadges (ember pill); skip the
              // generic read_file toolBadge (an internal mechanic).
              const skillSlug = skillSlugFromToolCall(event.name, event.args);
              if (skillSlug) {
                setSkillBadges((prev) =>
                  prev.includes(skillSlug) ? prev : [...prev, skillSlug],
                );
                break;
              }
              const kind = TOOL_TO_JOB_KIND[event.name];
              if (!kind) {
                // Framework-internal tool — deepagents `task` (subagent
                // dispatch), `write_todos` / `ls` / `write_file` / non-skill
                // `read_file`. User only cares about business tools that
                // produce canvas output; showing the raw framework tool name
                // (e.g. "task" wrench pill) leaks plumbing into the UI and
                // confuses users who expect the skill badge to be the visible
                // label during a skill-driven turn. Skip silently.
                break;
              }
              setToolBadge(event.name);
              const placeholders: PinPlaceholder[] = [];
              const count = placeholderCountForToolCall(kind, event.args);
              // Pack mode (multi-image listing skill): agent 给每个 tool_call
              // 带 slot_index + label, 走横排锚点 + 永久 label 路径; 不带
              // 就是普通 chat 列垂直堆叠 (兼容老 skill / 单图请求)。
              const permanentLabel = toolArgAsString(event.args?.label);
              // slot_index 容忍 string-int ("0") + 拦 NaN/float/负数 — gpt-4o-
              // mini 偶发把整数 arg 序列化成字符串。helper 集中所有 LLM tool-
              // call arg → non-neg int 的 coercion 逻辑, hook 内还有一次防御纵深。
              const slotIndex = toolArgAsNonNegInt(event.args?.slot_index);
              // Reserve a box the size of the image the agent will generate
              // (tier-sized, like the toolbar path). No source image here, so an
              // "auto"/omitted size falls back to 1:1 at the tier. Pack-mode rows
              // also consume this (createPlaceholder sizes the box to the result so
              // pack slots don't overlap); video → undefined.
              const resultSize =
                kind === "image"
                  ? imageEditOutputSize(
                      toolArgAsString(event.args?.size),
                      toolArgAsString(event.args?.resolution),
                      { width: 1, height: 1 },
                    )
                  : undefined;
              for (let i = 0; i < count; i++) {
                const ph = createPlaceholder(
                  kind,
                  t("workspace.placeholder.generating", { kind: t(`workspace.kindNames.${kind}`) }),
                  undefined,
                  permanentLabel !== undefined || slotIndex !== undefined
                    ? { permanentLabel, slotIndex }
                    : undefined,
                  resultSize,
                );
                if (ph) placeholders.push(ph);
              }
              pendingCalls.set(event.id, { kind, placeholders });
              break;
            }
            case "tool_result": {
              // Kick off background poll for the queued job; pin happens minutes
              // later (video) or seconds (image). Scene-scoped AbortController
              // lets the poll survive this stream ending.
              const pending = pendingCalls.get(event.id);
              pendingCalls.delete(event.id);
              const jobId = JOB_ID_PATTERN.exec(event.content)?.[1];
              const placeholders = pending?.placeholders ?? [];
              if (pending && jobId) {
                void pollAndPinJob(pending.kind, jobId, placeholders);
              } else {
                // 区分两种"无 job_id"原因:
                // (1) 后端 tool guard 主动拒了 (返 "Refused: ..." 字符串) —
                //     content 第一行直接是用户应看到的指引 (附 attachment / 用
                //     SKILL),用它当 tombstone reason 比 "job id missing" 友好
                // (2) 真的解析失败 (agent 编了个不带 job_id 的 "queued" 回复)
                //     — 这是 backend/agent bug,用通用 reason 让运维抓到
                const isRefusal = event.content.startsWith("Refused:");
                const reason = isRefusal
                  ? event.content.split("\n")[0].slice(0, 200)
                  : t("workspace.tombstone.jobIdMissing");
                markPlaceholdersFailed(placeholders, reason);
              }
              break;
            }
            case "assistant_delta": {
              // Accumulate tokens into the live bubble; reset only when a new
              // NON-EMPTY message segment id appears (a fresh assistant turn after
              // a tool call). An absent/empty id keeps accumulating — never resets
              // to a single token. Decide BEFORE mutating the ref so the
              // functional update sees the right branch.
              const sameSegment =
                !event.id || event.id === streamDeltaIdRef.current;
              streamDeltaIdRef.current = event.id;
              setStreamingText((prev) =>
                sameSegment ? prev + event.content : event.content,
              );
              break;
            }
            case "canvas_asset":
              // A tool produced an image this turn — drop it
              // onto the board. dedupKey=url so it never double-places with the
              // assistant_final markdown fallback below.
              void pinImage({ url: event.url, dedupKey: event.url }).catch((err) => {
                toast.error(extractApiError(err, t("workspace.toast.loadImageFailed")));
              });
              break;
            case "assistant_final":
              setToolBadge(null);
              setSkillBadges(clearIfNonEmpty);
              // Fallback for providers that inline image gen into chat output —
              // extract markdown image URLs and pin them alongside the text pin.
              for (const url of extractMarkdownImageUrls(event.content)) {
                void pinImage({ url, dedupKey: url }).catch((err) => {
                  toast.error(extractApiError(err, t("workspace.toast.loadImageFailed")));
                });
              }
              break;
            case "assistant":
              // Persisted message lands. Don't swap yet — hold it and point the
              // typewriter at the authoritative full text; the streaming bubble
              // finishes dripping then calls handleStreamSettled to swap it in.
              pendingAssistantRef.current = event.message;
              setStreamingText(event.message.content);
              setStreamFinalizing(true);
              break;
            case "error":
              showTransientStatus({ label: t("workspace.status.replyFailed"), variant: "error" });
              break;
            case "done":
              break;
            default: {
              // Exhaustiveness: if the union grows, TS flags this branch
              const _exhaustive: never = event;
              void _exhaustive;
            }
          }
        }
        // Fell off the stream normally — show success chip briefly
        if (!abort.signal.aborted) {
          showTransientStatus({ label: t("workspace.status.replied"), variant: "success" });
        }
      } catch (err) {
        if (abort.signal.aborted) return; // user-initiated abort, stay quiet
        toast.error(extractApiError(err, t("workspace.toast.chatFailed")));
        showTransientStatus({ label: t("workspace.status.replyFailed"), variant: "error" });
      } finally {
        // Any placeholder still in the map never saw a tool_result (stream
        // aborted / errored / never got that far). Tombstone so the user sees
        // WHY their reserved spot didn't fill.
        for (const { placeholders } of pendingCalls.values()) {
          markPlaceholdersFailed(placeholders, t("workspace.tombstone.streamEnded"));
        }
        // Only the CURRENT turn owns the shared streaming UI state. A turn superseded
        // by a fast re-submit (its `abort` !== the current ref) must NOT touch it.
        if (streamAbortRef.current === abort) {
          streamAbortRef.current = null;
          setIsStreaming(false);
          setToolBadge(null);
          setSkillBadges(clearIfNonEmpty);
          // If a persisted reply is pending, leave the typewriter running — it
          // settles via handleStreamSettled. Only drop the partial text when
          // there was no reply to finalize (error / abort / empty).
          if (!pendingAssistantRef.current) resetStream(false);
        }
      }
    },
    [
      activeSceneId,
      createPlaceholder,
      markPlaceholdersFailed,
      pinImage,
      ensureChatFrame,
                pollAndPinJob,
      resetPackRow,
      resetStream,
      showTransientStatus,
      t,
    ],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" />
        {t("workspace.loading")}
      </div>
    );
  }

  if (loadError || !scene) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-muted-foreground">
        {loadError || t("workspace.error.notFound")}
      </div>
    );
  }

  // Hoisted: computed once per render, used by both ImageEditBar prop AND
  // the onSendToChat handler. Hoisting (vs an IIFE in JSX) keeps Vite Fast
  // Refresh happy — Fast Refresh can't extract a stable component identity
  // through an IIFE-wrapped JSX block, causing full reloads on edit.
  const imageSourceUrl = selection
    ? resolveImageSourceUrl(selection, excalidrawApiRef.current)
    : null;

  return (
    <div ref={canvasPaneRef} data-canvas-pane className="relative min-h-0 flex-1 overflow-hidden">
      <Excalidraw
        key={scene.id}
        langCode={excalidrawLang}
        initialData={initialData}
        excalidrawAPI={handleExcalidrawApi}
        onChange={handleExcalidrawChange}
        // Seeds object snapping for new/empty scenes (see FORCE_OBJECTS_SNAP).
        objectsSnapModeEnabled={FORCE_OBJECTS_SNAP}
      />
      <ChatOverlay
        onSubmit={handleChatSubmit}
        onStop={handleStopStream}
        isStreaming={isStreaming}
        status={chatStatus}
        toolBadge={toolBadge}
        skillBadges={skillBadges}
        skills={skills}
        attachments={attachments}
        onRemoveAttachment={handleRemoveAttachment}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={jumpToLatest}
        title={t("workspace.backToLatest")}
        aria-label={t("workspace.backToLatest")}
        data-back-to-latest
        className={cn(
          FLOATING_BTN_BASE,
          "left-[56px] bg-frost",
          FLOATING_BTN_HOVER,
        )}
      >
        <History className="size-4" strokeWidth={1.5} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setShowMinimap((v) => !v)}
        title={t("workspace.toggleMinimap")}
        aria-label={t("workspace.toggleMinimap")}
        aria-pressed={showMinimap}
        data-minimap-toggle
        // toggle 按钮: active ember 底反映状态; inactive hover 也走 ember,
        // 和 Back-to-latest 保持一致.
        className={cn(
          FLOATING_BTN_BASE,
          "left-4",
          showMinimap
            ? "bg-ember text-primary-foreground"
            : "bg-frost",
          FLOATING_BTN_HOVER,
        )}
      >
        <MapIcon className="size-4" strokeWidth={1.5} />
      </Button>
      <AnimatePresence>
        {showMinimap && (
          // 面板浮在按钮上方 16px gap. mobile bar 显示时按钮 + 面板都上移
          // (CSS sibling override 见 index.css). 入场/退场: 从左下角缩放+淡入。
          <motion.div
            data-minimap-panel
            className="absolute bottom-[69px] left-4 z-50"
            style={{ transformOrigin: "bottom left" }}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <Minimap apiRef={excalidrawApiRef} apiVersion={apiVersion} />
          </motion.div>
        )}
      </AnimatePresence>
      {saveState !== "idle" && (
        // 右下角, y 跟 Back-to-latest / 地图按钮的 bottom-[21px] 同基线 (横向对齐).
        <div
          data-canvas-save-status
          className={cn(
            "pointer-events-none absolute bottom-[21px] right-4 z-40 flex h-8 items-center rounded-md border px-3 text-[11px] shadow-sm backdrop-blur",
            SAVE_STATUS_CHROME,
            SAVE_STATUS_TEXT[saveState],
          )}
        >
          {t(`workspace.saveStatus.${saveState}`)}
        </div>
      )}
      {/* Adjust overlay first (renders below) so a coexisting mockup decal paints
          on TOP of the graded base — matches the download composite order and
          keeps the decal visible (the adjust layer is an opaque full-image quad). */}
      <ImageAdjustOverlay excalidrawApiRef={excalidrawApiRef} tick={excalidrawTick} />
      <CanvasMeasureOverlay
        excalidrawApiRef={excalidrawApiRef}
        selection={selection}
        tick={excalidrawTick}
      />
      <CanvasGeneratingOverlay excalidrawApiRef={excalidrawApiRef} tick={excalidrawTick} />
      <CanvasLandingOverlay excalidrawApiRef={excalidrawApiRef} tick={excalidrawTick} />
      <ChatFrameOverlay
        excalidrawApiRef={excalidrawApiRef}
        tick={excalidrawTick}
        messages={chatMessages}
        streaming={isStreaming}
        streamingText={streamingText}
        streamFinalizing={streamFinalizing}
        onStreamSettled={handleStreamSettled}
      />
      <Mockup3dOverlay
        excalidrawApiRef={excalidrawApiRef}
        paneRef={canvasPaneRef}
        receivingBaseId={mockup.receivingBaseId}
        depthStatusFor={mockup.depthStatusFor}
        tick={excalidrawTick}
        onAnchorChange={mockup.updateAnchor}
        onScaleChange={mockup.updateScale}
        onScaleYChange={mockup.updateScaleY}
        onRotationChange={mockup.updateRotation}
        onRemove={mockup.removeMockup}
        onDetach={mockup.detachDesign}
      />
      {imagePlacement && (
        <CanvasImagePlacementOverlay
          placement={imagePlacement}
          paneRef={canvasPaneRef}
          excalidrawApiRef={excalidrawApiRef}
          onPlace={placeImageAt}
          onCancel={cancelImagePlacement}
        />
      )}
      {selection && (
        <ImageEditBar
          selection={selection}
          imageSourceUrl={imageSourceUrl}
          preview={{ urls: previewUrls }}
          image={{
            isSubmitting: imageEdit.isSubmitting,
            error: imageEdit.error,
            onSubmit: (params) =>
              void imageEdit.submit({ selection, ...params }),
            onDismissError: imageEdit.dismissError,
          }}
          video={{
            isSubmitting: videoEdit.isSubmitting,
            error: videoEdit.error,
            onSubmit: (params) =>
              void videoEdit.submit({ selection, ...params }),
            onDismissError: videoEdit.dismissError,
          }}
          angle={{
            isSubmitting: angleEdit.isSubmitting,
            error: angleEdit.error,
            onSubmit: (params) =>
              void angleEdit.submit({ selection, ...params }),
            onDismissError: angleEdit.dismissError,
          }}
          split={{
            isSubmitting: splitEdit.isSubmitting,
            error: splitEdit.error,
            onSubmit: ({ resolution }) =>
              void splitEdit.submit({ selection, resolution }),
            onDismissError: splitEdit.dismissError,
          }}
          merge={{
            isProcessing: mergeLayer.isProcessing,
            error: mergeLayer.error,
            onSubmit: () => void mergeLayer.merge(selection),
            onDismissError: mergeLayer.dismissError,
          }}
          mockup={{
            binding: selectedBinding,
            isReceiving: isReceivingSelected,
            depthStatus: selectedDepthStatus,
            onEnter: () => {
              if (selection.kind === "single-image") {
                void mockup.enterReceiving(selection.image.id);
              }
            },
            onExit: mockup.exitReceiving,
            onRemove: () => {
              if (selection.kind === "single-image") {
                mockup.removeMockup(selection.image.id);
              }
            },
            onStrengthChange: (strength) => {
              if (selection.kind === "single-image") {
                mockup.updateStrength(selection.image.id, strength);
              }
            },
            onMaskThresholdChange: (threshold) => {
              if (selection.kind === "single-image") {
                mockup.updateMaskThreshold(selection.image.id, threshold);
              }
            },
            onOpacityChange: (opacity) => {
              if (selection.kind === "single-image") {
                mockup.updateOpacity(selection.image.id, opacity);
              }
            },
          }}
          adjust={{ isOpen: adjustOpen, onToggle: () => setAdjustOpen((o) => !o) }}
          onSendToChat={
            // Multi-image / image-with-shapes have blob: preview URLs
            // (rasterized composites, not real source images), so they
            // can't usefully attach. Single-image with any URL works —
            // handleSendSelectionToChat auto-uploads blob:/data: URLs.
            selection.kind === "single-image" && imageSourceUrl
              ? () => handleSendSelectionToChat(selection, imageSourceUrl)
              : undefined
          }
        />
      )}
      {adjustOpen && selectedAdjustBinding && adjustAnchorRect && selectedImageId && (
        <FloatingAdjustPanel
          anchorRect={adjustAnchorRect}
          binding={selectedAdjustBinding}
          onChange={(key, value) => imageAdjust.setValue(selectedImageId, key, value)}
          onBandChange={(band, channel, value) => imageAdjust.setBand(selectedImageId, band, channel, value)}
          onReset={() => imageAdjust.reset(selectedImageId)}
          onAuto={() => imageAdjust.autoEnhance(selectedImageId)}
          onClose={() => setAdjustOpen(false)}
        />
      )}
      <MediaLibrary
        open={mediaLibraryOpen}
        onOpenChange={setMediaLibraryOpen}
        onInsertImage={handleInsertLibraryImage}
        onInsertVideo={handleInsertLibraryVideo}
      />
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation("canvasUi");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">
        {t("workspace.emptyState")}
      </p>
    </div>
  );
}
