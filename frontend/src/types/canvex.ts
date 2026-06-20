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

/** POST /api/v1/canvas/scenes/<id>/chat/ 流式响应 (application/x-ndjson)。
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
  | { event: "assistant_final"; content: string }
  | { event: "assistant"; message: CanvasChatMessage }
  | { event: "error"; detail: string }
  | { event: "done" };
