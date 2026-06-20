import { useEffect, useRef, type RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  getCanvasJobTag,
  isPendingPlaceholder,
  type JobKind,
  type PinPlaceholder,
} from "@/hooks/use-canvas-pinning";
import { fetchActiveCanvasJobs, type CanvasActiveJob } from "@/services/canvas.service";

interface PendingBase {
  groupId: string;
  rectId: string;
  textId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pending placeholder whose customData carries a backend job_id we can pair
 *  to an active job. `getCanvasJobTag` always sets `jobId` and `kind` together
 *  so the union of the two is encoded in this shape (not optional). */
type TaggedPending = PendingBase & { jobId: string; kind: JobKind };

/** Pending placeholder created before tagPlaceholderWithJob landed (or whose
 *  tag autosave never reached the backend). No way to recover. */
type TaglessPending = PendingBase;

interface ResumeCanvasJobsArgs {
  sceneId: string | null;
  /** Set by `setScene` after `retrieveScene` completes; the scan only runs
   *  once Excalidraw has the elements loaded. */
  scene: unknown;
  /** Bumped by Excalidraw's `excalidrawAPI` callback — gate so we don't read
   *  elements before the imperative API is mounted. */
  apiVersion: number;
  excalidrawApiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /** Resume the actual job poll. Internally deduped via polledJobIdsRef in
   *  CanvasWorkspacePage, so re-firing is safe. Resume always supplies a
   *  single-element array — toolbar / split paths reserve 1 placeholder per
   *  job, and chat placeholders are tagless (chat skips
   *  `tagPlaceholderWithJob`), so multi-placeholder chat reservations land
   *  in the tagless queue and only the first gets paired with the live job.
   *  The other N-1 fall through to the "submission lost" branch below — a
   *  known UX regression for refresh-during-chat-n>1 that's deferred until
   *  multi-tag resume support lands. */
  pollAndPinJob: (kind: JobKind, jobId: string, placeholders: PinPlaceholder[]) => Promise<void>;
  /** Tombstone for placeholders whose corresponding job is no longer active
   *  on the backend (job finished while we were offline + result already
   *  pinned via the autosaved scene, OR job vanished — rare). */
  markPlaceholderFailed: (placeholder: PinPlaceholder, reason?: string) => void;
  /** Drop a fresh placeholder for a backend job that has no on-canvas
   *  representation — happens when the user closed the tab BEFORE autosave
   *  captured the original placeholder. */
  createPlaceholder: (kind: JobKind, label: string) => PinPlaceholder | null;
}

/** On scene reload, ask the backend which jobs are still QUEUED/RUNNING for
 *  this scene and re-attach the poller to each. Pairs them up with any
 *  pending placeholder already on the canvas (matched via the tagged
 *  customData.canvasJobId); creates a fresh placeholder for orphans.
 *
 *  Backend-as-source-of-truth: avoids the autosave race where
 *  `tagPlaceholderWithJob` writes the customData but the user closes the
 *  tab before the 1.5s debounce fires and the POST goes out.
 */
export function useResumeCanvasJobs({
  sceneId,
  scene,
  apiVersion,
  excalidrawApiRef,
  pollAndPinJob,
  markPlaceholderFailed,
  createPlaceholder,
}: ResumeCanvasJobsArgs) {
  // Per-scene guard against StrictMode double-invocation firing the fetch +
  // per-job poll trigger twice.
  const resumedSceneRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sceneId || !scene || apiVersion === 0) return;
    if (resumedSceneRef.current === sceneId) return;
    const api = excalidrawApiRef.current;
    if (!api) return;
    resumedSceneRef.current = sceneId;

    const abort = new AbortController();
    void (async () => {
      let activeJobs: CanvasActiveJob[] = [];
      try {
        activeJobs = await fetchActiveCanvasJobs(sceneId, { signal: abort.signal });
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        // Endpoint errors aren't fatal — the user can still create new jobs;
        // log so a stuck spinner has a Sentry/devtools breadcrumb.
        console.warn("useResumeCanvasJobs: active-jobs fetch failed", err);
        return;
      }
      if (abort.signal.aborted) return;

      const placeholdersByJobId = new Map<string, TaggedPending>();
      const taglessPlaceholders: TaglessPending[] = [];
      collectPendingPlaceholders(api, placeholdersByJobId, taglessPlaceholders);

      // Tagless 池: 配对 active job 时先消费这里, 用完才走 createPlaceholder.
      // 修 race: tagPlaceholderWithJob 在内存里写了 customData, 但 1.5s autosave
      // debounce 还没烧, 用户就关页了 — backend scene 上 placeholder 是 tagless,
      // 但 backend job 已经 active. 旧逻辑 createPlaceholder 拉新的 + 老 tagless
      // 标 "submission lost", 用户看到一假死一真活. 现在 tagless 直接接管 active
      // job (典型场景 1 个 in-flight, kind 不影响 poll 行为, 只是 fallback 文案).
      const taglessQueue = [...taglessPlaceholders];

      const matchedJobIds = new Set<string>();
      for (const job of activeJobs) {
        const matched = placeholdersByJobId.get(job.job_id);
        if (matched) {
          matchedJobIds.add(job.job_id);
          void pollAndPinJob(job.kind, job.job_id, [toPlaceholder(matched, job.kind)]);
          continue;
        }
        const tagless = taglessQueue.shift();
        if (tagless) {
          void pollAndPinJob(job.kind, job.job_id, [toPlaceholder(tagless, job.kind)]);
        } else {
          // 真孤儿: 没任何 on-canvas placeholder, 用户大概在 placeholder 创建之前
          // 就关页了 (rare). 拉新 placeholder 兜底.
          const fresh = createPlaceholder(job.kind, `Resuming ${job.kind}…`);
          void pollAndPinJob(job.kind, job.job_id, fresh ? [fresh] : []);
        }
      }

      // Tagged placeholders the backend 不在 active 列表里: job 已终态 (cutout
      // rembg 秒级完成是常见原因 — 用户关页重进时已 SUCCEEDED 早就不在 active 里).
      // 用 pollAndPinJob 走 waitForCanvasJob 一次性恢复终态: SUCCEEDED → pinCanvasJobResult
      // 把结果 pin 上去, FAILED → markPlaceholderFailed 写错误, job 找不到 (404) → 同上.
      // 这条比之前的 markFailed("job no longer active") 实质恢复 split 的 cutout
      // 已成功结果, 不再让用户看到鬼影 placeholder.
      for (const [jobId, pair] of placeholdersByJobId) {
        if (!matchedJobIds.has(jobId)) {
          void pollAndPinJob(pair.kind, jobId, [toPlaceholder(pair, pair.kind)]);
        }
      }
      // Tagless 配对完还剩的: POST 没到 backend (网络断 / 关页太快), 真的丢了.
      for (const pair of taglessQueue) {
        markPlaceholderFailed(toPlaceholder(pair, "image"), "submission lost");
      }
    })();

    return () => {
      abort.abort();
    };
  }, [
    sceneId, scene, apiVersion, excalidrawApiRef,
    pollAndPinJob, markPlaceholderFailed, createPlaceholder,
  ]);
}

function collectPendingPlaceholders(
  api: ExcalidrawImperativeAPI,
  byJobId: Map<string, TaggedPending>,
  tagless: TaglessPending[],
): void {
  const byGroup = new Map<string, PendingBase & { jobId?: string; kind?: JobKind }>();
  for (const el of api.getSceneElements()) {
    if (!isPendingPlaceholder(el)) continue;
    const groupId = el.groupIds?.[0];
    if (!groupId) continue;
    const entry = byGroup.get(groupId) ?? {
      groupId, rectId: "", textId: "", x: 0, y: 0, width: 0, height: 0,
    };
    if (el.type === "rectangle") {
      entry.rectId = el.id;
      entry.x = el.x; entry.y = el.y;
      entry.width = el.width; entry.height = el.height;
      const tag = getCanvasJobTag(el);
      if (tag) { entry.jobId = tag.jobId; entry.kind = tag.kind; }
    } else if (el.type === "text") {
      entry.textId = el.id;
    }
    byGroup.set(groupId, entry);
  }
  for (const pair of byGroup.values()) {
    if (!pair.rectId || !pair.textId) continue;
    if (pair.jobId && pair.kind) {
      byJobId.set(pair.jobId, { ...pair, jobId: pair.jobId, kind: pair.kind });
    } else {
      tagless.push(pair);
    }
  }
}

function toPlaceholder(pair: PendingBase, kind: JobKind): PinPlaceholder {
  return {
    rectId: pair.rectId, textId: pair.textId, groupId: pair.groupId,
    x: pair.x, y: pair.y, width: pair.width, height: pair.height,
    kind,
  };
}
