import { useCallback, useRef, type RefObject } from "react";
import {
  convertToExcalidrawElements,
  exportToBlob,
  getCommonBounds,
  MIME_TYPES,
  newElementWith,
} from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

import type {
  CanvasAngleJob,
  CanvasImageEditJob,
  CanvasVideoJob,
} from "@/types/canvex";
import { getSelectionElements, type CanvasSelection } from "@/hooks/use-canvas-selection";
import { toolArgAsNonNegInt } from "@/lib/canvas-skill-events";
import { getElementBounds, type ElementBounds } from "@/lib/excalidraw-bounds";
import { getAiChatImageUrl } from "@/lib/excalidraw-custom-data";
import { absoluteMediaUrl } from "@/lib/canvas-media-url";
import {
  CHAT_FRAME_HEIGHT,
  CHAT_FRAME_MARKER,
  CHAT_FRAME_WIDTH,
  findChatFrame,
  isChatNoteElement,
} from "@/lib/canvas-chat-frame";
import {
  BROWSE_LOG_FRAME_HEIGHT,
  BROWSE_LOG_FRAME_MARKER,
  BROWSE_LOG_FRAME_WIDTH,
  BROWSE_LOG_TEXT_KEY,
  BROWSE_LOG_TITLE_KEY,
  findBrowseLogFrame,
  serializeBrowseLog,
} from "@/lib/canvas-browse-log-frame";
import {
  BROWSE_MONITOR_FRAME_HEIGHT,
  BROWSE_MONITOR_FRAME_MARKER,
  BROWSE_MONITOR_FRAME_WIDTH,
  BROWSE_MONITOR_IMAGE_KEY,
  findBrowseMonitorFrame,
} from "@/lib/canvas-browse-monitor-frame";
import {
  ROBOT_STEPS_FRAME_HEIGHT,
  ROBOT_STEPS_FRAME_MARKER,
  ROBOT_STEPS_FRAME_WIDTH,
  ROBOT_STEPS_KEY,
  ROBOT_STEPS_TITLE_KEY,
  findRobotStepsFrame,
  serializeRobotSteps,
} from "@/lib/canvas-robot-steps-frame";
import type { RobotStep } from "@/types/canvex";

/**
 * Pin chat messages / generated assets onto the Excalidraw canvas.
 *
 * Canvex-style UX: 聊天对话渲染在画布上的 chat frame 面板里 (见 ChatFrameOverlay),
 * 不再作为画布上的 note-text 元素堆叠。本 hook 只把生成的资产落到画布: 生成的图片
 * → image 节点, 生成的视频 → 带 link 的 card。依次向下排 (world coord 从 ORIGIN_Y
 * 起步), 落位前扫一遍现有元素避开重叠。
 *
 * - message / asset id 用 ref 去重, 防 React StrictMode 双调用 / 事件重放重复 pin
 * - 切 scene 时要调用 `reset()`, 否则下个 scene 的内容从旧的 y 位置继续堆
 */

const PIN_ORIGIN_X = 80;
const PIN_ORIGIN_Y = 80;
const PIN_GAP = 16;
// 列 x-band 上界 (结构常量, 非文本宽度): 只有左沿落在
// [PIN_ORIGIN_X, PIN_ORIGIN_X+PIN_COLUMN_BAND) 的元素算列内容。列 pin
// (image/placeholder/pack-slot-0) 永远在 x=PIN_ORIGIN_X 落位 (向下走的碰撞搜索
// 不改 x), 故只要 band>0 就全收进来; band 的唯一作用是上界, 把选区右侧的远端锚点 pin
// (x≈1000+) 挡在外。取固定值即可, 值非关键 —— 只需远小于远端锚点区。刻意取固定值,
// 不跟任何 pin 宽度走 (否则 pin 加宽后, 跟随会把右侧锚点 pin 误并入列)。
const PIN_COLUMN_BAND = 320;
// Loading-placeholder status text stays small (16px); its own line height keeps
// the placeholder box height estimate correct.
const PLACEHOLDER_LINE_HEIGHT_PX = 24;
// "Visual units" budget per line — `wrapText` counts CJK chars as 2 units and
// everything else as 1, so the cap mirrors approximate rendered width
// regardless of script. Sized for the 16px placeholder status text: 34 units
// (~272px) keeps a wrapped status / failure line inside the placeholder box.
// Bump down for narrower wrap; up if English-heavy content wraps too eagerly.
const MAX_LINE_UNITS = 34;

const VIDEO_CARD_WIDTH = 300;
const VIDEO_CARD_HEIGHT = 96;
const VIDEO_CARD_STROKE = "#111827";
const VIDEO_CARD_BG = "#f3f4f6";

// Pre-generation placeholder box sizes. Image results get scaled to fit inside
// this square; video card gets centered within the reserved area.
const PLACEHOLDER_IMAGE_DIM = 400;
const PLACEHOLDER_VIDEO_WIDTH = 360;
const PLACEHOLDER_VIDEO_HEIGHT = 200;

// Pack-mode (slot_index 模式): 永久 label 浮在 rect 上方。字号 = 画布默认正文字号
// (跟 canvex-workspace 的 DEFAULT_TEXT_FONT_SIZE 一致, 64px), 否则 2048² 的 slot 上
// 顶一个 14px label 小得几乎看不见。HEIGHT 按一行 64px 文本 (≈fontSize×4/3) 预留,
// 否则 labelPad 低估、label 压到上一行。颜色稍深 (区分: label 是结构, loading 是状态)。
const PACK_LABEL_FONT_SIZE = 64;
const PACK_LABEL_HEIGHT = Math.round((PACK_LABEL_FONT_SIZE * 4) / 3);
const PACK_LABEL_GAP = 8;
const PACK_LABEL_COLOR = "#334155";

// Pack-mode row 找 y 时的"最坏整行宽度"假设. amazon-listing-pack-sop 标准 7 张,
// 是 SkillsMiddleware 框架里唯一已知的 pack skill. 即使 user 改要 3/5 张, 第一
// 个 slot 到达时不知道 total slot count, 用 7 当 worst-case 预留 collision
// footprint —— 多浪费的 y 空间 (实际 3 张时左 4 张位是空的) 换 "绝不与已有
// 元素重叠" 的保证. 未来再加别的 pack skill 时若 slot 数差很大可改成 layout
// 参数显式传 total 进来。
const PACK_ROW_SLOTS = 7;

const PLACEHOLDER_TEXT_COLOR = "#64748b";
const PLACEHOLDER_ERROR_TEXT_COLOR = "#b91c1c";

/** Shared by the pinning flow (dataURL for Excalidraw addFiles) and the
 *  image-edit flow (File for multipart upload). Splits the fetch step so
 *  downstream callers pick the right container shape without a double fetch.
 *  根相对 `/media/...` 经 absoluteMediaUrl 补 api base (前端无 media proxy,
 *  否则按前端源 :5173 解析成 404); data:/blob:/http(s): 原样不动。 */
export async function fetchAsBlob(url: string): Promise<Blob> {
  const target = absoluteMediaUrl(url);
  const resp = await fetch(target);
  if (!resp.ok) throw new Error(`fetch ${target} failed: HTTP ${resp.status}`);
  return resp.blob();
}

/** `exportToBlob` with transparent-background config. `exportScale` bumps the
 *  output PNG's pixel dims (Merge uses this to keep source-image resolution
 *  instead of down-sampling to displayed world-scale). Goes through
 *  `getDimensions` because the blob exporter ignores `appState.exportScale`. */
export async function rasterizeElements(
  elements: ExcalidrawElement[],
  api: ExcalidrawImperativeAPI,
  opts: { exportPadding?: number; exportScale?: number } = {},
): Promise<Blob> {
  const { exportPadding = 0, exportScale = 1 } = opts;
  const appState = api.getAppState();
  return exportToBlob({
    elements,
    appState: {
      exportBackground: false,
      viewBackgroundColor: appState.viewBackgroundColor,
    },
    files: api.getFiles(),
    mimeType: MIME_TYPES.png,
    exportPadding,
    getDimensions: (width: number, height: number) => ({
      width: Math.round(width * exportScale),
      height: Math.round(height * exportScale),
      scale: exportScale,
    }),
  });
}

export async function rasterizeSelection(
  selection: CanvasSelection,
  api: ExcalidrawImperativeAPI,
  opts: { exportPadding?: number } = {},
): Promise<Blob> {
  return rasterizeElements(getSelectionElements(selection), api, { exportPadding: opts.exportPadding });
}

/** Selection kinds that fit a single-source `/image-edit/` upload (one `File`).
 *  multi-image splits into one File per image (provider's multi-URL array)
 *  via `selectionToSourceFiles` —— type-level excluded here so the single
 *  entry point stays well-typed; callers narrow before calling. */
export type SingleSourceSelection = Exclude<CanvasSelection, { kind: "multi-image" }>;

/** Resolve a single-source selection to a `File` for multipart upload.
 *   - single-image → fetch via sourceUrl / fileId dataURL
 *   - image-with-shapes → `rasterizeSelection` burns shape overlays into one
 *     PNG (canvex parity: shapes act as user-drawn editing guidance) */
export async function selectionToSourceFile(
  selection: SingleSourceSelection,
  api: ExcalidrawImperativeAPI,
): Promise<File> {
  if (selection.kind === "single-image") {
    return imageElementToFile(selection.sourceUrl, selection.fileId, api);
  }
  const blob = await rasterizeSelection(selection, api);
  return new File([blob], "selection.png", { type: "image/png" });
}

/** Image-edit source ("plan B"): the ORIGINAL image bytes, never a shape-baked
 *  composite. Arrows/shapes drawn over the image are conveyed to the model as
 *  spatial text (`buildSpatialPrompt`) instead of being burned into the pixels,
 *  so the edited result stays free of annotation marks. Single-source only;
 *  multi-image still uses `selectionToSourceFiles`.
 *
 *  Distinct from `selectionToSourceFile` (which DOES rasterize shapes) because
 *  that path is shared with Split, where the shape-baked composite is the
 *  intended source — only image-edit wants the clean original. */
export async function selectionToCleanSourceFile(
  selection: SingleSourceSelection,
  api: ExcalidrawImperativeAPI,
): Promise<File> {
  return imageElementToFile(selection.sourceUrl, selection.fileId, api);
}

/** Resolve a multi-image selection to an array of `File`s for the provider's
 *  `image: [url1, url2, ...]` payload shape. Ordered by scene order so the
 *  caller's UX matches what's displayed.
 *
 *  Shapes (frames / arrows / text) act as per-image annotations: for each
 *  image, shapes whose bbox overlaps it are rasterized into that image's PNG.
 *  - shape over image[i] only → only selection-i.png is rasterized
 *  - shape spans image[i] + image[j] → burned into both PNGs (e.g. an arrow
 *    "from this to that" is meaningful in both frames)
 *  - orphan shape (overlaps no image) → ignored; a doodle that didn't land on
 *    anything wasn't a deliberate annotation
 *  Images with no overlapping shape skip the export and use the original URL
 *  unchanged (preserves source fidelity for the upload). */
export async function selectionToSourceFiles(
  selection: Extract<CanvasSelection, { kind: "multi-image" }>,
  api: ExcalidrawImperativeAPI,
): Promise<File[]> {
  const filesCache = api.getFiles();
  const plan = attributeShapesPerImage(selection);
  return Promise.all(
    plan.map(async ({ image, overlapShapes }, idx) => {
      if (overlapShapes.length === 0) {
        return imageElementToFile(
          getAiChatImageUrl(image),
          image.fileId ?? null,
          api,
          idx,
          filesCache,
        );
      }
      const blob = await rasterizeElements([image, ...overlapShapes], api);
      return new File([blob], `selection-${idx}.png`, { type: "image/png" });
    }),
  );
}

/** Raw image elements from a selection (image-with-shapes / multi-image 都
 *  忽略 shapes 只取图)。`selectionToSourceFile(s)` 走相反语义 (把 shapes 烧进
 *  PNG 当 edit 指令); 这个走 hand-off 语义 (送原图给别的页面/项目)。 */
export function selectionToImageElements(
  selection: CanvasSelection,
): ExcalidrawImageElement[] {
  if (selection.kind === "single-image") return [selection.image];
  if (selection.kind === "image-with-shapes") return [selection.image];
  return selection.images;
}

/** Hand-off helper: 选区 → raw File[], 不 rasterize shapes (跟
 *  `selectionToSourceFile(s)` 刻意分两条; 用在 canvas → project create page
 *  这种"送原图到别处"的场景)。N 张图并发 fetch, filesCache 单次读复用。 */
export async function selectionToRawImageFiles(
  selection: CanvasSelection,
  api: ExcalidrawImperativeAPI,
): Promise<File[]> {
  const elements = selectionToImageElements(selection);
  const filesCache = api.getFiles();
  return Promise.all(
    elements.map((el, i) =>
      imageElementToFile(getAiChatImageUrl(el), el.fileId, api, i, filesCache),
    ),
  );
}

/** Rasterize a selection into N preview blobs that mirror what the upload
 *  payload will look like:
 *  - single-image / image-with-shapes → 1 blob of the CLEAN image only (no
 *    shape/arrow overlay), matching `selectionToCleanSourceFile`. Arrows show
 *    up in the spatial-prompt tile instead, never burned into the source.
 *  - multi-image → N blobs, one per image (each containing the shapes that
 *    overlap that image; orphan shapes ignored, mirroring `selectionToSourceFiles`)
 *
 *  Unlike the upload path, multi-image previews ALWAYS rasterize even when an
 *  image has no overlap shapes —— the thumbnail UI needs every blob to be a
 *  uniformly-sized PNG with `exportPadding: 8`, not a fetched original. */
export async function selectionToPreviewBlobs(
  selection: CanvasSelection,
  api: ExcalidrawImperativeAPI,
): Promise<Blob[]> {
  if (selection.kind !== "multi-image") {
    return [await rasterizeElements([selection.image], api, { exportPadding: 8 })];
  }
  const plan = attributeShapesPerImage(selection);
  return Promise.all(
    plan.map(({ image, overlapShapes }) =>
      rasterizeElements([image, ...overlapShapes], api, { exportPadding: 8 }),
    ),
  );
}

/** Per-image shape attribution shared by the upload + preview paths.
 *  Walks shapes once per image (O(images × shapes) — selections are tiny);
 *  orphan shapes (overlap no image) drop out implicitly because they're never
 *  collected anywhere. */
function attributeShapesPerImage(
  selection: Extract<CanvasSelection, { kind: "multi-image" }>,
) {
  const { images, shapes } = selection;
  const imageBounds = images.map(getElementBounds);
  return images.map((image, idx) => {
    const ib = imageBounds[idx];
    const overlapShapes = ib
      ? shapes.filter((s) => {
          const sb = getElementBounds(s);
          return sb ? aabbOverlap(sb, ib) : false;
        })
      : [];
    return { image, overlapShapes };
  });
}

function aabbOverlap(a: ElementBounds, b: ElementBounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function imageElementToFile(
  sourceUrl: string | null,
  fileId: FileId | null,
  api: ExcalidrawImperativeAPI,
  index = 0,
  filesCache?: ReturnType<ExcalidrawImperativeAPI["getFiles"]>,
): Promise<File> {
  const files = filesCache ?? api.getFiles();
  const urlToFetch = sourceUrl ?? (fileId ? files[fileId]?.dataURL : null);
  if (!urlToFetch) {
    throw new Error("selected image has no sourceUrl or dataURL");
  }
  const blob = await fetchAsBlob(urlToFetch);
  return new File([blob], `selection-${index}.png`, {
    type: blob.type || "image/png",
  });
}

/** Build an Excalidraw `BinaryFileData` record from our looser fetch result.
 *  Centralizes the two brand-type casts + the `created/lastRetrieved` literal
 *  that would otherwise repeat at every addFiles site (pin paths + hydrate). */
export function buildBinaryFile(
  fileId: FileId,
  dataURL: string,
  mimeType: string,
): BinaryFileData {
  const now = Date.now();
  return {
    id: fileId,
    dataURL: dataURL as BinaryFileData["dataURL"],
    mimeType: mimeType as BinaryFileData["mimeType"],
    created: now,
    lastRetrieved: now,
  };
}

/** Fetch an image URL and convert to base64 dataURL for Excalidraw `addFiles`.
 *  Exported so the scene-file strip/hydrate layer (lib/canvas-scene-files.ts)
 *  can reuse the exact same fetch → FileReader pipeline as pinImage. */
export async function fetchAsDataURL(url: string): Promise<{ dataURL: string; mimeType: string }> {
  const blob = await fetchAsBlob(url);
  const mimeType = blob.type || "image/png";
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataURL, mimeType };
}

export function imageDimensionsFromDataURL(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataURL;
  });
}

/** Bring a freshly-pinned `target` into view. If it fits at the current zoom, do
 *  a gentle scroll (only nudges it on-screen when off the edge — no re-center, no
 *  zoom change). If it OVERFLOWS the viewport (image pins are placed at native
 *  pixel size, so can be large), zoom OUT to frame it (~90% coverage);
 *  `maxZoom = current zoom` guarantees we only ever zoom out, never in. */
function frameToContent(api: ExcalidrawImperativeAPI, target: readonly ExcalidrawElement[]) {
  const appState = api.getAppState();
  const zoom = appState.zoom?.value ?? 1;
  const [minX, minY, maxX, maxY] = getCommonBounds(target);
  // Viewport world dims. Guard the degenerate case (pane not laid out yet →
  // width/height 0, e.g. a pin during scene-switch/resume; or zoom 0/NaN) so we
  // never fit-to-a-zero-viewport (which yields a NaN/extreme zoom). Unknown
  // viewport → fall back to the gentle follow scroll.
  const vw = appState.width / zoom;
  const vh = appState.height / zoom;
  const overflows = vw > 0 && vh > 0 && (maxX - minX > vw || maxY - minY > vh);
  api.scrollToContent(
    target,
    overflows
      ? { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: zoom, animate: true }
      : { fitToViewport: false, animate: true },
  );
}

/** Visual width of a single Unicode code point, in "half-width units":
 *  CJK ideographs + full-width punctuation + Hangul + Kana → 2 units (matches
 *  their square / near-square rendering at the placeholder status text's font
 *  size). Everything else → 1 unit (Latin, Cyrillic, half-width punctuation, etc.).
 *
 *  Pure ASCII text is bit-for-bit identical to the old length-based wrap; the
 *  weighting only kicks in for CJK content that previously overflowed the
 *  placeholder box because length-counting under-budgeted full-width glyphs. */
function charWidthUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||  // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||  // CJK Extension A
    (code >= 0x3000 && code <= 0x303f) ||  // CJK Symbols and Punctuation (，。、…)
    (code >= 0xff00 && code <= 0xffef) ||  // Halfwidth and Fullwidth Forms (full-width digits / punctuation)
    (code >= 0x3040 && code <= 0x309f) ||  // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) ||  // Katakana
    (code >= 0xac00 && code <= 0xd7af)     // Hangul Syllables
  ) return 2;
  return 1;
}

export function visualUnits(s: string): number {
  let n = 0;
  for (const ch of s) n += charWidthUnits(ch);
  return n;
}

/** Take the longest prefix of `s` whose visual width ≤ `maxUnits`, plus the
 *  remainder. Used by the hard-cut path for oversized tokens (URLs, long IDs)
 *  so we don't slice mid-surrogate-pair or mid-CJK char. */
function sliceByUnits(s: string, maxUnits: number): { taken: string; rest: string } {
  let units = 0;
  let cut = 0;
  for (const ch of s) {
    const cw = charWidthUnits(ch);
    if (units + cw > maxUnits) break;
    units += cw;
    cut += ch.length;
  }
  return { taken: s.slice(0, cut), rest: s.slice(cut) };
}

export function wrapText(text: string, maxUnitsPerLine: number): string {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const wUnits = visualUnits(w);
      // 单 token 本身超长 (URL / 长 ID 无空格 / 一大段无标点 CJK) — flush 当前行
      // 后按视觉单位硬切. 否则 (line + w) 一直累加, 整行不换行飞出框外.
      if (wUnits > maxUnitsPerLine) {
        if (line) {
          lines.push(line.trimEnd());
          line = "";
        }
        let remaining = w;
        while (visualUnits(remaining) > maxUnitsPerLine) {
          const { taken, rest } = sliceByUnits(remaining, maxUnitsPerLine);
          lines.push(taken);
          remaining = rest;
        }
        line = remaining;
        continue;
      }
      if (visualUnits(line + w) > maxUnitsPerLine && line.length > 0) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line += w;
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function estimateHeight(wrapped: string, lineHeightPx: number): number {
  const lines = Math.max(1, wrapped.split("\n").length);
  return Math.max(lineHeightPx, lines * lineHeightPx + 4);
}

/** Async canvas job families. Shared by the pin placeholder flow, the chat
 *  agent's tool_call routing, and the direct ImageEditBar toolbar.
 *
 *  "image" — tu-zi text-to-image + image-edit + rembg cutout (multipart)
 *  "video" — tu-zi text-to-video (long poll, returns single result_url)
 *  "angle" — fal.ai Qwen-LoRA camera-angle rerender (same result shape as image)
 *
 *  Runtime array lets the reload-resume path narrow untrusted scene customData
 *  via `isJobKind(...)` instead of a hand-rolled triple-equals chain.
 */
export const JOB_KINDS = ["image", "video", "angle"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export function isJobKind(v: unknown): v is JobKind {
  return typeof v === "string" && (JOB_KINDS as readonly string[]).includes(v);
}

/** Placeholder customData keys + sentinels. Centralized because the resume
 *  scan reads them back from autosaved scene data — string-typed reads
 *  anywhere have to match string-typed writes here. */
export const PLACEHOLDER_TYPE_SUFFIX = "-placeholder";
export const PLACEHOLDER_STATUS_PENDING = "pending";
export const PLACEHOLDER_STATUS_FAILED = "failed";
export const CANVAS_JOB_ID_KEY = "canvasJobId";
export const CANVAS_JOB_KIND_KEY = "canvasJobKind";

/** True if `el` is a placeholder rect/text in the given lifecycle status. */
function isPlaceholderInStatus(el: ExcalidrawElement, status: string): boolean {
  const cd = el.customData;
  if (!cd) return false;
  return (
    typeof cd.aiChatType === "string"
    && cd.aiChatType.endsWith(PLACEHOLDER_TYPE_SUFFIX)
    && cd.aiChatStatus === status
  );
}

/** Pending placeholder — resume scan on scene reload + the generating card. */
export function isPendingPlaceholder(el: ExcalidrawElement): boolean {
  return isPlaceholderInStatus(el, PLACEHOLDER_STATUS_PENDING);
}

/** Failed (tombstone) placeholder — drives the failure card in CanvasGeneratingOverlay. */
export function isFailedPlaceholder(el: ExcalidrawElement): boolean {
  return isPlaceholderInStatus(el, PLACEHOLDER_STATUS_FAILED);
}

/** Extract the `{ jobId, kind }` tag stamped by `tagPlaceholderWithJob`, or
 *  null if the placeholder predates tagging (tab closed before createJob
 *  returned — resume scan marks these failed). */
export function getCanvasJobTag(el: ExcalidrawElement): { jobId: string; kind: JobKind } | null {
  const cd = el.customData;
  if (!cd) return null;
  const jobId = cd[CANVAS_JOB_ID_KEY];
  const kind = cd[CANVAS_JOB_KIND_KEY];
  if (typeof jobId !== "string" || !jobId) return null;
  if (!isJobKind(kind)) return null;
  return { jobId, kind };
}

/**
 * "预生成空间" — canvas 上等异步 job 结果的占位槽 (rect + text 两个 Excalidraw
 * element + 一个 groupId 把它们绑成一组). 用户点 Apply / Cutout / Split / Video
 * / Angle 时立刻在画布画一个虚线框 + 状态文字, 后端 job 跑完再把真 asset 贴
 * 进同一位置.
 *
 * 生命周期 (典型 image-edit / cutout):
 *   1. createPlaceholder()      → 虚线框 + 灰字 "Editing image…" / "Cutting out…"
 *   2. tagPlaceholderWithJob()  → 把 backend job_id 烧进 customData.aiChatJobId,
 *                                 刷新页面后 useResumeCanvasJobs 还能找到这个槽
 *                                 继续 poll, 不会成孤儿
 *   3. updatePlaceholderLabel() → job 进展中可能换 label (例如 angle 路径)
 *   4. 终态二选一:
 *      ✅ commitPlaceholderReplace() — 虚线框 soft-delete, 真图/视频/RGBA 贴到
 *         同一 (x, y, width, height), 结果之间按 nextYRef 列向下排
 *      ❌ markPlaceholderFailed()    — 文字变红 + 加 "Generation failed: <reason>",
 *         customData.aiChatStatus 翻 "failed" (resume scan 不再误认它 pending)
 *
 * 字段语义:
 *   - rectId / textId / groupId: Excalidraw 三个 element id, 后续 update/delete
 *     按这三个 id 定位; replace 时把 rect+text 都软删才不残留
 *   - x / y / width / height: 创建时的 world-space bounds (用户可缩放/平移画布
 *     但占位槽自己的 bounds 不动), replace 路径按这块装配真 asset
 *   - kind: image / video / angle, 决定 commit 路径 (replacePlaceholderWithImage
 *     vs replacePlaceholderWithVideo) 跟 resume scan 的 job_id → service 路由
 *
 * 相关术语 (内部讨论时可能混用):
 *   - "placeholder" / "pin placeholder" (代码) = "预生成空间" (中文)
 *   - "pinning" = 把 result asset 贴进预生成空间的动作
 *   - "anchor"  = 触发预生成空间的源选区 bounds (见 PinAnchor)
 *   - "tombstone" = 已 markPlaceholderFailed 的预生成空间, 永久红字, 不再 poll
 */
export interface PinPlaceholder {
  rectId: string;
  textId: string;
  groupId: string;
  /** World-space bounds of the rect box; the replace path fits the real asset
   *  inside this box. Captured at creation because the user may pan/zoom but
   *  the placeholder's own bounds don't change. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: JobKind;
  /** Sibling text element ID floating ABOVE the rect (only set when the
   *  caller passed `layout.permanentLabel`). Survives replace + failure
   *  marking — its sole job is to title the slot ("1-主图-纯白背景"). */
  labelTextId?: string;
}

/** Pack-mode layout (slot_index 模式). Listing-pack skills 走这个: agent 给
 *  每张图带 slot_index (0..N-1) + permanentLabel ("1-主图-纯白背景"), 整批共
 *  享同一 row y, x 按 slot_index 偏移, label 浮在 rect 上方且不被 replace/
 *  failure 路径清掉。Skill 不用时两个字段 undefined, 走原垂直堆叠路径。 */
export interface PinLayoutOptions {
  permanentLabel?: string;
  slotIndex?: number;
}

/** World-space rect of a source element that triggered a pin (i.e. the
 *  marquee selection on the toolbar path). When passed to `createPlaceholder`
 *  the placeholder appears to the right of this rect instead of in the chat's
 *  left column, and the column cursor (`nextYRef`) is left untouched so future
 *  chat messages don't sit in the same slot. */
export interface PinAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UseCanvasPinning {
  /** Find or create the scene's chat frame (native Excalidraw frame the
   *  ChatFrameOverlay anchors to). Returns its id, or null if API not mounted. */
  ensureChatFrame: () => string | null;
  /** Find-or-create the scene's SINGLE "browse log" frame (like ensureChatFrame),
   *  reused across browse turns: on reuse it retitles to the triggering message
   *  and clears the old transcript; a fresh one is placed below the chat frame.
   *  Returns its id, or null if the API isn't mounted / creation failed. */
  ensureBrowseLogFrame: (title: string) => string | null;
  /** Persist the accumulated log lines into a browse-log frame's customData (as
   *  a JSON array — faithful per-line round-trip) so they survive a scene reload;
   *  the live transcript otherwise lives only in React state during the turn.
   *  No-op if the frame is gone. */
  persistBrowseLogText: (frameId: string, lines: string[]) => void;
  /** Find-or-create the scene's SINGLE live-browser monitor frame, reused across
   *  browse turns (clears the old image on reuse). A fresh one is placed to the
   *  RIGHT of the log frame (or the chat frame when `logFrameId` is null / gone).
   *  Returns its id, or null if the API isn't mounted / creation failed. */
  ensureBrowseMonitorFrame: (logFrameId: string | null) => string | null;
  /** Persist the final page-screenshot URL into a monitor frame's customData so a
   *  reload shows the end-state view. No-op if the frame is gone. */
  persistBrowseMonitorImage: (frameId: string, url: string) => void;
  /** Clear the singleton monitor frame's persisted image (no-op if none); returns
   *  its id so the caller can also evict a stale live-state entry. Call when a new
   *  browse starts so the monitor doesn't keep a prior browse's screenshot on a
   *  turn that logs but never screenshots. */
  clearBrowseMonitorImage: () => string | null;
  /** Find-or-create the scene's SINGLE robot-steps frame (RPA authoring), placed to the
   *  RIGHT of the monitor frame; reused across the authoring session (retitles on reuse,
   *  steps are appended not cleared). Returns its id, or null. */
  ensureRobotStepsFrame: (title: string) => string | null;
  /** Persist the robot's steps into the steps frame's customData (JSON array) so they
   *  survive a scene reload; the live steps otherwise live only in React state. No-op if
   *  the frame is gone. */
  persistRobotSteps: (frameId: string, steps: RobotStep[]) => void;
  /** `startAt` overrides the column cursor for this one pin —— used by
   *  `pinAssetResultRows` to stack n>1 results below a placeholder in the
   *  source's column. Omit for default chat left-column stacking. */
  pinImage: (params: {
    url: string;
    dedupKey: string;
    startAt?: { x: number; y: number };
  }) => Promise<void>;
  pinVideo: (params: {
    videoUrl: string;
    dedupKey: string;
    startAt?: { x: number; y: number };
  }) => void;
  /** Pin a locally-rasterized image (no remote URL). Used by Merge —— the
   *  flattened blob lives only as a dataURL in Excalidraw's files cache, so
   *  customData omits `aiChatImageUrl`; later edits read fileId → dataURL via
   *  `imageElementToFile`'s fallback path. */
  pinMergedImage: (params: {
    dataURL: string;
    mimeType: string;
    dedupKey: string;
    startAt?: { x: number; y: number };
  }) => Promise<void>;
  /** Reserve a spot on the canvas for an in-flight generation. Drops a dashed
   *  rect + "Generating…" text, finds a non-overlapping position, and scrolls
   *  the viewport to include it so the user sees where the result will land.
   *  `anchor` (= source selection's world rect) places the slot to the right
   *  of it instead of in the chat left column. */
  createPlaceholder: (
    kind: JobKind,
    label: string,
    anchor?: PinAnchor,
    layout?: PinLayoutOptions,
    /** Expected size of the generated result (e.g. image-edit's 2K/4K output).
     *  Sizes the loading box to the RESULT rather than the source; falls back to
     *  the `anchor` rect, then a fixed square. */
    resultSize?: { width: number; height: number },
  ) => PinPlaceholder | null;
  /** Drop a second placeholder at `base`'s geometry (Split z-stack). Does not
   *  advance the pin cursor; later-pinned result stacks on top. */
  createPlaceholderOverlay: (base: PinPlaceholder, label: string) => PinPlaceholder | null;
  updatePlaceholderLabel: (placeholder: PinPlaceholder, label: string) => void;
  replacePlaceholderWithImage: (
    placeholder: PinPlaceholder,
    params: { url: string; dedupKey: string },
  ) => Promise<void>;
  replacePlaceholderWithVideo: (
    placeholder: PinPlaceholder,
    params: { videoUrl: string; dedupKey: string },
  ) => void;
  markPlaceholderFailed: (placeholder: PinPlaceholder, reason?: string) => void;
  /** Batched tombstone for n>1 reservation paths: one `updateScene` covers
   *  all N placeholders instead of N sequential re-renders. The singular
   *  `markPlaceholderFailed` delegates to this. */
  markPlaceholdersFailed: (placeholders: PinPlaceholder[], reason?: string) => void;
  /** Stamp `canvasJobId` + `canvasJobKind` into both rect+text customData so
   *  a scene reload can find the job and resume polling. Call right after
   *  `createJob` returns the job id. */
  tagPlaceholderWithJob: (placeholder: PinPlaceholder, jobId: string) => void;
  /** Reset the pin cursor + seen-set. Call on scene switch. */
  reset: () => void;
  /** Per-turn cleanup for pack-mode (slot_index 横排) state. CALLERS MUST
   *  invoke this at the START of every chat turn (before the first tool_call
   *  arrives) — otherwise turn-2 of a pack reuses turn-1's stale row y, and
   *  out-of-order parallel tool_calls (slot=2 arriving before slot=0) split
   *  the row across two y positions. `reset()` does it too on scene switch,
   *  but doesn't fire between same-scene turns. */
  resetPackRow: () => void;
}

/** Shared by the image-edit / video-edit / angle-edit hooks: all three feed
 *  `pinCanvasJobResult` which dispatches across image/video/angle branches,
 *  so each hook needs the full pin surface on its `pinning` prop. */
export type CanvasEditPinning = Pick<
  UseCanvasPinning,
  | "createPlaceholder"
  | "createPlaceholderOverlay"
  | "markPlaceholderFailed"
  | "markPlaceholdersFailed"
  | "tagPlaceholderWithJob"
  | "replacePlaceholderWithImage"
  | "replacePlaceholderWithVideo"
  | "pinImage"
  | "pinVideo"
>;

// `convertToExcalidrawElements` accepts a heterogeneous skeleton array with
// per-type shapes; we can't narrow further without copying its union, so we
// piggyback on its Parameters type.
type ElementSkeleton = Parameters<typeof convertToExcalidrawElements>[0];

/** Direction the overlap search walks when blocked.
 *  - `"down"`: chat-column stack (agent-tool image / video pins).
 *  - `"right"`: toolbar-anchored chain —— every submit / n>1 result grows
 *    horizontally to the right of the source selection, keeping a single row.
 */
type SearchDirection = "down" | "right";

/** Find an empty (width × height) slot starting at (startX, startY), walking
 *  either down or right when blocked. `gap` pads collisions so pins never
 *  touch. Used by the insertion paths (pinImage / pinVideo) plus
 *  createPlaceholder.
 *
 *  Exported for unit testing — also reused by `createPlaceholder` pack-mode
 *  path with a wide `width` (= worst-case full row width, PACK_ROW_SLOTS slots)
 *  to find a y where the entire pack row is clear of existing elements.
 */
export function findNonOverlappingPinPosition(
  elements: readonly ExcalidrawElement[],
  startX: number,
  startY: number,
  width: number,
  height: number,
  gap: number,
  direction: SearchDirection = "down",
): { x: number; y: number } {
  // Compute all element bounds once; the collision loop can run up to 400
  // steps, and re-deriving bounds per step is O(N·400) allocations for a
  // perf win of literally nothing (bounds don't change during the search).
  const bounds: ElementBounds[] = [];
  for (const el of elements) {
    const b = getElementBounds(el);
    if (b) bounds.push(b);
  }

  let x = startX;
  let y = startY;
  for (let step = 0; step < 400; step++) {
    const left = x;
    const right = x + width;
    const top = y;
    const bottom = y + height;
    let collided = false;
    let nextStep = direction === "down" ? y : x;
    for (const b of bounds) {
      if (!(left < b.right + gap && right > b.left - gap)) continue;
      if (!(top < b.bottom + gap && bottom > b.top - gap)) continue;
      collided = true;
      // For "down" we push below the colliding element; for "right" we push
      // past its right edge. Both keep the orthogonal coordinate fixed, so
      // anchored pins stay on the same row and chat pins stay in the same x.
      if (direction === "down" && b.bottom + gap > nextStep) nextStep = b.bottom + gap;
      if (direction === "right" && b.right + gap > nextStep) nextStep = b.right + gap;
    }
    if (!collided) break;
    if (direction === "down") {
      y = nextStep > y ? nextStep : y + gap;
    } else {
      x = nextStep > x ? nextStep : x + gap;
    }
  }
  return { x, y };
}

/** 从场景推导聊天列的下一个起始 y: 取「列 x-band 内、带 aiChatType 的托管 pin」的最大
 *  下沿 + PIN_GAP; 没有则 `fallbackY`. 重载/续聊用它把新内容接到列底, 保持聊天顺序、
 *  不落进空洞 (取代旧的视口重锚定)。纯函数 → 单测覆盖, 与 findNonOverlappingPinPosition
 *  同一可测层。
 *
 *  `bandLeft` = 本列的左 x (默认 PIN_ORIGIN_X 兼容旧左列;聊天列现在锚到 chat frame
 *  右侧, 传 frame 右沿)。band 同时设下界 (排除列左侧元素, 典型是 chat frame 自身——
 *  它的左沿远在 startX 左边) 和上界 (排除远端锚点 pin)。 */
export function computeColumnStartY(
  elements: readonly ExcalidrawElement[],
  bandLeft: number = PIN_ORIGIN_X,
  fallbackY: number = PIN_ORIGIN_Y,
): number {
  let maxBottom = -Infinity;
  for (const el of elements) {
    const b = getElementBounds(el);
    if (!b) continue;                                        // deleted / 非有限
    const cd = el.customData;
    if (typeof cd?.aiChatType !== "string") continue;        // 仅托管 pin
    if (b.left < bandLeft - PIN_GAP || b.left >= bandLeft + PIN_COLUMN_BAND) continue;
    if (b.bottom > maxBottom) maxBottom = b.bottom;
  }
  return maxBottom === -Infinity ? fallbackY : maxBottom + PIN_GAP;
}

/** Jobs whose success shape is `results[]` (Asset URL rows) — image-edit and
 *  angle share this via the backend's `_AssetResultSerializerBase`. Video
 *  uses `result_url` instead and is handled inline in `pinCanvasJobResult`. */
type AssetResultJob = CanvasImageEditJob | CanvasAngleJob;

/** Pin a completed job's `results[]` to the canvas, claiming pre-reserved
 *  placeholder slots index-wise (result[i] → placeholders[i]); spillover
 *  results stack via `pinImage`; unfilled placeholders (partial failure)
 *  get tombstoned so the user sees WHY the reserved spot didn't fill.
 *
 *  Empty `placeholders` = markdown-fallback path (no reservation, just stack).
 *  Length 1 = single placeholder (toolbar / split). Length N = chat n>1.
 *
 *  The detail endpoint that `waitForCanvasJob` polls already inlines
 *  `results[]` (backend view attaches them before responding), so callers
 *  pass the job they already have — no second HTTP fetch. */
export async function pinAssetResultRows(
  job: AssetResultJob,
  placeholders: PinPlaceholder[],
  pinning: Pick<
    UseCanvasPinning,
    "markPlaceholdersFailed" | "replacePlaceholderWithImage" | "pinImage"
  >,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const results = (job.results ?? []).filter((r) => r.url);
  if (!results.length) {
    pinning.markPlaceholdersFailed(placeholders, "no result url");
    return { ok: false, reason: "no result url" };
  }
  const [primary, ...extras] = placeholders;
  // Spillover anchor: when results outnumber placeholders, the extras pin
  // via pinImage from primary's (x, y) — the right-walking overlap search
  // chains them into a row. Without a primary (markdown-fallback) the pin
  // layer falls back to the left-column cursor.
  const restStartAt = primary ? { x: primary.x, y: primary.y } : undefined;
  const promises = results.map((r, i) => {
    if (i === 0) {
      return primary
        ? pinning.replacePlaceholderWithImage(primary, { url: r.url, dedupKey: r.asset_id })
        : pinning.pinImage({ url: r.url, dedupKey: r.asset_id });
    }
    const slot = extras[i - 1];
    return slot
      ? pinning.replacePlaceholderWithImage(slot, { url: r.url, dedupKey: r.asset_id })
      : pinning.pinImage({ url: r.url, dedupKey: r.asset_id, startAt: restStartAt });
  });
  pinning.markPlaceholdersFailed(extras.slice(results.length - 1), "no result for this slot");
  await Promise.all(promises);
  return { ok: true };
}

/** Dispatch a completed canvas job to the right pin path:
 *  FAILED → tombstone every reserved slot; image/angle → `pinAssetResultRows`
 *  (shared `results[]` shape with index-paired replacement); video → replace
 *  the primary placeholder with a video card, tombstone extras ("video
 *  produces single result" — `generate_video` doesn't take `n`, but
 *  defense-in-depth). Empty `placeholders` = markdown-fallback path. */
export async function pinCanvasJobResult(
  kind: JobKind,
  job: CanvasImageEditJob | CanvasVideoJob | CanvasAngleJob,
  jobId: string,
  placeholders: PinPlaceholder[],
  pinning: Pick<
    UseCanvasPinning,
    | "markPlaceholdersFailed"
    | "replacePlaceholderWithImage"
    | "replacePlaceholderWithVideo"
    | "pinImage"
    | "pinVideo"
  >,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (job.status === "FAILED") {
    pinning.markPlaceholdersFailed(placeholders, job.error || undefined);
    return { ok: false, reason: job.error || "generation failed" };
  }
  if (kind === "image" || kind === "angle") {
    // Narrowed by kind/caller contract — JobKind alone can't act as a TS
    // discriminant because the job shapes don't carry a `kind` field.
    return pinAssetResultRows(job as AssetResultJob, placeholders, pinning);
  }
  if (!("result_url" in job) || !job.result_url) {
    pinning.markPlaceholdersFailed(placeholders, "no result url");
    return { ok: false, reason: "no result url" };
  }
  const [primary, ...extras] = placeholders;
  if (primary) {
    pinning.replacePlaceholderWithVideo(primary, { videoUrl: job.result_url, dedupKey: jobId });
  } else {
    pinning.pinVideo({ videoUrl: job.result_url, dedupKey: jobId });
  }
  pinning.markPlaceholdersFailed(extras, "video produces single result");
  return { ok: true };
}

/** Build a native Excalidraw frame element at exact geometry with our name +
 *  customData. Centralizes the fragile convert incantation shared by the chat
 *  frame and the browse-log frame: a frame skeleton MUST carry `children: []`
 *  (convertToExcalidrawElements does `children.forEach` and throws otherwise),
 *  the skeleton type doesn't include `frame` (hence the cast), and convert drops
 *  name/customData so they're re-applied after. Returns null if convert yields
 *  nothing. Caller does the updateScene. */
function buildFrameElement(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  customData: Record<string, unknown>;
}): ExcalidrawElement | null {
  const created = convertToExcalidrawElements([
    { type: "frame", x: opts.x, y: opts.y, width: opts.width, height: opts.height, children: [] },
  ] as unknown as Parameters<typeof convertToExcalidrawElements>[0]);
  if (!created.length) return null;
  return { ...created[0], name: opts.name, customData: opts.customData } as ExcalidrawElement;
}

export function useCanvasPinning(
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
): UseCanvasPinning {
  const nextYRef = useRef<number>(PIN_ORIGIN_Y);
  // reset 后 false; 首次解析列锚点时翻 true, 门控一次性「从场景推导 nextYRef 起点」。
  const columnInitializedRef = useRef<boolean>(false);
  // Pack-mode 横排 (slot_index 模式) 当前 row 的锚点: 第一个到达的 slot 把整行的 y
  // (packRowYRef) 和 x 起点 (packRowStartXRef) 一次性 claim, 后续 slots 复用 (x 按
  // slot_index 偏移)。x 必须跟 y 一样只 claim 一次 —— startX 现在跟随 chat frame 位置,
  // 若每个 slot 都重算, frame 在并行 slot 之间被拖动会让后到的 slot 整行错位。
  const packRowYRef = useRef<number | null>(null);
  const packRowStartXRef = useRef<number | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    nextYRef.current = PIN_ORIGIN_Y;
    columnInitializedRef.current = false;
    packRowYRef.current = null;
    packRowStartXRef.current = null;
    seenIdsRef.current = new Set();
  }, []);

  const resetPackRow = useCallback(() => {
    packRowYRef.current = null;
    packRowStartXRef.current = null;
  }, []);

  /** Resolve the chat column's start (x, y) for the next pin. The column is
   *  scene-anchored, NOT viewport-anchored: startX tracks the chat frame's right
   *  edge (frame.x + frame.width + PIN_GAP), or falls back to PIN_ORIGIN_X when no
   *  chat frame exists yet; startY is the monotonic column cursor (nextYRef). This
   *  is the fix for "pin 位置很乱" —— the old body re-anchored the column to wherever
   *  the user had panned, fragmenting a conversation into columns at arbitrary coords.
   *
   *  Init is lazy (first-use), not at reset(): the per-scene `<Excalidraw key>`
   *  remount means apiRef isn't repointed at the new scene yet when reset()
   *  runs, so we defer the scene-derived `nextYRef` seed to the first pin
   *  (always after mount). `computeColumnStartY` lands it below existing column
   *  content so a reload / continuation keeps chat order instead of gap-landing.
   *
   *  Shared by `pinElements` (messages / image pins) and `createPlaceholder`
   *  (reserved slots + pack-mode startX) so they never diverge on x. */
  const resolveChatColumnAnchor = useCallback((): { startX: number; startY: number } => {
    const elements = apiRef.current?.getSceneElements() ?? null;
    // 聊天生成的图 (单图 + pack) 排在 chat frame 右侧的一列里, 按到达顺序依次往下
    // 排 —— 不再压在 frame 左上的固定列上。startX 每次按 frame 当前位置实时算 (frame
    // 被拖动后新图跟着走)。还没 chat frame (罕见: ensureChatFrame 之前就 pin) 时回落
    // 到旧的左列 PIN_ORIGIN_X。
    const frame = elements ? findChatFrame(elements) : null;
    const startX = frame ? frame.x + frame.width + PIN_GAP : PIN_ORIGIN_X;
    if (!columnInitializedRef.current && elements) {
      // 列游标 seed: 接在本 band 已有 pin 的下面 (重载/续聊保序), 否则从 frame 顶
      // (无 frame 则 PIN_ORIGIN_Y) 起。只在真读到 scene 后标记已初始化, api 为空时
      // 下次重试 seed, 不会把游标永久钉死。
      nextYRef.current = computeColumnStartY(
        elements, startX, frame ? frame.y : PIN_ORIGIN_Y,
      );
      columnInitializedRef.current = true;
    }
    return { startX, startY: nextYRef.current };
  }, [apiRef]);

  /** Shared append: find a non-overlapping slot from either the caller-supplied
   *  `startAt` or the column cursor (`nextYRef`), convert skeleton at the
   *  resolved (x, y), append to scene. Dedup + api-availability remain the
   *  caller's responsibility; sync pins guard before building, async pins
   *  guard before fetching so they don't race two fetches for the same key.
   *  Returns false if the API isn't mounted.
   *
   *  `startAt`-driven pins DO NOT advance the column cursor —— they're
   *  contextual to a source selection (or a previous placeholder), not part
   *  of the chat's vertical feed. */
  const pinElements = useCallback(
    (
      width: number,
      height: number,
      buildSkeleton: (pos: { x: number; y: number }) => ElementSkeleton,
      startAt?: { x: number; y: number },
      opts?: { fit?: boolean },
    ): boolean => {
      const api = apiRef.current;
      if (!api) return false;
      const existing = api.getSceneElements();

      const { startX, startY } = startAt
        ? { startX: startAt.x, startY: startAt.y }
        : resolveChatColumnAnchor();
      // startAt-driven pins chain right (toolbar anchor → horizontal row);
      // column-cursor pins stack down (chat feed).
      const direction = startAt ? "right" : "down";
      const { x, y } = findNonOverlappingPinPosition(
        existing, startX, startY, width, height, PIN_GAP, direction,
      );
      if (!startAt) nextYRef.current = y + height + PIN_GAP;
      const created = convertToExcalidrawElements(buildSkeleton({ x, y }));
      if (!created.length) return false;
      api.updateScene({ elements: [...existing, ...created] });
      // `fit` (image pins — placed at native px, so possibly large): frame the
      // new image, zooming OUT only if it overflows the viewport. Default (chat
      // notes / video): gentle scroll that keeps the pin in view without touching
      // zoom —— 通常 no-op, 偶发长消息超出下沿时把它带回视野.
      // 替换占位符走 commitPlaceholderReplace 自行 frame, 不经过这里.
      if (opts?.fit) {
        frameToContent(api, created);
      } else {
        api.scrollToContent(created, { fitToViewport: false, animate: true });
      }
      return true;
    },
    [apiRef, resolveChatColumnAnchor],
  );

  /** Find (or create) the scene's chat frame — a native Excalidraw frame the
   *  ChatFrameOverlay anchors its scrollable panel to. First creation drops any
   *  legacy note-text pins (chat now lives in the panel, not on the canvas).
   *  Places the frame in the current viewport so the user sees it. Returns the
   *  frame id, or null if the API isn't mounted. */
  const ensureChatFrame = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    // 整个包 try —— 建框失败绝不能炸掉发消息主流程 (调用方在 try 外)。
    try {
      const elements = api.getSceneElements();
      const existing = findChatFrame(elements);
      if (existing) return existing.id;

      const app = api.getAppState();
      const zoom = app.zoom?.value ?? 1;
      const viewW = (app.width ?? 1200) / zoom;
      const viewH = (app.height ?? 800) / zoom;
      const x = -(app.scrollX ?? 0) + Math.min(80, viewW * 0.06);
      const y = -(app.scrollY ?? 0) + Math.max(40, (viewH - CHAT_FRAME_HEIGHT) / 2);
      // findChatFrame 靠 customData.aiChatType 认这个聊天框 (convert 会丢 name/
      // customData, buildFrameElement 创建后再盖上)。
      const frame = buildFrameElement({
        x, y, width: CHAT_FRAME_WIDTH, height: CHAT_FRAME_HEIGHT,
        name: "Chat", customData: { aiChatType: CHAT_FRAME_MARKER },
      });
      if (!frame) return null;
      // 迁移: 去掉旧版聊天文字 pin —— 现在聊天在面板里, 不再撒到画布上。
      const kept = elements.filter((el) => !isChatNoteElement(el));
      api.updateScene({ elements: [...kept, frame] });
      return frame.id;
    } catch (err) {
      console.error("ensureChatFrame failed", err);
      return null;
    }
  }, [apiRef]);

  /** Shallow-merge `patch` into one frame's customData (found by id). The single
   *  write path shared by the browse-log / monitor persisters and the ensure*
   *  reuse-branches. No-op if the API isn't mounted or the frame is gone. */
  const patchFrameCustomData = useCallback(
    (frameId: string, patch: Record<string, unknown>): void => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const elements = api.getSceneElements();
        const frame = elements.find((el) => el.id === frameId && !el.isDeleted);
        if (!frame) return;
        const next = newElementWith(frame, {
          customData: { ...(frame.customData ?? {}), ...patch },
        });
        api.updateScene({ elements: elements.map((el) => (el.id === frameId ? next : el)) });
      } catch (err) {
        console.error("patchFrameCustomData failed", err);
      }
    },
    [apiRef],
  );

  /** Find-or-create the scene's SINGLE browse-log frame (like ensureChatFrame),
   *  reusing it across browse turns instead of stacking a new one each time. On
   *  reuse it retitles to this turn's message and clears the old transcript so the
   *  frame reflects the CURRENT browse; a fresh frame is placed below the chat
   *  frame. Wrapped in try — a placement failure must never break the chat turn. */
  const ensureBrowseLogFrame = useCallback(
    (title: string): string | null => {
      const api = apiRef.current;
      if (!api) return null;
      try {
        const elements = api.getSceneElements();
        const existing = findBrowseLogFrame(elements);
        if (existing) {
          // Reuse the singleton: retitle + clear so the panel shows this browse
          // (live state fills it while streaming; persist overwrites at settle).
          patchFrameCustomData(existing.id, {
            [BROWSE_LOG_TITLE_KEY]: title,
            [BROWSE_LOG_TEXT_KEY]: serializeBrowseLog([]),
          });
          // Scroll to it like a fresh one — the singleton may be off-screen if the
          // user panned away since the last browse, and a silent off-screen update
          // reads as "nothing happened".
          api.scrollToContent([existing], { fitToViewport: false, animate: true });
          return existing.id;
        }
        // First time in this scene: place it below the chat frame, walking down
        // past any existing content in that band.
        const chat = findChatFrame(elements);
        const startX = chat ? chat.x : PIN_ORIGIN_X;
        const startY = (chat ? chat.y + chat.height : PIN_ORIGIN_Y) + PIN_GAP;
        const { x, y } = findNonOverlappingPinPosition(
          elements, startX, startY,
          BROWSE_LOG_FRAME_WIDTH, BROWSE_LOG_FRAME_HEIGHT, PIN_GAP, "down",
        );
        const frame = buildFrameElement({
          x, y, width: BROWSE_LOG_FRAME_WIDTH, height: BROWSE_LOG_FRAME_HEIGHT,
          name: "Browse log",
          customData: {
            aiChatType: BROWSE_LOG_FRAME_MARKER,
            [BROWSE_LOG_TITLE_KEY]: title,
            [BROWSE_LOG_TEXT_KEY]: serializeBrowseLog([]),
          },
        });
        if (!frame) return null;
        api.updateScene({ elements: [...elements, frame] });
        api.scrollToContent([frame], { fitToViewport: false, animate: true });
        return frame.id;
      } catch (err) {
        console.error("ensureBrowseLogFrame failed", err);
        return null;
      }
    },
    [apiRef, patchFrameCustomData],
  );

  const persistBrowseLogText = useCallback(
    (frameId: string, lines: string[]): void => {
      patchFrameCustomData(frameId, { [BROWSE_LOG_TEXT_KEY]: serializeBrowseLog(lines) });
    },
    [patchFrameCustomData],
  );

  /** Find-or-create the scene's SINGLE live-browser monitor frame, reusing it
   *  across browse turns. On reuse it clears the old image so the panel reflects
   *  the CURRENT browse (live frames fill it immediately). A fresh frame is placed
   *  to the RIGHT of the log frame and both panels are framed into view. */
  const ensureBrowseMonitorFrame = useCallback(
    (logFrameId: string | null): string | null => {
      const api = apiRef.current;
      if (!api) return null;
      try {
        const elements = api.getSceneElements();
        const logFrame = logFrameId
          ? elements.find((el) => el.id === logFrameId && !el.isDeleted) ?? null
          : null;
        // Frame the pair (log + monitor) so both are visible — used by BOTH the
        // create and reuse paths so a reused, panned-away monitor is brought back
        // into view exactly like a fresh one.
        const frameIntoView = (monitor: ExcalidrawElement) =>
          api.scrollToContent(logFrame ? [logFrame, monitor] : [monitor], {
            fitToViewport: true,
            viewportZoomFactor: 0.9,
            animate: true,
          });
        const existing = findBrowseMonitorFrame(elements);
        if (existing) {
          // Reuse the singleton in place; clear the stale image (live state takes
          // over immediately, persist/finally overwrites for reload).
          patchFrameCustomData(existing.id, { [BROWSE_MONITOR_IMAGE_KEY]: "" });
          frameIntoView(existing);
          return existing.id;
        }
        const anchor = logFrame ?? findChatFrame(elements);
        const startX = anchor ? anchor.x + anchor.width + PIN_GAP : PIN_ORIGIN_X;
        const startY = anchor ? anchor.y : PIN_ORIGIN_Y;
        const { x, y } = findNonOverlappingPinPosition(
          elements, startX, startY,
          BROWSE_MONITOR_FRAME_WIDTH, BROWSE_MONITOR_FRAME_HEIGHT, PIN_GAP, "down",
        );
        const frame = buildFrameElement({
          x, y, width: BROWSE_MONITOR_FRAME_WIDTH, height: BROWSE_MONITOR_FRAME_HEIGHT,
          name: "Live browser",
          customData: { aiChatType: BROWSE_MONITOR_FRAME_MARKER, [BROWSE_MONITOR_IMAGE_KEY]: "" },
        });
        if (!frame) return null;
        api.updateScene({ elements: [...elements, frame] });
        frameIntoView(frame);
        return frame.id;
      } catch (err) {
        console.error("ensureBrowseMonitorFrame failed", err);
        return null;
      }
    },
    [apiRef, patchFrameCustomData],
  );

  const persistBrowseMonitorImage = useCallback(
    (frameId: string, url: string): void => {
      patchFrameCustomData(frameId, { [BROWSE_MONITOR_IMAGE_KEY]: url });
    },
    [patchFrameCustomData],
  );

  /** Find-or-create the scene's SINGLE robot-steps frame, placed to the RIGHT of the
   *  monitor frame (the browser the user picks on). Reused across the authoring session;
   *  on reuse it only retitles (steps are appended by the caller, not cleared here). */
  const ensureRobotStepsFrame = useCallback(
    (title: string): string | null => {
      const api = apiRef.current;
      if (!api) return null;
      try {
        const elements = api.getSceneElements();
        const existing = findRobotStepsFrame(elements);
        if (existing) {
          // Deliberately NO scroll-into-view here (unlike the log / monitor frames):
          // this reuse path runs on EVERY pick, and the user is clicking on the
          // monitor frame — scrolling to the steps frame would yank them away from the
          // element they're picking. The steps frame is framed once, on create.
          if (title) patchFrameCustomData(existing.id, { [ROBOT_STEPS_TITLE_KEY]: title });
          return existing.id;
        }
        const anchor =
          findBrowseMonitorFrame(elements) ??
          findBrowseLogFrame(elements) ??
          findChatFrame(elements);
        const startX = anchor ? anchor.x + anchor.width + PIN_GAP : PIN_ORIGIN_X;
        const startY = anchor ? anchor.y : PIN_ORIGIN_Y;
        const { x, y } = findNonOverlappingPinPosition(
          elements, startX, startY,
          ROBOT_STEPS_FRAME_WIDTH, ROBOT_STEPS_FRAME_HEIGHT, PIN_GAP, "down",
        );
        const frame = buildFrameElement({
          x, y, width: ROBOT_STEPS_FRAME_WIDTH, height: ROBOT_STEPS_FRAME_HEIGHT,
          name: "Robot steps",
          customData: {
            aiChatType: ROBOT_STEPS_FRAME_MARKER,
            [ROBOT_STEPS_TITLE_KEY]: title,
            [ROBOT_STEPS_KEY]: serializeRobotSteps([]),
          },
        });
        if (!frame) return null;
        api.updateScene({ elements: [...elements, frame] });
        api.scrollToContent([frame], { fitToViewport: false, animate: true });
        return frame.id;
      } catch (err) {
        console.error("ensureRobotStepsFrame failed", err);
        return null;
      }
    },
    [apiRef, patchFrameCustomData],
  );

  const persistRobotSteps = useCallback(
    (frameId: string, steps: RobotStep[]): void => {
      patchFrameCustomData(frameId, { [ROBOT_STEPS_KEY]: serializeRobotSteps(steps) });
    },
    [patchFrameCustomData],
  );

  /** Clear the singleton monitor frame's persisted image (no-op if none exists),
   *  and RETURN its id so the caller can also drop any stale live-state entry.
   *  Called when a NEW browse starts so the monitor doesn't keep showing the
   *  previous browse's screenshot on a turn that logs but never screenshots (the
   *  log frame is retitled/cleared on its own first line; this keeps the two panels
   *  in sync). A browse that does screenshot refills it from its first live frame. */
  const clearBrowseMonitorImage = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    const existing = findBrowseMonitorFrame(api.getSceneElements());
    if (!existing) return null;
    patchFrameCustomData(existing.id, { [BROWSE_MONITOR_IMAGE_KEY]: "" });
    return existing.id;
  }, [apiRef, patchFrameCustomData]);

  const commitImagePin = useCallback(
    async ({ dataURL, mimeType, customData, startAt }: {
      dataURL: string;
      mimeType: string;
      customData: Record<string, unknown>;
      startAt?: { x: number; y: number };
    }) => {
      const api = apiRef.current;
      if (!api) return;
      // Place at native pixel size (1 world unit = 1 source px) so on-canvas size
      // honestly reflects resolution: two 2048² images render identically, and a
      // 2048² is visibly larger than a 1024². pinElements frames oversized ones.
      const { width, height } = await imageDimensionsFromDataURL(dataURL);
      const fileId = crypto.randomUUID() as FileId;
      api.addFiles([buildBinaryFile(fileId, dataURL, mimeType)]);
      pinElements(width, height, ({ x, y }) => [
        { type: "image", x, y, width, height, fileId, status: "saved", customData },
      ], startAt, { fit: true });
    },
    [apiRef, pinElements],
  );

  const pinImage = useCallback(
    async ({ url, dedupKey, startAt }: {
      url: string; dedupKey: string; startAt?: { x: number; y: number };
    }) => {
      if (!apiRef.current || seenIdsRef.current.has(dedupKey)) return;
      // Claim the key BEFORE the fetch — two concurrent pinImage calls with
      // the same key should fan out to only one fetch, not two.
      seenIdsRef.current.add(dedupKey);
      const { dataURL, mimeType } = await fetchAsDataURL(url);
      await commitImagePin({
        dataURL,
        mimeType,
        startAt,
        customData: {
          aiChatType: "note-image",
          aiChatAssetKey: dedupKey,
          aiChatImageUrl: url,
        },
      });
    },
    [apiRef, commitImagePin],
  );

  const pinMergedImage = useCallback(
    async ({ dataURL, mimeType, dedupKey, startAt }: {
      dataURL: string; mimeType: string; dedupKey: string; startAt?: { x: number; y: number };
    }) => {
      if (!apiRef.current || seenIdsRef.current.has(dedupKey)) return;
      seenIdsRef.current.add(dedupKey);
      await commitImagePin({
        dataURL,
        mimeType,
        startAt,
        customData: {
          aiChatType: "note-image",
          aiChatAssetKey: dedupKey,
        },
      });
    },
    [apiRef, commitImagePin],
  );

  const pinVideo = useCallback(
    ({ videoUrl, dedupKey, startAt }: {
      videoUrl: string; dedupKey: string; startAt?: { x: number; y: number };
    }) => {
      if (seenIdsRef.current.has(dedupKey)) return;
      if (!apiRef.current) return;
      seenIdsRef.current.add(dedupKey);

      // Rectangle + text grouped — Excalidraw's `link` on rectangle gets a
      // clickable button in the toolbar when selected, opening in a new tab.
      const groupId = crypto.randomUUID();
      pinElements(VIDEO_CARD_WIDTH, VIDEO_CARD_HEIGHT, ({ x, y }) => [
        {
          type: "rectangle",
          x,
          y,
          width: VIDEO_CARD_WIDTH,
          height: VIDEO_CARD_HEIGHT,
          strokeColor: VIDEO_CARD_STROKE,
          backgroundColor: VIDEO_CARD_BG,
          groupIds: [groupId],
          link: videoUrl,
          customData: {
            aiChatType: "note-video",
            aiChatAssetKey: dedupKey,
            aiChatVideoUrl: videoUrl,
          },
        },
        {
          type: "text",
          x: x + 20,
          y: y + 34,
          text: "▶ Watch video",
          fontSize: 20,
          strokeColor: VIDEO_CARD_STROKE,
          groupIds: [groupId],
          link: videoUrl,
        },
      ], startAt);
    },
    [apiRef, pinElements],
  );

  // ── Pre-generation placeholder flow ───────────────────────────────────────

  /** Build + append a placeholder at exact geometry. Caller is responsible for
   *  finding an empty slot (createPlaceholder) or reusing base geometry
   *  (createPlaceholderOverlay); `nextYRef` / scrolling stay at the caller so
   *  overlay stacking doesn't waste slots. Returns the fresh `rect` too so the
   *  caller can pass it to `scrollToContent` without a second O(N) scene scan. */
  const buildPlaceholderAt = useCallback(
    (
      kind: JobKind,
      label: string,
      x: number,
      y: number,
      width: number,
      height: number,
      permanentLabel?: string,
    ): { placeholder: PinPlaceholder; rect: ExcalidrawElement } | null => {
      const api = apiRef.current;
      if (!api) return null;
      const existing = api.getSceneElements();

      const groupId = crypto.randomUUID();
      const wrapped = wrapText(label, MAX_LINE_UNITS);
      const placeholderType = `note-${kind}${PLACEHOLDER_TYPE_SUFFIX}`;
      const initialCustomData = { aiChatType: placeholderType, aiChatStatus: PLACEHOLDER_STATUS_PENDING };
      // 永久 label 是 rect 上方的独立元素 (无 groupId, 不进 placeholder 组),
      // 走 replace/markFailed 时不被识别, 自然存活 — 替代了"text in placeholder"
      // 的逻辑捆绑. 字号 / 颜色刻意比 loading status 显眼一档, 区分语义。
      const labelSkeleton: ElementSkeleton = permanentLabel ? [{
        type: "text",
        x,
        y: y - PACK_LABEL_HEIGHT - PACK_LABEL_GAP,
        width,
        height: PACK_LABEL_HEIGHT,
        text: permanentLabel,
        fontSize: PACK_LABEL_FONT_SIZE,
        strokeColor: PACK_LABEL_COLOR,
        backgroundColor: "transparent",
        textAlign: "left",
        verticalAlign: "top",
      }] : [];
      const skeleton: ElementSkeleton = [
        ...labelSkeleton,
        {
          type: "rectangle",
          x,
          y,
          width,
          height,
          // The visible loading effect is the shimmer overlay
          // (CanvasGeneratingOverlay); this rect is an invisible bounds
          // reservation so no dashed box peeks around the overlay's rounded
          // corners. (The failed tombstone recolors the status text to red.)
          strokeColor: "transparent",
          backgroundColor: "transparent",
          groupIds: [groupId],
          customData: initialCustomData,
        },
        {
          type: "text",
          x: x + 16,
          y: y + 16,
          width: width - 32,
          height: estimateHeight(wrapped, PLACEHOLDER_LINE_HEIGHT_PX),
          text: wrapped,
          fontSize: 16,
          strokeColor: PLACEHOLDER_TEXT_COLOR,
          backgroundColor: "transparent",
          textAlign: "left",
          verticalAlign: "top",
          groupIds: [groupId],
          customData: initialCustomData,
        },
      ];

      const created = convertToExcalidrawElements(skeleton);
      const expectedCount = permanentLabel ? 3 : 2;
      if (created.length < expectedCount) return null;
      // 顺序跟 skeleton 一致: [labelText?, rect, statusText]
      const labelText = permanentLabel ? created[0] : null;
      const rect = permanentLabel ? created[1] : created[0];
      const text = permanentLabel ? created[2] : created[1];

      api.updateScene({ elements: [...existing, ...created] });

      return {
        placeholder: {
          rectId: rect.id,
          textId: text.id,
          groupId,
          x, y, width, height, kind,
          labelTextId: labelText?.id,
        },
        rect,
      };
    },
    [apiRef],
  );

  const createPlaceholder = useCallback(
    (
      kind: JobKind,
      label: string,
      anchor?: PinAnchor,
      layout?: PinLayoutOptions,
      resultSize?: { width: number; height: number },
    ): PinPlaceholder | null => {
      const api = apiRef.current;
      if (!api) return null;

      const existing = api.getSceneElements();

      // Pack-mode 触发条件: slot_index 是非负整数。同 helper 跟 page 的 tool-
      // call args 解析保持一致 (toolArgAsNonNegInt 把 NaN/float/负数/string-int
      // 全部归一); 这里作 defense-in-depth, 防其他未来调用方绕过 page 直接
      // createPlaceholder 时仍能拦住坏 slot_index。label-only / slot-only 两种
      // partial 情形都允许走 pack 排版 — 但只在 permanentLabel 真的存在时才在
      // rect 上方预留 labelPad (= PACK_LABEL_HEIGHT + GAP) 的 label 余量, 否则出现 "phantom band"。
      const slotIdx = toolArgAsNonNegInt(layout?.slotIndex);

      // Loading-box 尺寸 (image 占位, 非 video): 让虚线框和最终结果一样大 —— 结果按
      // native 尺寸落在框中心 (见 replacePlaceholderWithImage)。优先级: resultSize
      // (预期生成图尺寸, 如 image-edit / pack 升到 2K/4K) > anchor 源图 rect
      // (cutout/angle/split 等保持源尺寸) > 固定方块 (agent 无源图)。
      // Pack-mode (slot_index 横排) 也必须走 resultSize: slot 之间按 `width` 间隔,
      // 若框定死成 400² 而结果是 2048², 每张结果按 native 尺寸落在 416px 间距的
      // slot 中心 → 7 张全叠在一起 (用户报的"叠加")。框=结果尺寸后, slot 间隔
      // = 2048+gap, 结果落在同尺寸框正中, 互不重叠。
      const hasPositiveSize = (
        b: { width: number; height: number } | undefined,
      ): b is { width: number; height: number } => !!b && b.width > 0 && b.height > 0;
      const imageBox =
        kind === "video"
          ? null
          : hasPositiveSize(resultSize)
            ? resultSize
            : hasPositiveSize(anchor)
              ? anchor
              : null;
      const width =
        kind === "video" ? PLACEHOLDER_VIDEO_WIDTH : imageBox ? imageBox.width : PLACEHOLDER_IMAGE_DIM;
      const height =
        kind === "video" ? PLACEHOLDER_VIDEO_HEIGHT : imageBox ? imageBox.height : PLACEHOLDER_IMAGE_DIM;

      let x: number;
      let y: number;
      // Pack-mode 整行 x 起点 (claim 后由 post-build 写进 packRowStartXRef)。
      let packRowStartX: number | null = null;
      const labelPad = layout?.permanentLabel
        ? PACK_LABEL_HEIGHT + PACK_LABEL_GAP
        : 0;
      let claimNewPackRow = false;
      if (slotIdx !== undefined) {
        // 横排锚点: 整行的 x 起点 (packRowStartXRef) 和 y (packRowYRef) 都在第一个
        // 到达的 slot 处一次性 claim, 后续 slots 复用 —— slot_index 决定 x 偏移。不依赖
        // "slot_index === 0 先到" (LLM 并行 tool_calls 顺序无保证); x 也不每个 slot
        // 重算 (否则 chat frame 在并行 slot 之间被拖动 → 后到的 slot 整行错位)。
        let rowStartX: number;
        if (packRowYRef.current === null || packRowStartXRef.current === null) {
          rowStartX = resolveChatColumnAnchor().startX;
          // Claim row: 不直接用 nextYRef.current, 而是用整行宽度 (PACK_ROW_SLOTS
          // 个 slot 的 worst-case footprint) 做 collision check, 否则同 scene 内
          // 第二次生 pack 时整行会糊到上一次的图上 (slot 0 偏巧避开了, slot
          // 1..6 全堆叠). findNonOverlap 走 "down" 方向所以 x 不动, 我们只取 y。
          const rowWidth = PACK_ROW_SLOTS * width + (PACK_ROW_SLOTS - 1) * PIN_GAP;
          const baseY = nextYRef.current + labelPad;
          ({ y } = findNonOverlappingPinPosition(
            existing, rowStartX, baseY, rowWidth, height, PIN_GAP, "down",
          ));
          claimNewPackRow = true;
        } else {
          rowStartX = packRowStartXRef.current;
          y = packRowYRef.current;
        }
        x = rowStartX + slotIdx * (width + PIN_GAP);
        packRowStartX = rowStartX;
      } else {
        // 默认: anchored → 选区右侧同 y; 非 anchored → chat 列 + 垂直堆叠
        const { startX, startY } = anchor
          ? { startX: anchor.x + anchor.width + PIN_GAP, startY: anchor.y }
          : resolveChatColumnAnchor();
        // 有 permanentLabel 时 (非 pack mode, agent 单图带标签的少见场景): label
        // 画在 rect 上方 labelPad (= PACK_LABEL_HEIGHT + GAP)。startY 不补这段,
        // findNonOverlappingPinPosition 只按 rect height 找位置, label 区域会压到
        // 上一个 pin (labelPad - PIN_GAP 的重叠)。把搜索起点下移 labelPad 还原 PIN_GAP 边界。
        const adjustedStartY = startY + labelPad;
        const direction = anchor ? "right" : "down";
        ({ x, y } = findNonOverlappingPinPosition(
          existing, startX, adjustedStartY, width, height, PIN_GAP, direction,
        ));
      }

      const built = buildPlaceholderAt(kind, label, x, y, width, height, layout?.permanentLabel);
      // Ref mutation 推迟到 build 成功后 — Excalidraw 拒 skeleton (返回数量不足
      // expectedCount) 时 buildPlaceholderAt 返 null, 此时 ref 不能已经被污染,
      // 否则后续 slots 会落在 phantom 行上、slot 0 留空。
      if (!built) return null;

      // 现在 build 成功了, 可以安全推进 refs。
      if (slotIdx !== undefined && claimNewPackRow) {
        packRowYRef.current = y;
        packRowStartXRef.current = packRowStartX;
        nextYRef.current = y + height + PIN_GAP;
      } else if (!anchor && slotIdx === undefined) {
        // 默认 chat column: 只有非 anchor 且非 pack mode 才推进
        // (anchor 用源图旁; pack mode 在 claim 时统一推进过整行)
        nextYRef.current = y + height + PIN_GAP;
      }
      // Frame the reserved box (zooms out only if it overflows — the result-sized
      // box can be 2K/4K). Small boxes (agent 400² / video) just gently scroll, as
      // before. Keeps the loading box fully visible and avoids a jump when the
      // result later frames itself.
      frameToContent(api, [built.rect]);
      return built.placeholder;
    },
    [apiRef, buildPlaceholderAt, resolveChatColumnAnchor],
  );

  const createPlaceholderOverlay = useCallback(
    (base: PinPlaceholder, label: string): PinPlaceholder | null =>
      buildPlaceholderAt(base.kind, label, base.x, base.y, base.width, base.height)?.placeholder
      ?? null,
    [buildPlaceholderAt],
  );

  /** Shared text mutator: updatePlaceholderLabel (grey) and markPlaceholderFailed
   *  (red) both route here to keep the public API honest — no hidden flags. */
  const writePlaceholderText = useCallback(
    (placeholder: PinPlaceholder, label: string, color: string) => {
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getSceneElements();
      const target = existing.find((el) => el.id === placeholder.textId);
      if (!target || target.type !== "text") return;
      const wrapped = wrapText(label, MAX_LINE_UNITS);
      if (target.text === wrapped && target.strokeColor === color) return;
      const updated = newElementWith(target, {
        text: wrapped,
        originalText: wrapped,
        strokeColor: color,
      });
      api.updateScene({
        elements: existing.map((el) => (el.id === placeholder.textId ? updated : el)),
      });
    },
    [apiRef],
  );

  const updatePlaceholderLabel = useCallback(
    (placeholder: PinPlaceholder, label: string) =>
      writePlaceholderText(placeholder, label, PLACEHOLDER_TEXT_COLOR),
    [writePlaceholderText],
  );

  const markPlaceholdersFailed = useCallback(
    (placeholders: PinPlaceholder[], reason?: string) => {
      if (placeholders.length === 0) return;
      const api = apiRef.current;
      if (!api) return;
      const msg = reason ? `Generation failed: ${reason}` : "Generation failed";
      const wrapped = wrapText(msg, MAX_LINE_UNITS);
      // 同时改 text/color (rect+text 都要), 又把 customData.aiChatStatus 翻 "failed"
      // —— 否则 isPendingPlaceholder 仍认它 pending, resume scan 下次 reload 把这个
      // 已死的 placeholder 当 tagless 重新挑出来又标 "submission lost", 多 cycle
      // 累积一堆失败鬼影, 还会被 useResumeCanvasJobs 当 leftover 干扰 active job 配对.
      // Batched: 一次 getSceneElements + 一次 updateScene 覆盖所有 N 个 placeholder,
      // 避免 N 次 Excalidraw 重渲 (chat n>1 路径常见 N=4).
      const targets = new Set<string>();
      for (const ph of placeholders) {
        targets.add(ph.rectId);
        targets.add(ph.textId);
      }
      const next = api.getSceneElements().map((el) => {
        if (!targets.has(el.id)) return el;
        const customData = { ...(el.customData ?? {}), aiChatStatus: PLACEHOLDER_STATUS_FAILED };
        if (el.type === "text" && (el.text !== wrapped || el.strokeColor !== PLACEHOLDER_ERROR_TEXT_COLOR)) {
          return newElementWith(el, {
            text: wrapped,
            originalText: wrapped,
            strokeColor: PLACEHOLDER_ERROR_TEXT_COLOR,
            customData,
          });
        }
        return newElementWith(el, { customData });
      });
      api.updateScene({ elements: next });
    },
    [apiRef],
  );

  const markPlaceholderFailed = useCallback(
    (placeholder: PinPlaceholder, reason?: string) =>
      markPlaceholdersFailed([placeholder], reason),
    [markPlaceholdersFailed],
  );

  /** Stamp the placeholder's rect+text customData with the backend job_id so
   *  scene autosave persists it. After reload, the resume scan finds these
   *  placeholders and continues polling instead of leaving them stuck. */
  const tagPlaceholderWithJob = useCallback(
    (placeholder: PinPlaceholder, jobId: string) => {
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getSceneElements();
      const targets = new Set([placeholder.rectId, placeholder.textId]);
      const next = existing.map((el) =>
        targets.has(el.id)
          ? newElementWith(el, {
              customData: {
                ...(el.customData ?? {}),
                [CANVAS_JOB_ID_KEY]: jobId,
                [CANVAS_JOB_KIND_KEY]: placeholder.kind,
              },
            })
          : el,
      );
      api.updateScene({ elements: next });
    },
    [apiRef],
  );

  /** Soft-delete placeholder rect+text (preserves Excalidraw undo history via
   *  `isDeleted`), append `created` at the tail in a single updateScene call. */
  const commitPlaceholderReplace = useCallback(
    (placeholder: PinPlaceholder, created: readonly ExcalidrawElement[]) => {
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getSceneElements();
      const deleteIds = new Set([placeholder.rectId, placeholder.textId]);
      const nextElements = existing.map((el) =>
        deleteIds.has(el.id) ? newElementWith(el, { isDeleted: true }) : el,
      );
      api.updateScene({ elements: [...nextElements, ...created] });
    },
    [apiRef],
  );

  /** Claim the dedup key so concurrent callers short-circuit. Returns true if
   *  the caller should proceed to build + commit; false means the key was
   *  already claimed (orphan placeholder gets soft-deleted silently) or the
   *  API isn't mounted. Split from the commit step so async paths (image fetch)
   *  can claim BEFORE doing expensive work. */
  const claimForReplace = useCallback(
    (placeholder: PinPlaceholder, dedupKey: string): boolean => {
      if (!apiRef.current) return false;
      if (seenIdsRef.current.has(dedupKey)) {
        commitPlaceholderReplace(placeholder, []);
        return false;
      }
      seenIdsRef.current.add(dedupKey);
      return true;
    },
    [apiRef, commitPlaceholderReplace],
  );

  const replacePlaceholderWithImage = useCallback(
    async (placeholder: PinPlaceholder, { url, dedupKey }: { url: string; dedupKey: string }) => {
      // Claim BEFORE fetch so two concurrent calls with the same dedupKey
      // don't both decode the image + addFiles the result.
      if (!claimForReplace(placeholder, dedupKey)) return;

      const { dataURL, mimeType } = await fetchAsDataURL(url);
      // Size the result to FIT its reserved box (preserve aspect), centered on the
      // box center. The box was reserved at the PREDICTED result size, but img2img
      // can echo a source larger than the tier prediction (e.g. a 2968² product
      // photo for a "1:1" 2K request). A larger-than-box result placed at native
      // size, centered, overflows into the adjacent pack slot / column item →
      // overlap (用户报的"重叠")。Capping keeps every result strictly inside its
      // non-overlapping reserved box; result ≤ box → scale 1 (native size, no change).
      const { width: nativeW, height: nativeH } = await imageDimensionsFromDataURL(dataURL);
      const fit =
        nativeW > 0 && nativeH > 0
          ? Math.min(1, placeholder.width / nativeW, placeholder.height / nativeH)
          : 1;
      const width = Math.round(nativeW * fit);
      const height = Math.round(nativeH * fit);
      const x = placeholder.x + placeholder.width / 2 - width / 2;
      const y = placeholder.y + placeholder.height / 2 - height / 2;

      // Scene might have switched during the fetch; bail before touching API.
      const api = apiRef.current;
      if (!api) return;

      const fileId = crypto.randomUUID() as FileId;
      api.addFiles([buildBinaryFile(fileId, dataURL, mimeType)]);

      const created = convertToExcalidrawElements([
        {
          type: "image",
          x,
          y,
          width,
          height,
          fileId,
          status: "saved",
          customData: {
            aiChatType: "note-image",
            aiChatAssetKey: dedupKey,
            aiChatImageUrl: url,
          },
        },
      ]);
      if (created.length) {
        commitPlaceholderReplace(placeholder, created);
        frameToContent(api, created);
      }
    },
    [apiRef, claimForReplace, commitPlaceholderReplace],
  );

  const replacePlaceholderWithVideo = useCallback(
    (placeholder: PinPlaceholder, { videoUrl, dedupKey }: { videoUrl: string; dedupKey: string }) => {
      if (!claimForReplace(placeholder, dedupKey)) return;

      const width = Math.min(VIDEO_CARD_WIDTH, placeholder.width);
      const height = Math.min(VIDEO_CARD_HEIGHT, placeholder.height);
      const x = placeholder.x + (placeholder.width - width) / 2;
      const y = placeholder.y + (placeholder.height - height) / 2;
      const groupId = crypto.randomUUID();

      const created = convertToExcalidrawElements([
        {
          type: "rectangle",
          x,
          y,
          width,
          height,
          strokeColor: VIDEO_CARD_STROKE,
          backgroundColor: VIDEO_CARD_BG,
          groupIds: [groupId],
          link: videoUrl,
          customData: {
            aiChatType: "note-video",
            aiChatAssetKey: dedupKey,
            aiChatVideoUrl: videoUrl,
          },
        },
        {
          type: "text",
          x: x + 20,
          y: y + height / 2 - 14,
          text: "▶ Watch video",
          fontSize: 20,
          strokeColor: VIDEO_CARD_STROKE,
          groupIds: [groupId],
          link: videoUrl,
        },
      ]);
      if (created.length) commitPlaceholderReplace(placeholder, created);
    },
    [claimForReplace, commitPlaceholderReplace],
  );

  return {
    ensureChatFrame,
    ensureBrowseLogFrame,
    persistBrowseLogText,
    ensureBrowseMonitorFrame,
    persistBrowseMonitorImage,
    clearBrowseMonitorImage,
    ensureRobotStepsFrame,
    persistRobotSteps,
    pinImage,
    pinVideo,
    pinMergedImage,
    createPlaceholder,
    createPlaceholderOverlay,
    updatePlaceholderLabel,
    replacePlaceholderWithImage,
    replacePlaceholderWithVideo,
    markPlaceholderFailed,
    markPlaceholdersFailed,
    tagPlaceholderWithJob,
    reset,
    resetPackRow,
  };
}
