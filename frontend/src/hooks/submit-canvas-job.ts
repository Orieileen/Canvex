import type { MutableRefObject, RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { waitForCanvasJob } from "@/services/canvas.service";
import { extractApiError } from "@/services/errors";
import {
  pinCanvasJobResult,
  type CanvasEditPinning,
  type JobKind,
  type PinAnchor,
  type PinPlaceholder,
} from "@/hooks/use-canvas-pinning";

/**
 * Shared submit skeleton for all three ImageEditBar hooks (image / video /
 * angle). Each caller supplies a `createJob` closure over its own payload
 * shape + an optional `preflight` guard.
 *
 * 关键: submitting/inFlight 只锁到 createJob 返回为止 (~POST 一个网络往返).
 * POST 成功后立刻解锁, 让用户在 polling 期间能排下一个 job — 否则 image 生
 * 成等 30-120s, toolbar 锁这么久太呆. Polling 在背景继续, 失败照样 markFailed.
 *
 * Pure async — NOT a hook. Called from inside a hook's `submit` useCallback,
 * which is also where the config (refs, setters, sceneId) is closed over.
 *
 * Canvex: 免费无钱包, 不接 billing —— meired 的 dispatch(loadBilling()) 收尾
 * 已删 (创建失败 / settled 后都无需校准余额)。
 */

export interface SubmitCanvasJobConfig {
  /** Routing key for waitForCanvasJob, pinCanvasJobResult, and placeholder
   *  sizing. Angle uses "angle" even though results are image-shaped; the
   *  placeholder falls into image dims because it's `!== "video"`. */
  kind: JobKind;
  placeholderLabel: string;
  /** Prefix prepended to network errors surfaced via `setError`. */
  errorMessage: string;
  sceneId: string | null;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  sceneAbortRef: RefObject<AbortController | null>;
  pinning: CanvasEditPinning;
  inFlightRef: MutableRefObject<boolean>;
  setError: (reason: string | null) => void;
  setSubmitting: (value: boolean) => void;
  /** Runs before the latch and placeholder. Return an error string to abort
   *  with setError; return null to proceed. Used by video/angle to refuse
   *  non-chat-pinned images (fal / tu-zi can't fetch a local dataURL). */
  preflight?: () => string | null;
  /** Source selection's world-space rect. When present, the placeholder (and
   *  n>1 extra results via `pinAssetResultRows`) land to the right of this
   *  rect instead of in the chat left column. Pass `selection.bounds`. */
  anchor?: PinAnchor;
  /** Expected size of the generated result (e.g. image-edit's 2K/4K output).
   *  Sizes the loading box to the result rather than the source; omit to fall
   *  back to the `anchor` rect (cutout / angle / split keep the source size). */
  resultSize?: { width: number; height: number };
  /** The provider-specific POST. Returns the enqueued response — helper
   *  takes over polling + pinning from there. */
  createJob: () => Promise<{ data: { job_id: string; status: string } }>;
}

export async function submitCanvasJob(cfg: SubmitCanvasJobConfig): Promise<void> {
  if (!cfg.sceneId || !cfg.excalidrawApiRef.current) return;

  const preflightError = cfg.preflight?.();
  if (preflightError) {
    cfg.setError(preflightError);
    return;
  }

  // POST 期间用 ref 同步上锁防双击重复提交 (React setState 不同步刷新);
  // POST 返回就释放, 之后用户排第二个 job 不算重复.
  if (cfg.inFlightRef.current) return;
  cfg.inFlightRef.current = true;

  cfg.setError(null);
  cfg.setSubmitting(true);
  const placeholder = cfg.pinning.createPlaceholder(
    cfg.kind, cfg.placeholderLabel, cfg.anchor, undefined, cfg.resultSize,
  );

  let enqueued: { job_id: string; status: string };
  try {
    ({ data: enqueued } = await cfg.createJob());
    // Stamp job_id into placeholder customData BEFORE polling so scene
    // autosave captures it — 关页重进时 backend active-jobs 能按 jobId 配对.
    if (placeholder) cfg.pinning.tagPlaceholderWithJob(placeholder, enqueued.job_id);
  } catch (err) {
    reportJobError(err, placeholder, cfg);
    cfg.inFlightRef.current = false;
    cfg.setSubmitting(false);
    return;
  }

  // POST 成功 → 解锁 toolbar, polling 跑背景. 用户能立刻提交下一个 job;
  // 多 job 并行 polling 互不干扰 (各自的 placeholder + jobId).
  cfg.inFlightRef.current = false;
  cfg.setSubmitting(false);

  try {
    const signal = cfg.sceneAbortRef.current?.signal;
    const job = await waitForCanvasJob(cfg.kind, enqueued.job_id, { signal });
    if (signal?.aborted) return;
    const result = await pinCanvasJobResult(
      cfg.kind, job, enqueued.job_id, placeholder ? [placeholder] : [], cfg.pinning,
    );
    if (!result.ok) cfg.setError(result.reason);
  } catch (err) {
    reportJobError(err, placeholder, cfg);
  }
}

/** Abort 静默 (用户切 scene / 关页), 其他错误 → markFailed + setError. */
function reportJobError(
  err: unknown,
  placeholder: PinPlaceholder | null,
  cfg: Pick<SubmitCanvasJobConfig, "errorMessage" | "pinning" | "setError">,
): void {
  if ((err as DOMException)?.name === "AbortError") return;
  const reason = extractApiError(err, cfg.errorMessage);
  if (placeholder) cfg.pinning.markPlaceholderFailed(placeholder, reason);
  cfg.setError(reason);
}
