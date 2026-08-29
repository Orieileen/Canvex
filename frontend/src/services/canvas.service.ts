import { request } from "@/utils/request";
import { MEDIA_API_BASE } from "@/lib/canvas-media-url";
import { createResource } from "./createResource";
import type {
  CanvasAngleJob,
  CanvasChatMessage,
  CanvasChatStreamEvent,
  CanvasImageEditJob,
  CanvasImageModelChoice,
  CanvasImageProvider,
  CanvasImageProviderWrite,
  CanvasImageProviderTestResult,
  CanvasJobStatus,
  CanvasMediaFolderList,
  CanvasMediaFolderPage,
  CanvasMediaImage,
  CanvasMediaVideo,
  CanvasScene,
  CanvasSceneListItem,
  CanvasSkill,
  CanvasSkillRow,
  CanvasSkillWrite,
  CanvasWizardParsed,
  CanvasWizardProbe,
  CanvasKindSpec,
  CanvasVideoJob,
  ChatAttachment,
} from "@/types/canvex";

// NDJSON 流式 (fetch) 的 base —— 复用 canvas-media-url 的同一 api base
// (VITE_API_URL，dev 回落本地后端，否则同域相对)，避免各处各写一份。
const API_URL = MEDIA_API_BASE;

const SCENES = "/api/v1/canvas/scenes/";
const IMAGE_EDIT_JOBS = "/api/v1/canvas/image-edit-jobs/";
const VIDEO_JOBS = "/api/v1/canvas/video-jobs/";
const ANGLE_JOBS = "/api/v1/canvas/angle-jobs/";
const SKILLS = "/api/v1/canvas/skills/";
const SKILL_LIBRARY = "/api/v1/canvas/skill-library/";
const IMAGE_PROVIDERS = "/api/v1/canvas/image-providers/";
const IMAGE_MODELS = "/api/v1/canvas/image-models/";
const MEDIA_LIBRARY_FOLDERS = "/api/v1/canvas/media-library/folders/";

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
 * Chat stream — SSE via fetch (NOT axios, NOT EventSource).
 *
 * 直接用 fetch 的原因:
 * 1. axios 的浏览器 adapter 不暴露 ReadableStream, 它把整个响应 buffer 完才
 *    resolve, 流式的意义直接丢掉
 * 2. EventSource 是 SSE 的原生客户端, 但只能 GET、不能带 POST body, 也无法挂
 *    自定义 header (如 ngrok-skip-browser-warning) —— 聊天是带 body 的 POST,
 *    所以只能用 fetch 自己解析 SSE 帧。
 * Canvex 后端 AllowAny, 无需 Authorization —— 不带 token。
 */
export async function* postChatStream(
  sceneId: string,
  content: string,
  options: {
    signal?: AbortSignal;
    disabledSkills?: string[];
    attachments?: ChatAttachment[];
    /** 工具栏选中的生图模型 (ImageModel.id)。空 = 后端退到库里第一条。 */
    imageModelId?: string;
    /** Video tab 选的通道 (kind=video)。agent 调 generate_video 时用。 */
    videoModelId?: string;
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
  if (options.imageModelId) {
    body.image_model_id = options.imageModelId;
  }
  if (options.videoModelId) {
    body.video_model_id = options.videoModelId;
  }
  const resp = await fetch(
    `${API_URL}${SCENES}${encodeURIComponent(sceneId)}/chat/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
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
  // Parse SSE frames: events are separated by a blank line ("\n\n"); within a
  // frame the `data:` lines carry the payload (joined by "\n" per spec), and
  // other lines (":" keep-alive comments, event:/id:/retry:) are ignored. We
  // advance a cursor through `buffer` instead of reslicing on every frame —
  // reslicing is O(buffer²) for many small frames. The payloads are single-line
  // JSON identical to the old NDJSON events; only the framing changed.
  const frameData = (frame: string): string => {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        const v = line.slice(5);
        data += (data ? "\n" : "") + (v.startsWith(" ") ? v.slice(1) : v);
      }
    }
    return data;
  };
  let buffer = "";
  let cursor = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      // Strip CR so CRLF/CR line endings (a proxy may rewrite them) normalize to
      // LF — then "\n\n" frame splitting works. Safe: json.dumps escapes any real
      // CR inside payloads, so raw CR only ever appears as an SSE line terminator.
      if (value) buffer += value.replace(/\r/g, "");
      let sep = buffer.indexOf("\n\n", cursor);
      while (sep !== -1) {
        const data = frameData(buffer.slice(cursor, sep));
        cursor = sep + 2;
        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as CanvasChatStreamEvent;
        }
        sep = buffer.indexOf("\n\n", cursor);
      }
      // Compact once the backlog is large enough that trailing unparsed bytes
      // aren't a material fraction — bounded memory even on very long streams.
      if (cursor > 4096) {
        buffer = buffer.slice(cursor);
        cursor = 0;
      }
      if (done) break;
    }
    // Defensive: a final frame not terminated by a blank line.
    const tail = frameData(buffer.slice(cursor));
    if (tail && tail !== "[DONE]") yield JSON.parse(tail) as CanvasChatStreamEvent;
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
const imageProviderResource = createResource<CanvasImageProvider, CanvasImageProviderWrite>(
  IMAGE_PROVIDERS,
);

export interface ImageEditCreatePayload {
  /** Single File → legacy `image` part (source_image ImageField).
   *  File[] (≥2) → `images` list part (source_images JSONField, marquee multi). */
  image: File | File[];
  prompt?: string;
  cutout?: boolean;
  size?: string;
  resolution?: "1K" | "2K" | "4K";
  n?: 1 | 2 | 4;
  /** 工具栏选中的生图模型 (ImageModel.id)。空 = 后端退到库里第一条启用的通道。 */
  imageModelId?: string;
}

export interface VideoCreatePayload {
  prompt?: string;
  /** Either `image` (File upload) or `image_urls` (CDN). */
  image?: File;
  image_urls?: string[];
  duration?: number;
  aspect_ratio?: string;
  /** Video tab 选的通道 (kind=video 的 ImageModel.id)。空 = 后端退到库里第一条。 */
  imageModelId?: string;
}

export interface AngleCreatePayload {
  /** Either `image` (File upload) or `image_url` (CDN). */
  image?: File;
  image_url?: string;
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
  /** Angle tab 选的通道 (kind=angle 的 ImageModel.id)。空 = 后端退到库里第一条。 */
  image_model?: string;
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
  // POST 返 SSE 流 —— 见顶部 postChatStream 函数 (async generator)
  postChatStream,

  // ── Skills ────────────────────────────────────────────────────────────────
  // agent 当前**看得见**哪些 skill (后端每次重读 store, 没有缓存 —— 为什么不能有,
  // 见 backend/studio/services/agent/skills.py)。跟下面的 skillLibrary 问的不是同一件事。
  listSkills: () => request.get<CanvasSkill[]>(SKILLS),
  // 装好的 SKILL.md 的增删改查。跟 listSkills 问的是两件事, 见 CanvasSkillRow 的注释。
  skillLibrary: createResource<CanvasSkillRow, CanvasSkillWrite>(SKILL_LIBRARY),

  // ── Media library (按画布分文件夹 + 文件夹内分页) ──────────────────────────
  // 文件夹列表: 每个有过生成的画布一行, 精确计数 + 封面 (一次拉全, 不分页)。
  getMediaFolders: () =>
    request.get<CanvasMediaFolderList>(MEDIA_LIBRARY_FOLDERS),
  // 文件夹内某一类型的一页 (offset 分页, 各类型独立流)。
  getMediaFolderItems: (
    sceneId: string,
    kind: "images" | "videos",
    offset: number,
    limit?: number,
  ) =>
    request.get<CanvasMediaFolderPage<CanvasMediaImage | CanvasMediaVideo>>(
      `${MEDIA_LIBRARY_FOLDERS}${sceneId}/items/`,
      { params: { kind, offset, ...(limit ? { limit } : {}) } },
    ),

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
    // 这条路是异步的 —— 选择会落到 ImageEditJob 行上, worker 之后据此解析通道。
    if (payload.imageModelId) form.append("image_model", payload.imageModelId);
    // 不手填 Content-Type —— axios 会按 FormData 自动加 boundary
    return request.post<{ job_id: string; status: string }>(
      `${SCENES}${sceneId}/image-edit/`,
      form,
    );
  },
  // ── 生图供应商配置 ────────────────────────────────────────────────────────
  // 四个标准 CRUD 走跟 scene 同一个工厂 —— 手写一遍的话, URL 拼接和动词选择就有了
  // 第二个住处, 将来改工厂 (末尾斜杠策略 / 响应解包 / 重试) 只会覆盖到 scene。
  listImageProviders: imageProviderResource.list,
  createImageProvider: imageProviderResource.create,
  updateImageProvider: imageProviderResource.update,
  deleteImageProvider: imageProviderResource.remove,
  /** 真发一次最小生成。ok=false 也是 200 —— 测试本身成功了, 失败的是被测对象。
   *  会产生一次真实的生成消耗。 */
  testImageProvider: (id: string, imageModelId?: string) =>
    request.post<CanvasImageProviderTestResult>(`${IMAGE_PROVIDERS}${id}/test/`, {
      image_model: imageModelId,
    }),
  /** 向导第 1 步:curl → 模板。带 task_id 时解析的是"查询任务"那一段。 */
  wizardParseCurl: (curl: string, poll?: { task_id: string; base_url: string }) =>
    request.post<CanvasWizardParsed & { poll?: Record<string, unknown> }>(
      `${IMAGE_PROVIDERS}wizard/parse/`, { curl, ...poll },
    ),
  /** 向导第 2 / 4 步:拿**还没保存**的配置真发一次。会产生一次真实的生成消耗。 */
  wizardProbe: (body: {
    /** 建哪种模板通道 —— 决定后端喂给模板的是生图还是视频那张变量表。 */
    kind: string;
    base_url: string; api_key: string; model: string;
    request_template: Record<string, unknown>;
    poll?: Record<string, unknown>; task_id?: string;
  }) => request.post<CanvasWizardProbe>(`${IMAGE_PROVIDERS}wizard/probe/`, body),
  /** 配置表单的字段表。后端从 ImageChannel 的字段声明派生 —— 前端不再抄一份。 */
  getImageProviderSchema: () =>
    request.get<{ tunables: Record<string, CanvasKindSpec> }>(`${IMAGE_PROVIDERS}schema/`),
  /** 把供应商文档里的示例 curl 转成预填字段(替代内置预设)。 */
  /** 工具栏选择器的列表 —— 不含凭据。 */
  listImageModels: () => request.get<CanvasImageModelChoice[]>(IMAGE_MODELS),

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
  createSplit: (sceneId: string, image: File, region = "", resolution = "", imageModelId = "") => {
    const form = new FormData();
    form.append("image", image);
    // Plan B: subject region (box → coordinates) folded into the split prompts;
    // empty when nothing was drawn → backend falls back to "most prominent subject".
    if (region) form.append("region", region);
    if (resolution) form.append("resolution", resolution);
    // 两条 leg 共用这一个选择 —— 跟 createImageEdit 一样落到 job 行上, worker 再解析。
    if (imageModelId) form.append("image_model", imageModelId);
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
      if (payload.imageModelId) form.append("image_model", payload.imageModelId);
      return request.post<{ job_id: string; status: string }>(
        `${SCENES}${sceneId}/video/`,
        form,
      );
    }
    const { imageModelId, ...rest } = payload;
    return request.post<{ job_id: string; status: string }>(
      `${SCENES}${sceneId}/video/`,
      imageModelId ? { ...rest, image_model: imageModelId } : rest,
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
      if (payload.image_model) form.append("image_model", payload.image_model);
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
