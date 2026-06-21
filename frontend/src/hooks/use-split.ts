import { useCallback, useRef, useState, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasService, waitForCanvasJob } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import {
  pinAssetResultRows,
  selectionToCleanSourceFile,
  type CanvasEditPinning,
} from "@/hooks/use-canvas-pinning";
import type { CanvasSelection } from "@/hooks/use-canvas-selection";
import { imageEditSizeSource } from "@/hooks/use-image-edit";
import { imageEditOutputSize } from "@/lib/canvas-image-output-size";
import { subjectRegionClause } from "@/lib/canvas-spatial-prompt";
import type { CanvasImageEditJob } from "@/types/canvex";

/**
 * Split 把一张图拆成 cutout (透明底主体) + inpaint (去除主体的背景),两个结果
 * pin 在同一槽位 —— 主体在上, 背景在下。
 *
 * Atomic 语义 (跟 backend 协调):
 *   - 一次 POST 调 /scenes/<id>/split/, backend 创两条 leg + 互填 split_partner.
 *   - 双成功 → pin 两张.
 *   - 任一失败 → 不 pin 任何一张, 标 placeholder failed. backend task 收口自动处理
 *     两条 leg 的协调 (`_check_split_pair_for_refund`)。
 *   - 全部 atomic 在 backend 处理, 前端不调任何 settle 端点。
 *
 * 不走 submitCanvasJob: 那个是单 job 单 placeholder 的 skeleton, Split 有两条腿 +
 * 固定 pin 顺序 (z-order 靠后 append 拿顶层) + 双成功才 pin 的 atomic 约束,
 * 嵌进去会污染共享路径。
 *
 * Canvex: 免费无钱包 —— meired 的 dispatch(loadBilling()) 收尾已删。
 */

export interface SubmitSplitParams {
  selection: CanvasSelection;
}

export function useSplit({
  sceneId,
  excalidrawApiRef,
  pinning,
  sceneAbortRef,
}: {
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  pinning: CanvasEditPinning;
  sceneAbortRef: RefObject<AbortController | null>;
}): {
  isSubmitting: boolean;
  error: string | null;
  submit: (params: SubmitSplitParams) => Promise<void>;
  dismissError: () => void;
} {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async ({ selection }: SubmitSplitParams) => {
      if (!sceneId || !excalidrawApiRef.current) return;
      // UI disables Split tab for multi-image; type-level narrow for
      // selectionToSourceFile's SingleSourceSelection signature.
      if (selection.kind === "multi-image") {
        setError("Split requires a single-image or image-with-shapes selection");
        return;
      }
      const narrowed = selection;
      // POST 期间用 ref 同步上锁防双击 (React setState 不同步刷新);
      // POST 返回就释放, polling 跑背景 — 跟 submit-canvas-job.ts 同模式.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setIsSubmitting(true);

      // background 先建 (占槽位), subject overlay 叠在它上面 —— 颠倒顺序的话
      // overlay 会把占槽位那个盖掉, 下一次生成从重叠位置起步。
      // Anchor 到源右侧: 和 image/video/angle 三 hook 同一个 UX 契约.
      // 两条 leg (背景 inpaint + 主体 cutout) 都是 LLM 在 2K 档位重生成 (backend
      // size=auto), 不是源图尺寸 → 预留框按生成尺寸算, 否则结果撑爆/缩在小框里。
      // 主体 overlay 复用此 geometry (createPlaceholderOverlay)。
      const backgroundPh = pinning.createPlaceholder(
        "image", "Splitting background…", narrowed.bounds, undefined,
        imageEditOutputSize("auto", undefined, imageEditSizeSource(narrowed)),
      );
      const subjectPh = backgroundPh
        ? pinning.createPlaceholderOverlay(backgroundPh, "Splitting subject…")
        : null;

      const failBothLegs = (reason: string) => {
        if (backgroundPh) pinning.markPlaceholderFailed(backgroundPh, reason);
        if (subjectPh) pinning.markPlaceholderFailed(subjectPh, reason);
        setError(`Split failed: ${reason}`);
      };

      let enqueued: Awaited<ReturnType<typeof canvasService.createSplit>>["data"];
      try {
        const api = excalidrawApiRef.current;
        if (!api) {
          inFlightRef.current = false;
          setIsSubmitting(false);
          return;
        }
        // Plan B: 干净源(不烧框)。框选出的主体区域转坐标文字 → 随 POST 带给
        // backend, 拼进 SPLIT_INPAINT_PROMPT / CUTOUT_LLM_PROMPT 当主体定位; 无框→空。
        const file = await selectionToCleanSourceFile(narrowed, api);
        const region = subjectRegionClause({
          image: narrowed.image,
          shapes: narrowed.kind === "image-with-shapes" ? narrowed.shapes : [],
        });
        // 一次 POST 起 atomic pair, backend 自动处理双 leg 的协调 + 任一失败时收口.
        ({ data: enqueued } = await canvasService.createSplit(sceneId, file, region));
        // 立刻 tag 两个 placeholder 带各自的 job_id —— 关页+重进时 resume hook
        // 按 job_id 配对 (cutout rembg 秒级完成, 不 tag 的话会被当 tagless leftover
        // 标 "submission lost").
        if (backgroundPh) pinning.tagPlaceholderWithJob(backgroundPh, enqueued.background.job_id);
        if (subjectPh) pinning.tagPlaceholderWithJob(subjectPh, enqueued.cutout.job_id);
      } catch (err) {
        // selectionToSourceFile / createSplit 创建失败
        if ((err as DOMException)?.name !== "AbortError") {
          failBothLegs(extractApiError(err, "Split failed"));
        }
        inFlightRef.current = false;
        setIsSubmitting(false);
        return;
      }

      // POST 成功 → 解锁 toolbar, polling 跑背景. 用户能立刻提交下一个 split / image / etc.
      inFlightRef.current = false;
      setIsSubmitting(false);

      try {
        const signal = sceneAbortRef.current?.signal;
        // allSettled (not all): 两腿独立成功/失败, 任一 reject 不 short-circuit 另一条。
        const [bgResult, subjResult] = await Promise.allSettled([
          waitForCanvasJob("image", enqueued.background.job_id, { signal }) as Promise<CanvasImageEditJob>,
          waitForCanvasJob("image", enqueued.cutout.job_id, { signal }) as Promise<CanvasImageEditJob>,
        ]);

        if (signal?.aborted) return;

        const result = classifySplitResult(bgResult, subjResult);
        if (result.status === "both_succeeded") {
          // 双成功 → pin 两张. 背景先 (底层), 主体后 (顶层 — Excalidraw 后 append
          // 元素自动 z-order 顶部, 透明 cutout 盖在背景上).
          await pinAssetResultRows(result.bg, backgroundPh ? [backgroundPh] : [], pinning);
          if (signal?.aborted) return;
          await pinAssetResultRows(result.subject, subjectPh ? [subjectPh] : [], pinning);
        } else {
          // 任一失败 → 都不 pin, 都标 failed. Backend 已经/会处理收口 (split
          // atomic collateral 在 task 收口跑, 不依赖前端调用).
          failBothLegs(result.reason);
        }
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        failBothLegs(extractApiError(err, "Split failed"));
      }
    },
    [sceneId, excalidrawApiRef, sceneAbortRef, pinning],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { isSubmitting, error, submit, dismissError };
}

/** Abort 归静默 (切 scene), 其他错误正常抽 message。返 null 表示不显示错误。 */
export function abortReasonOrMessage(reason: unknown, fallback: string): string | null {
  if ((reason as DOMException)?.name === "AbortError") return null;
  return extractApiError(reason, fallback);
}

type SplitClassification =
  | { status: "both_succeeded"; bg: CanvasImageEditJob; subject: CanvasImageEditJob }
  | { status: "partial_or_total_failure"; reason: string };

/** 把双 leg 的 allSettled 结果归类成 atomic outcomes. 双成功 only 才能 pin;
 *  任一 (job-level rejected OR job.status=FAILED) 算整体失败.
 *  Exported for unit tests. */
export function classifySplitResult(
  bgResult: PromiseSettledResult<CanvasImageEditJob>,
  subjResult: PromiseSettledResult<CanvasImageEditJob>,
): SplitClassification {
  // TS 用 status === "fulfilled" + value.status === "SUCCEEDED" 串联 narrow 出
  // value 类型, 不需要再 as PromiseFulfilledResult 强转.
  if (
    bgResult.status === "fulfilled" && bgResult.value.status === "SUCCEEDED"
    && subjResult.status === "fulfilled" && subjResult.value.status === "SUCCEEDED"
  ) {
    return { status: "both_succeeded", bg: bgResult.value, subject: subjResult.value };
  }
  const reason = legFailureReason(bgResult) ?? legFailureReason(subjResult) ?? "unknown failure";
  return { status: "partial_or_total_failure", reason };
}

function legFailureReason(result: PromiseSettledResult<CanvasImageEditJob>): string | null {
  if (result.status === "rejected") {
    return abortReasonOrMessage(result.reason, "leg failed");
  }
  if (result.value.status === "FAILED") {
    return result.value.error || "leg failed";
  }
  return null;
}
