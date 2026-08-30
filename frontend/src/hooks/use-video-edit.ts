import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService } from "@/services/canvas.service";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import {
  selectionToSourceFile,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
import { submitCanvasJob } from "@/hooks/submit-canvas-job";

/**
 * Submit an "image-to-video" job. Single-image selections only. Sends
 * `image_urls` JSON when sourceUrl is set, multipart File otherwise.
 */

/** 秒。**不是一个封闭的联合类型** —— 各家模型收的秒数差得离谱 (veo3 固定 8,
 *  sora 只收 4/8/12/16/20), 而那张表是后端按供应商文档下发的, 前端写不出穷举。
 *  后端 VideoJobCreateSerializer 会校验 1~60。 */
export type VideoDuration = number;
export type VideoAspectRatio = "16:9" | "9:16" | "1:1";

/** 画质档。**同样不是封闭联合** —— 各家的写法从 `360p` 到 `4k`, 还有 MiniMax 的 `2K`。
 *  空串 = 不发这个键, 由供应商用自己的默认。 */
export type VideoResolution = string;

/** 画布这边的偏好档。模型报了自己收哪几档时(见 CanvasImageModelChoice.allowed_resolutions)
 *  按 `nearestResolution` 落到最近的一档 —— 它是 720p 是因为这是 apimart 那 41 个视频
 *  模型里绝大多数的文档默认值。 */
export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = "720p";

/** 一个画质档在「贵 / 清晰」这条轴上的位置。`720p` → 720, `2K` → 2000, `4k` → 4000。
 *  不是真实像素, 只用来排序和挑最近的一个。认不出给 null。 */
function resolutionValue(tier: string): number | null {
  const text = tier.trim().toLowerCase();
  if (!text) return null;
  const unit = text.endsWith("k") ? 1000 : 1;
  // `[pk]+$` 而不是 `[pk]$`, 空头部要判掉 —— 两处都是为了跟后端那份 (Python 的
  // `rstrip("pk")` + `float()` 抛异常) 逐字对上。规则分叉的表现是选择器和真发出去的
  // 档不一样, 而那正是这两份代码存在的理由。
  const head = text.replace(/[pk]+$/, "");
  if (!head) return null;
  const value = Number(head);
  return Number.isFinite(value) ? value * unit : null;
}

/** 用户选的画质档 → 这个模型真的收的那一个。`allowed` 为空 = 原样返回。
 *
 *  **后端 `nearest_resolution` 有一份一样的**(services/image_client.py) —— 那边是真正
 *  的兜底(agent 挑的档也过它), 这边只是让选择器不显示一个模型收不了的档。两边规则要
 *  一致: 先大小写不敏感对一遍(同一档各家写 `720p` / `720P`), 再挑数值最近的, 平手取低
 *  的那个 —— 画质是按档计费的。 */
export function nearestResolution(want: string, allowed: readonly string[]): string {
  if (!allowed.length) return want;
  const hit = allowed.find((r) => r.toLowerCase() === want.trim().toLowerCase());
  if (hit) return hit;
  const target = resolutionValue(want);
  if (target === null) return allowed[0];
  let best = allowed[0];
  let bestScore = Infinity;
  let bestValue = Infinity;
  for (const tier of allowed) {
    const value = resolutionValue(tier);
    if (value === null) continue;
    const score = Math.abs(value - target);
    if (score < bestScore || (score === bestScore && value < bestValue)) {
      best = tier; bestScore = score; bestValue = value;
    }
  }
  return best;
}

/** 用户选的秒数 → 这个模型真的收的那一个。规则同 `nearestResolution`: 挑数值最近的,
 *  平手取短的 (时长直接决定计费)。后端 `nearest_duration` 是同一份。
 *
 *  **不能取列表第一项**: 从 seedance 的 15 秒换到 sora (只收 4/8/12/16/20), 第一项是
 *  4 秒 —— 用户拿到一条比要的短得多的片子, 而他什么都没改。 */
export function nearestDuration(want: number, allowed: readonly number[]): number {
  if (!allowed.length || allowed.includes(want)) return want;
  return allowed.reduce((best, d) =>
    Math.abs(d - want) < Math.abs(best - want) ||
    (Math.abs(d - want) === Math.abs(best - want) && d < best) ? d : best);
}

/** 画布默认给的三档。**只是默认** —— 模型自己报了支持的秒数时(见
 *  CanvasImageModelChoice.allowed_durations)选择器照那个列, 不用这三个。 */
export const VIDEO_DURATIONS: VideoDuration[] = [5, 10, 15];
export const VIDEO_ASPECT_RATIOS: VideoAspectRatio[] = ["16:9", "9:16", "1:1"];

export interface SubmitVideoEditParams {
  selection: CanvasSelection;
  prompt: string;
  duration: VideoDuration;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
}

export function useVideoEdit({
  sceneId,
  excalidrawApiRef,
  pinning,
  sceneAbortRef,
  videoModelIdRef,
}: {
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinning: CanvasEditPinning;
  sceneAbortRef: RefObject<AbortController | null>;
  /** Video tab 选的通道。用 ref 而不是值: 提交那一刻读最新的, 不用把它塞进依赖数组。 */
  videoModelIdRef: RefObject<string>;
}): {
  isSubmitting: boolean;
  error: string | null;
  submit: (params: SubmitVideoEditParams) => Promise<void>;
  dismissError: () => void;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ selection, prompt, duration, aspectRatio, resolution }: SubmitVideoEditParams) => {
      if (selection.kind !== "single-image") {
        setError("Video requires a single-image selection");
        return;
      }
      if (!selection.sourceUrl && !selection.fileId) {
        setError("Selected image has no source — pin it via chat first");
        return;
      }
      const sourceUrl = selection.sourceUrl;
      await submitCanvasJob({
        kind: "video",
        placeholderLabel: `Generating video (${duration}s)…`,
        errorMessage: "Video generation failed",
        sceneId, excalidrawApiRef, sceneAbortRef, pinning, inFlightRef,
        setError, setSubmitting: setIsSubmitting,
        anchor: selection.bounds,
        createJob: async () => {
          const api = excalidrawApiRef.current!;
          const base = {
            prompt, duration, aspect_ratio: aspectRatio, resolution,
            imageModelId: videoModelIdRef.current || undefined,
          };
          if (sourceUrl) {
            return canvasService.createVideo(sceneId!, { ...base, image_urls: [sourceUrl] });
          }
          const image = await selectionToSourceFile(selection, api);
          return canvasService.createVideo(sceneId!, { ...base, image });
        },
      });
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning, videoModelIdRef],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}
