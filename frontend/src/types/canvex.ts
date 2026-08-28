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
  // A canvas asset a tool produced this turn — the client places it on the
  // Excalidraw board via pinImage.
  | { event: "canvas_asset"; url: string }
  | { event: "error"; detail: string }
  | { event: "done" };


// ─── 生图供应商配置 ─────────────────────────────────────────────────────────

/** 供应商下的一个可选模型。`overrides` 只存与 provider defaults 不同的项。 */
export interface CanvasImageModel {
  id: string;
  label: string;
  /** 供应商要的模型字符串原文(各家写法不同,不做别名映射)。 */
  model: string;
  overrides: Record<string, unknown>;
  enabled: boolean;
  sort_order: number;
}

/** 供应商的接口形状:
 *  - `image` 通用生图接口 ({base_url}/images/generations, Bearer)。Image / Split 用。
 *  - `angle` fal.run 的视角重渲染 (模型名在 URL 路径里, 认证是 `Key`, 请求体是相机坐标)。
 *  - `video` 文/图生视频 (提交拿 task_id 再长轮询)。
 *  - `chat` 聊天 agent 的 LLM。必须支持 OpenAI 的 tools 参数, 否则 agent 调不动画布工具。
 *  决定每个选择器列哪些模型, 以及配置表单显示哪些参数(后者由后端下发的 schema 说)。 */
export type CanvasImageProviderKind =
  | "image" | "angle" | "video" | "chat"
  /** 请求形状由用户填的模板决定, 不是那十四个旋钮。见 CanvasKindSpec.template。 */
  | "custom_image" | "custom_video";

/** 一个生图供应商端点 —— 一把 key + 一个 base_url + 一套请求参数默认值。
 *  api_key 明文返回:本地单机项目,配置页要能回显用户填过什么、直接改。 */
export interface CanvasImageProvider {
  id: string;
  label: string;
  kind: CanvasImageProviderKind;
  base_url: string;
  api_key: string;
  defaults: Record<string, unknown>;
  /** 只有 kind=custom_* 用: 一次调用的完整形状。其余 kind 是 `{}`。 */
  request_template: Record<string, unknown>;
  models: CanvasImageModel[];
  created_at: string;
  updated_at: string;
}

/** 后端下发的、关于一种通道类型的全部表单规则 (GET /image-providers/schema/)。
 *
 *  这些以前是前端自己写死的 —— `kind !== "chat"`、`kind === "image" || kind === "angle"`、
 *  一个 base_url 占位符三元表达式、四个硬编码的 <option>。也就是把后端规则手抄了一份,
 *  而抄的那份还会**抢先**生效: 某个 kind 的 base_url 改成可选之后, 前端的 toast 会在
 *  请求发出去之前就拦下来, 后端改了等于没改。 */
export interface CanvasKindSpec {
  tunables: CanvasTunableSpec[];
  /** false = 这种通道的 base_url 可以留空 (chat 留空 = OpenAI 官方端点)。 */
  requires_base_url: boolean;
  base_url_example: string;
  /** 有没有一键测试的探针。没有时 ⚡ 按钮不显示, 后端也会拒绝。 */
  testable: boolean;
  /** 工具栏哪个选择器列这种通道。空 = 不进任何选择器 (chat)。 */
  picker: string;
  /** true = 这种通道由请求模板驱动, 表单换成模板编辑器而不是那排旋钮。 */
  template: boolean;
  /** 模板里能用的占位符。**存盘时后端会校验**, 这里只用来显示给用户看。 */
  variables: string[];
  /** 内置起点模板。选一个填进编辑器再改, 而不是从零手写 JSON。 */
  starters: { label: string; template: Record<string, unknown> }[];
}

/**
 * 配置表单里一个可调参数的描述 —— **由后端下发** (GET /image-providers/schema/)。
 *
 * 不在前端写死这张表: 它的唯一来源是后端 `ImageChannel` 的字段声明。手抄一份的下场是
 * 加了旋钮界面上不出现、或者界面上配了后端不认, 两种都没有报错。文案不在里面 —— label
 * 走 i18n 按 key 查, 查不到就退回显示 key 本身。
 */
export interface CanvasTunableSpec {
  key: string;
  /** 渲染成什么控件。由字段的标量类型决定。 */
  control: "text" | "bool" | "number";
  /** 输入框的灰字提示。通常就是 Canvex 自己的默认值。 */
  placeholder: string;
  /** 下拉里"不填"那一项的语义: 用我们的默认, 还是根本不下发这个字段。 */
  empty_label: "unset" | "dont_send";
}

/** 写回后端时的供应商形状。跟读取形状只差嵌套模型行的 id —— 前端刚加的那行还没
 *  落库, 省掉 id 让后端走 create;发个本地假 id 过去会被当成"更新一条不存在的行"。 */
export type CanvasImageProviderWrite = Omit<CanvasImageProvider, "models"> & {
  models: (Omit<CanvasImageModel, "id"> & { id?: string })[];
};

/** 工具栏模型选择器拉的列表项 —— 不含 base_url / api_key。 */
export interface CanvasImageModelChoice {
  id: string;
  label: string;
  provider_label: string;
  /** 来自所属 provider。展示用。 */
  kind: CanvasImageProviderKind;
  /** **筛选按这个, 不是 kind。** 一个选择器对应多种 kind (生图 = image + custom_image),
   *  按 kind 名字筛的话新加的那种配好了却不出现, 而且不报错。 */
  picker: string;
  sort_order: number;
}

/** POST /image-providers/<id>/test/ 的结果。ok=false 也是 HTTP 200 ——
 *  「测试成功了,失败的是被测对象」。`error` 是供应商返回的原始错误。 */
export interface CanvasImageProviderTestResult {
  ok: boolean;
  elapsed: number;
  bytes?: number;
  error?: string;
}

/** POST /image-providers/import-curl/ 从示例 curl 推断出的预填字段。
 *  只包含推断出来的项;`_unrecognized` 是示例里出现但我们不认识的请求体键。 */
export interface CanvasCurlImportResult {
  base_url?: string;
  api_key?: string;
  model?: string;
  image_field?: string;
  image_as_single?: boolean;
  response_format?: string;
  quality?: string;
  watermark?: boolean;
  _unrecognized?: string[];
  /** 这段 curl 打的不是 /images/generations —— base_url 里留着端点路径, 直接保存会拼出
   *  一个多一截的地址。整句话由后端给, 因为"我们会打哪个端点"是后端的事。 */
  _path_note?: string;
}
