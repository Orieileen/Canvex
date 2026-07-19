/**
 * Canvas 后端返回的核心数据类型。与 Django model 字段对齐。
 *
 * Ported from meired src/types/api.ts (Canvas section). Canvex 后端 serve 在
 * /api/v1/canvas/...，字段形状与 meired 一致。
 */

// ─── Canvas ─────────────────────────────────────────────────────────────────

/** Excalidraw 序列化 scene。字段结构由 @excalidraw/excalidraw 决定,这里留松类型。 */
export type CanvasSceneData = Record<string, unknown>;

export type CanvasChatRole = "user" | "assistant" | "system";

export type CanvasJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** GET /api/v1/canvas/scenes/ 列表元素 —— 不含 data 字段。 */
export interface CanvasSceneListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** GET /api/v1/canvas/scenes/<id>/ 详情 —— 含完整 data。 */
export interface CanvasScene extends CanvasSceneListItem {
  data: CanvasSceneData;
}

export interface CanvasChatMessage {
  id: string;
  scene: string;
  role: CanvasChatRole;
  content: string;
  created_at: string;
}

export interface CanvasImageEditResult {
  order: number;
  asset_id: string;
  url: string;
}

export interface CanvasImageEditJob {
  id: string;
  scene: string;
  prompt: string;
  size: string;
  num_images: number;
  is_cutout: boolean;
  status: CanvasJobStatus;
  error: string;
  created_at: string;
  updated_at: string;
  // retrieve 时才有
  results?: CanvasImageEditResult[];
}

export interface CanvasVideoJob {
  id: string;
  scene: string;
  prompt: string;
  image_urls: string[];
  duration: number;
  aspect_ratio: string;
  task_id: string;
  result_url: string;
  thumbnail_url: string;
  status: CanvasJobStatus;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface CanvasAngleJob {
  id: string;
  scene: string;
  source_image_url: string;
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
  additional_prompt: string;
  num_images: number;
  seed: number | null;
  status: CanvasJobStatus;
  error: string;
  created_at: string;
  updated_at: string;
  // retrieve 时才有. 后端 _AssetResultSerializerBase image-edit/angle 同形, 直接复用
  // CanvasImageEditResult; 将来 angle 响应若加字段, 这里分化成独立 interface.
  results?: CanvasImageEditResult[];
}

/** 素材库 (GET /api/v1/canvas/media-library/) —— 跨全部画布的已生成素材。
 *  url 为相对 `/media/...` (图片) 或 provider 外链 (视频), 展示前用 absoluteMediaUrl。
 *  scene_id / scene_title = 所属画布, 前端按它分文件夹 (scene_title 可能为空)。 */
export interface CanvasMediaImage {
  asset_id: string;
  url: string;
  width: number | null;
  height: number | null;
  created_at: string;
  scene_id: string;
  scene_title: string;
}

export interface CanvasMediaVideo {
  job_id: string;
  url: string;
  thumbnail_url: string;
  created_at: string;
  scene_id: string;
  scene_title: string;
}

/** 一个文件夹 = 一个有过生成的画布。计数是后端精确聚合 (不靠已加载数组长度推)。
 *  cover_url 可能为空 → 前端用文件夹图标占位。 */
export interface CanvasMediaFolder {
  scene_id: string;
  scene_title: string;
  image_count: number;
  video_count: number;
  cover_url: string;
  latest_at: string;
}

export interface CanvasMediaFolderList {
  folders: CanvasMediaFolder[];
}

/** 文件夹内某一类型 (images / videos) 的一页, offset 分页。 */
export interface CanvasMediaFolderPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

/** GET /api/v1/canvas/skills/  返当前 agent 加载的所有 skill.
 *
 * 用于 ChatOverlay 的 SkillSelector popover — 用户能看到 + 勾选本次
 * 想禁用哪些 skill (per-message override). `name` 跟 chat POST 的
 * disabled_skills 数组 1:1 对应。
 */
export interface CanvasSkill {
  name: string;
  description: string;
  /** Agent 视角的 SKILL.md 完整路径 (含 `/skills/` 前缀), 仅展示用. */
  path: string;
}

/** Canvas image attached to a chat message via "Send to chat" on ImageEditBar.
 *
 * Per-turn ephemeral — sent as `attachments` field in the chat POST body, the
 * backend prepends a SystemMessage describing them so the agent can reference
 * the URL when calling generate_image / generate_video tools.
 */
export interface ChatAttachment {
  url: string;
  width: number;
  height: number;
}

/** POST /api/v1/canvas/scenes/<id>/chat/ 流式响应 (text/event-stream, SSE)。
 *
 * 每行一个 JSON 对象,顺序:
 *   1. `user_created` —— 后端落库后的 user ChatMessage, 用来替换乐观气泡
 *   2. 零或多条 `tool_call` / `tool_result` 交替出现
 *   3. `assistant_final` —— agent 产出的最终文本 (落库前)
 *   4. `assistant` —— 落库后的 assistant ChatMessage
 *   5. `done` —— 流结束标记
 * Agent 异常时: `error` + `done`, assistant 行不写入。
 */
export type CanvasChatStreamEvent =
  | { event: "user_created"; message: CanvasChatMessage }
  | { event: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { event: "tool_result"; id: string; content: string }
  | { event: "assistant_delta"; id: string; content: string }
  | { event: "assistant_final"; content: string }
  | { event: "assistant"; message: CanvasChatMessage }
  // A canvas asset a tool produced this turn (e.g. a browse screenshot) — the
  // client places it on the Excalidraw board via pinImage.
  | { event: "canvas_asset"; url: string }
  // One live browser-use step-log line while a `browse` tool runs — the client
  // appends it to a per-turn log frame below the chat frame.
  | { event: "browse_log"; line: string }
  // One live browser MONITOR frame (current-page screenshot) while a `browse`
  // tool runs — `image` is a JPEG data-URL (live) or a media URL (final=true,
  // which the client persists to the monitor frame's customData for reload).
  | { event: "browse_frame"; image: string; final: boolean }
  // RPA authoring: this turn's browser-session token + page viewport, emitted once at
  // turn start (when CANVAS_RPA_ENABLED). The client echoes the token in a separate
  // element-pick POST (/flow/pick/) so the pick reaches this turn's live page.
  | { event: "flow_session"; token: string; viewport: { width: number; height: number } }
  // RPA v2 (Phase 4): one command the Agent wants run in the user's OWN browser via the
  // extension. The client relays it (by `op`) to the extension, correlates the reply by
  // `command_id`, and POSTs the result to /flow/ext-result/ (which unblocks the waiting
  // Agent tool). `op:"heartbeat"` is a byte-only keepalive the client ignores. `token` is
  // this turn's session token, echoed back on the result POST.
  | {
      event: "ext_command";
      command_id: string;
      token: string;
      op: "open_tab" | "snapshot" | "pick" | "ref_locator" | "heartbeat";
      url?: string;
      tabId?: number;
      ref?: string;
      epoch?: number;
      label?: string;
      max?: number;
    }
  // RPA v2 (Phase 4): the Agent's drafted steps to lay down as step cards (replacing the
  // steps frame's contents). Each step carries a rich locator (+ optional AXTree ref).
  | { event: "robot_steps"; steps: RobotStep[] }
  | { event: "error"; detail: string }
  | { event: "done" };

/** A rich element locator resolved by an RPA element pick (FlowPickView). Sourced by a
 *  user click on the live DOM; the same shape drives run-time resolution + self-heal. */
export interface FlowLocator {
  tag: string;
  role: string;
  name: string;
  text: string;
  css: string;
  nth: number;
  /** [x, y, width, height] in page CSS-viewport pixels. */
  bbox: [number, number, number, number];
  isPassword: boolean;
}

/** POST /flow/pick/ response. `locator` is null if nothing actionable was at the point;
 *  `image` is a fresh JPEG data-URL of the page (confirm against ground truth). */
export interface FlowPickResult {
  locator: FlowLocator | null;
  image: string;
}

/** One step of an RPA robot's DSL (v1). `target` is the rich locator from a pick;
 *  `provenance` records how the target was obtained. Persisted per robot-steps frame. */
export interface RobotStep {
  action: "navigate" | "click" | "type";
  target?: FlowLocator; // for click / type
  text?: string; // for type
  url?: string; // for navigate
  /** for type: press Enter after (submits the form). Both runners execute on this. */
  submit?: boolean;
  provenance?: "picked" | "guessed" | "self-healed";
  /** AXTree snapshot ref this step's target came from (Agent-drafted or picked). */
  ref?: string | null;
}

/** A saved robot (GET/POST /scenes/<id>/robots/). */
export interface CanvasRobot {
  id: string;
  scene: string;
  name: string;
  steps: RobotStep[];
  variables: Record<string, unknown>;
  /** Whether the robot may run write/state-changing steps (submit / pay / delete). */
  allow_writes: boolean;
  created_at: string;
  updated_at: string;
}

/** SSE events from POST /robots/<id>/run/ — deterministic run, no LLM per step. */
export type CanvasRobotRunEvent =
  | {
      event: "robot_step";
      index: number;
      action: string;
      status: "running" | "ok" | "failed";
      error?: string;
    }
  | { event: "browse_frame"; image: string; final: boolean }
  | { event: "error"; detail: string }
  | { event: "done" };
