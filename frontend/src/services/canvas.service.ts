import { request } from "@/utils/request";
import { createResource } from "./createResource";
import type {
  CanvasAngleJob,
  CanvasChatMessage,
  CanvasChatStreamEvent,
  CanvasImageEditJob,
  CanvasJobStatus,
  CanvasScene,
  CanvasSceneListItem,
  CanvasSkill,
  CanvasVideoJob,
  ChatAttachment,
} from "@/types/canvex";

// NDJSON 流式 (fetch) 的 base —— 与 utils/request.tsx 同款解析:
// 优先 VITE_API_URL；dev 模式下默认指向本地后端；否则相对路径 (同域)。
const API_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:8000" : "");

const SCENES = "/api/v1/canvas/scenes/";
const IMAGE_EDIT_JOBS = "/api/v1/canvas/image-edit-jobs/";
const VIDEO_JOBS = "/api/v1/canvas/video-jobs/";
const ANGLE_JOBS = "/api/v1/canvas/angle-jobs/";
const SKILLS = "/api/v1/canvas/skills/";

const TERMINAL_JOB_STATUSES: readonly CanvasJobStatus[] = ["SUCCEEDED", "FAILED"];

/**
 * Poll an ImageEditJob / VideoJob endpoint until it reaches SUCCEEDED or FAILED.
 *
 * Image gen is typically 15-30s, video 1-5 min. Bounds err generous to cover
 * provider latency spikes. Caller passes an AbortSignal tied to the scene /
 * stream lifecycle so polling stops if the user navigates away mid-job.
 *
 * Does NOT catch network errors — axios interceptor still runs, other errors
 * propagate up so the caller can surface them.
 */
const JOB_DETAIL_ROUTES = {
  image: IMAGE_EDIT_JOBS,
  video: VIDEO_JOBS,
  angle: ANGLE_JOBS,
} as const;

// Per-kind initial poll delay — image/angle are synchronous fal inference
// (~15-30s), video async pipeline is 1-5min so start slower.
const DEFAULT_INITIAL_DELAY_MS: Record<CanvasJobKind, number> = {
  image: 2000,
  video: 5000,
  angle: 3000,
};

export type CanvasJobKind = "image" | "video" | "angle";

export type CanvasJob = CanvasImageEditJob | CanvasVideoJob | CanvasAngleJob;

/** One non-terminal job for the active-jobs reload-resume endpoint. */
export interface CanvasActiveJob {
  kind: CanvasJobKind;
  job_id: string;
  status: "QUEUED" | "RUNNING";
  created_at: string;
}

/** Backend-driven list of in-flight jobs for a scene. Frontend uses this on
 *  scene mount as the authoritative source for resume polling — avoids the
 *  autosave race where customData job_id tagging can be lost if the user
 *  closes the tab before the 1.5s debounce fires. */
export async function fetchActiveCanvasJobs(
  sceneId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CanvasActiveJob[]> {
  const { data } = await request.get<CanvasActiveJob[]>(
    `/api/v1/canvas/scenes/${sceneId}/active-jobs/`,
    { signal: options.signal },
  );
  return data;
}

export async function waitForCanvasJob(
  kind: CanvasJobKind,
  jobId: string,
  options: {
    signal?: AbortSignal;
    /** ms of first poll delay. Default depends on kind. */
    initialDelayMs?: number;
    /** upper cap on per-poll delay (backoff grows 1.3x each round). Default 10000. */
    maxDelayMs?: number;
    /** abort after this many polls. Default 90 — ≈ 14min at max backoff. */
    maxAttempts?: number;
  } = {},
): Promise<CanvasJob> {
  const signal = options.signal;
  const initialMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS[kind];
  const maxMs = options.maxDelayMs ?? 10000;
  const maxAttempts = options.maxAttempts ?? 90;
  const base = JOB_DETAIL_ROUTES[kind];

  // Check once immediately, then back off between polls. A job that already
  // finished (rare but possible if the worker ran before the frontend started
  // polling) returns right away instead of eating an initial sleep.
  let wait = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (wait > 0) await sleep(wait, signal);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    // Pass signal down to axios so scene switch / tab close cancels in-flight
    // GETs instead of letting them complete to /dev/null.
    const { data } = await request.get<CanvasJob>(`${base}${jobId}/`, { signal });
    if (TERMINAL_JOB_STATUSES.includes(data.status)) return data;
    wait = Math.min(wait === 0 ? initialMs : Math.round(wait * 1.3), maxMs);
  }
  throw new Error(`canvas ${kind} job ${jobId} did not finish after ${maxAttempts} polls`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Chat stream — NDJSON via fetch (NOT axios).
 *
 * 直接用 fetch 的原因, 轮不到 axios:
 * 1. axios 的浏览器 adapter 不暴露 ReadableStream, 它把整个响应 buffer 完才
 *    resolve, 流式的意义直接丢掉
 * 2. EventSource 更原生但无法挂自定义 header (如 ngrok-skip-browser-warning)
 * Canvex 后端 AllowAny, 无需 Authorization —— 不带 token。
 */
export async function* postChatStream(
  sceneId: string,
  content: string,
  options: {
    signal?: AbortSignal;
    disabledSkills?: string[];
    attachments?: ChatAttachment[];
  } = {},
): AsyncGenerator<CanvasChatStreamEvent, void, void> {
  // Empty / undefined optional fields → omit so backend serializer's
  // `default=list` kicks in. Including `disabled_skills: []` would be
  // semantically identical but adds noise to request logs.
  const body: Record<string, unknown> = { content };
  if (options.disabledSkills && options.disabledSkills.length > 0) {
    body.disabled_skills = options.disabledSkills;
  }
  if (options.attachments && options.attachments.length > 0) {
    body.attachments = options.attachments;
  }
  const resp = await fetch(
    `${API_URL}${SCENES}${encodeURIComponent(sceneId)}/chat/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    },
  );
  if (!resp.ok || !resp.body) {
    throw new Error(`chat stream failed: HTTP ${resp.status}`);
  }
  const reader = resp.body
    .pipeThrough(new TextDecoderStream("utf-8"))
    .getReader();
  // Parse NDJSON by advancing a cursor through `buffer` instead of reslicing
  // on every newline — reslicing is O(buffer²) across the whole stream for
  // short lines (each slice copies the remaining tail).
  let buffer = "";
  let cursor = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      let nl = buffer.indexOf("\n", cursor);
      while (nl !== -1) {
        const line = buffer.slice(cursor, nl).trim();
        cursor = nl + 1;
        if (line) {
          yield JSON.parse(line) as CanvasChatStreamEvent;
        }
        nl = buffer.indexOf("\n", cursor);
      }
      // Compact once the backlog is large enough that trailing unparsed bytes
      // aren't a material fraction — bounded memory even on very long streams.
      if (cursor > 4096) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
      if (done) break;
    }
    const trailing = buffer.slice(cursor).trim();
    if (trailing) yield JSON.parse(trailing) as CanvasChatStreamEvent;
  } catch (err) {
    // Tell the server we're done so it stops producing into an orphan
    // connection. cancel() releases the lock too, so releaseLock in the
    // finally below would throw — swallow it there.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released via cancel()
    }
  }
}

// list 返回无 data 字段, retrieve 带 data —— createResource 默认 list 返回
// CanvasScene[], 但后端 defer 掉 data, 前端按 CanvasSceneListItem 消费更安全。
// 所以 list 手写, 其余复用工厂。
const sceneResource = createResource<CanvasScene>(SCENES);

export interface ImageEditCreatePayload {
  /** Single File → legacy `image` part (source_image ImageField).
   *  File[] (≥2) → `images` list part (source_images JSONField, marquee multi). */
  image: File | File[];
  prompt?: string;
  cutout?: boolean;
  size?: string;
  resolution?: "2K" | "4K";
  n?: 1 | 2 | 4;
}

export interface VideoCreatePayload {
  prompt?: string;
  /** Either `image` (File upload) or `image_urls` (CDN). */
  image?: File;
  image_urls?: string[];
  duration?: number;
  aspect_ratio?: string;
}

export interface AngleCreatePayload {
  /** Either `image` (File upload) or `image_url` (CDN). */
  image?: File;
  image_url?: string;
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
}

export const canvasService = {
  // ── Scene CRUD ────────────────────────────────────────────────────────────
  listScenes: () => request.get<CanvasSceneListItem[]>(SCENES),
  retrieveScene: sceneResource.retrieve,
  createScene: sceneResource.create,
  updateScene: sceneResource.update,
  removeScene: sceneResource.remove,

  // ── Chat ──────────────────────────────────────────────────────────────────
  listChat: (sceneId: string, limit = 20) =>
    request.get<CanvasChatMessage[]>(`${SCENES}${sceneId}/chat/`, {
      params: { limit },
    }),
  // POST 返 NDJSON 流 —— 见顶部 postChatStream 函数 (async generator)
  postChatStream,

  // ── Skills ────────────────────────────────────────────────────────────────
  // 全局 skill 注册表 (跟租户无关), 进程级 cache, 调用便宜
  listSkills: () => request.get<CanvasSkill[]>(SKILLS),

  // ── Send-to-chat attachment upload ────────────────────────────────────────
  // 用户拖入 Excalidraw 的本地图只有 blob:/data: URL, agent 后端 + provider
  // 都拿不到. Send-to-chat 时先 multipart 上传到 qiniu → 拿 CDN URL → 当作
  // attachment 发送. 跟 createImageEdit / createSplit 走同款持久化路径
  // (library.Asset, scene-folder cascade cleanup).
  uploadAttachment: (sceneId: string, file: File) => {
    const form = new FormData();
    form.append("image", file);
    return request.post<ChatAttachment>(
      `${SCENES}${sceneId}/upload-attachment/`,
      form,
    );
  },

  // ── Image Edit ────────────────────────────────────────────────────────────
  createImageEdit: (sceneId: string, payload: ImageEditCreatePayload) => {
    const form = new FormData();
    if (Array.isArray(payload.image)) {
      for (const f of payload.image) form.append("images", f);
    } else {
      form.append("image", payload.image);
    }
    if (payload.prompt) form.append("prompt", payload.prompt);
    if (payload.cutout) form.append("cutout", "true");
    if (payload.size) form.append("size", payload.size);
    if (payload.resolution) form.append("resolution", payload.resolution);
    if (payload.n) form.append("n", String(payload.n));
    // 不手填 Content-Type —— axios 会按 FormData 自动加 boundary
    return request.post<{ job_id: string; status: string }>(
      `${SCENES}${sceneId}/image-edit/`,
      form,
    );
  },
  listImageEditJobs: (sceneId: string, limit = 20) =>
    request.get<CanvasImageEditJob[]>(`${SCENES}${sceneId}/image-edit-jobs/`, {
      params: { limit },
    }),
  retrieveImageEditJob: (jobId: string) =>
    request.get<CanvasImageEditJob>(`${IMAGE_EDIT_JOBS}${jobId}/`),

  // ── Split (atomic billing pair) ───────────────────────────────────────────
  // 后端原子 split: 一次 POST 创两条 leg (bg inpaint + cutout subject), 互填
  // split_partner. Canvex 免费无钱包, 两条 leg 都 0 计费; 任一失败时 backend
  // task 收口逻辑保持. 不再走 createImageEdit 两次 (那样没 partner FK)。
  createSplit: (sceneId: string, image: File) => {
    const form = new FormData();
    form.append("image", image);
    return request.post<{
      background: { job_id: string; status: string };
      cutout: { job_id: string; status: string };
    }>(`${SCENES}${sceneId}/split/`, form);
  },

  // ── Video ─────────────────────────────────────────────────────────────────
  createVideo: (sceneId: string, payload: VideoCreatePayload) => {
    if (payload.image) {
      const form = new FormData();
      form.append("image", payload.image);
      if (payload.prompt) form.append("prompt", payload.prompt);
      if (payload.duration) form.append("duration", String(payload.duration));
      if (payload.aspect_ratio) form.append("aspect_ratio", payload.aspect_ratio);
      return request.post<{ job_id: string; status: string }>(
        `${SCENES}${sceneId}/video/`,
        form,
      );
    }
    return request.post<{ job_id: string; status: string }>(
      `${SCENES}${sceneId}/video/`,
      payload,
    );
  },
  listVideoJobs: (sceneId: string, limit = 20) =>
    request.get<CanvasVideoJob[]>(`${SCENES}${sceneId}/video-jobs/`, {
      params: { limit },
    }),
  retrieveVideoJob: (jobId: string) =>
    request.get<CanvasVideoJob>(`${VIDEO_JOBS}${jobId}/`),

  // ── Angle (fal.ai Qwen-Image-Edit-2511-Multiple-Angles-LoRA) ──────────────
  createAngle: (sceneId: string, payload: AngleCreatePayload) => {
    if (payload.image) {
      const form = new FormData();
      form.append("image", payload.image);
      form.append("horizontal_angle", String(payload.horizontal_angle));
      form.append("vertical_angle", String(payload.vertical_angle));
      form.append("zoom", String(payload.zoom));
      return request.post<{ job_id: string; status: string }>(
        `${SCENES}${sceneId}/angle/`,
        form,
      );
    }
    return request.post<{ job_id: string; status: string }>(
      `${SCENES}${sceneId}/angle/`,
      payload,
    );
  },
  listAngleJobs: (sceneId: string, limit = 20) =>
    request.get<CanvasAngleJob[]>(`${SCENES}${sceneId}/angle-jobs/`, {
      params: { limit },
    }),
  retrieveAngleJob: (jobId: string) =>
    request.get<CanvasAngleJob>(`${ANGLE_JOBS}${jobId}/`),
};
