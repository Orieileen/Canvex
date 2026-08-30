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

/** 库里装着的一篇 SKILL.md (GET /api/v1/canvas/skill-library/)。
 *
 *  跟上面的 `CanvasSkill` 是**两个不同的问题**, 别合并:
 *   - `CanvasSkill` (`/skills/`)  = "agent 现在看得见什么" —— 读的是 agent 的 store,
 *     所以 SkillSelector 里列的和系统提示里的不会飘。
 *   - `CanvasSkillRow` (这个)     = "库里装了什么" —— 含停用的行和 SKILL.md 全文,
 *     管理面板用。
 *
 *  `name` / `description` 是**只读的派生列**: 后端从 content 的 frontmatter 里解析出来。
 *  前端不去解析 frontmatter —— 那等于把后端的准入规则抄一份, 抄的那份迟早分叉。
 */
export interface CanvasSkillRow {
  id: string;
  name: string;
  description: string;
  /** SKILL.md 全文, 含 frontmatter。唯一真相。 */
  content: string;
  /** `builtin` = 随代码库发的出厂 SOP: 能停用, 不能删也不能改正文。 */
  source: "builtin" | "user";
  /** false = 不进 store = agent 完全看不见。跟 SkillSelector 的单条消息跳过是两回事。 */
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** 装一篇新的 SKILL.md 时只发正文;`enabled` 后端默认 true。 */
export type CanvasSkillWrite = Pick<CanvasSkillRow, "content"> &
  Partial<Pick<CanvasSkillRow, "enabled">>;

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
  /** 通道健康 —— 「上一次真的调用它时,供应商应答了吗」。只读,由后端在每次真实生成
   *  和每次「测试」之后写 (backend services/channel_health.py)。
   *
   *  `""` = 还没被调用过。`last_error` 是供应商返回的原文,前面缀了是哪条通道
   *  (「供应商 · 模型」) —— 同一把 key 下面只有一个模型名写错时,那是判断"红的是哪一
   *  行"的唯一线索。 */
  last_status: "" | "ok" | "error";
  last_checked_at: string | null;
  last_error: string;
  /** `last_error` 属于哪一类问题 —— 后端算出来的 code,文案在前端
   *  (`imageProviders.diag.<code>`,中英各一份)。空串 = 认不出,那时只显示原文。
   *  见 backend services/channel_diagnosis.py。 */
  last_error_diagnosis: string;
}

/** 后端下发的、关于一种通道类型的全部表单规则 (GET /image-providers/schema/)。
 *
 *  这些以前是前端自己写死的 —— `kind !== "chat"`、`kind === "image" || kind === "angle"`、
 *  一个 base_url 占位符三元表达式、四个硬编码的 <option>。也就是把后端规则手抄了一份,
 *  而抄的那份还会**抢先**生效: 某个 kind 的 base_url 改成可选之后, 前端的 toast 会在
 *  请求发出去之前就拦下来, 后端改了等于没改。 */
export interface CanvasKindSpec {
  tunables: CanvasTunableSpec[];
  /** 还能不能**新建**这种通道。false = 已有的照常编辑照常用,只是建不出新的。
   *
   *  给 image / video 用 —— 模板通道出现之前的老形状(十六个 / 七个旋钮),而
   *  custom_image / custom_video 能表达的严格更多。不是删掉那两种 kind:库里可能还存着,
   *  而"存在但打不开"比多一个选项糟得多。 */
  creatable: boolean;
  /** false = 这种通道的 base_url 可以留空 (chat 留空 = OpenAI 官方端点)。 */
  requires_base_url: boolean;
  base_url_example: string;
  /** 有没有一键测试的探针。没有时 ⚡ 按钮不显示, 后端也会拒绝。 */
  testable: boolean;
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
  /** 归哪一组 (`shape` / `timing` / `poll` / `other`)。**后端说了算** —— 前端不按字段名
   *  前缀猜, 那种猜法会在有人加一个 `poll_` 开头的非轮询字段时静默出错。
   *  行已经按组排好, 前端只按首次出现的次序切段。 */
  group: string;
  /** 渲染成什么控件。由字段的标量类型决定,**有固定取值的除外** —— 那种发 `choice`。 */
  control: "text" | "bool" | "number" | "choice";
  /** `control === "choice"` 时才有:能选哪几个。**第一项是空串 = 默认。**
   *
   *  为什么不做成自由文本:序列化器只校验类型(str),所以一个拼错的值存得进去,而错误
   *  要等到下一轮聊天建模型时才抛 —— 又一个"保存时看不见、用的时候才炸"。 */
  choices?: string[];
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
  /** 这条模型挂在哪条**通道**下 (界面上显示成「通道名 · 模型名」)。
   *  字段名里的 `provider` 是后端模型类名 `ImageProvider` 的遗留 —— 界面上这东西叫通道,
   *  「供应商」只指那家公司。见 i18n/canvas/imageProviders.ts 顶上的用词规则。 */
  provider_label: string;
  /** **分流按这个。** 一个选择器对应多种 kind (生图 = 内置 image + 模板 custom_image),
   *  所以后端直接给"这一项归哪个选择器", 前端不按 kind 名字判 —— 那样新加的通道类型
   *  配好了却不出现在工具栏里, 而且不报错。 */
  picker: string;
  sort_order: number;
  /** 这个模型**真的收**哪几种比例(已经是合并过三层配置之后的结果)。空 = 不限制。
   *
   *  工具栏的比例选择器按它裁 —— 选不中的东西就不该出现在列表里,那比"选了再收 400"
   *  好得多。实测 apimart 的 gemini-3.1-flash-image-preview 只收 15 种并会直接拒掉别的,
   *  而同一家的 gpt-image-2 连 `999:998` 都收,所以这是 per-model 的事实。 */
  allowed_ratios: string[];
}

/** POST /image-providers/<id>/test/ 的结果。ok=false 也是 HTTP 200 ——
 *  「测试成功了,失败的是被测对象」。`error` 是供应商返回的原始错误。 */
export interface CanvasImageProviderTestResult {
  ok: boolean;
  elapsed: number;
  bytes?: number;
  error?: string;
  /** 失败时的诊断 code,跟 `CanvasImageProvider.last_error_diagnosis` 同一套。
   *  空串 = 认不出。 */
  diagnosis?: string;
}

/** 向导第 1 步:一段 curl 解析出来的东西 (POST /image-providers/wizard/parse/)。
 *
 *  `mapping` 是给界面渲染成"这个键 = 提示词 / 尺寸 / 固定值"那张表的 —— 占位符是**猜**
 *  的(按键名 + 值的形状),所以必须让用户能逐行改。`var` 为空 = 认不出来,原样当固定值
 *  发给供应商,那通常正是对的。 */
/** 一键预设:一张预先填好 base_url / 模型 / 请求形状的通道草稿,用户只剩 key 要填。
 *  由后端下发(image_channels.PRESETS)—— **前端不写死任何一家供应商**。
 *
 *  存进库之后就是一条普通通道,跟手配出来的没有区别。名字和说明按 `key` 查翻译。 */
export interface CanvasChannelPreset {
  key: string;
  kind: string;
  /** 界面上按什么分组:聊天 / 生图 / 换视角。**后端算**(= 那个 kind 的 picker,
   *  chat 没有 picker 就用 kind 本身)—— 一个角色可能对应多种 kind,前端按 kind 名字
   *  分组的话,哪天加一条内置 image 的预设就会自己单开一组。 */
  role: string;
  base_url: string;
  /** 这条预设建出来的通道底下挂哪几个模型。**第一个是默认**(工具栏的选择器落在列表
   *  第一项)。绝大多数只有一个;apimart 视频那条有四十一个 —— 同一家的所有视频模型
   *  共用一个端点和一套请求形状,差别只在这个字符串。 */
  models: string[];
  defaults: Record<string, unknown>;
  request_template: Record<string, unknown>;
}

export interface CanvasWizardMapping {
  /** 在请求体里的位置,如 `body.size` / `input.image_urls[0]`。 */
  path: string;
  key: string;
  /** curl 示例里那个具体的值,显示给用户看"我们是照着什么猜的"。 */
  sample: unknown;
  /** 认成了哪个占位符。空 = 固定值。 */
  var: string;
}

export interface CanvasWizardParsed {
  base_url: string;
  /** 示例里的 key 是占位符时不返回 —— 见 notes。 */
  api_key?: string;
  model?: string;
  template: Record<string, unknown>;
  mapping: CanvasWizardMapping[];
  notes: string[];
}

/** 向导第 2 / 4 步:真发一次之后,从回包里自动认出来的东西
 *  (POST /image-providers/wizard/probe/)。
 *
 *  `result_path` 是模板里唯一没人写得出来的字段(`data.result.images[0].url[0]` 这种),
 *  所以不问用户,跑一次在回包里找"哪个位置长得像图"。 */
export interface CanvasWizardProbe {
  raw: unknown;
  candidates: { path: string; preview: string }[];
  result_path: string;
  /** 第一个命中位置上的值,且它是个 http(s) 地址时才有。向导拿它把**刚生成的那张图**
   *  显示出来 —— 一行 `data.result.images[0].url[0]` 只能证明"有个地址长得像结果",
   *  看见图才是"这条通道真的通了"。base64 / data URI 不给(体积)。 */
  preview_url?: string;
  /** 没找到图但有 task_id/status = 这家是异步的。**这件事文档里看不出来**,
   *  异步和同步供应商的示例 curl 长得一模一样,差别只在回包。 */
  is_async?: boolean;
  task_id_path?: string;
  /** 轮询探针才有 */
  status_path?: string;
  status?: string;
  done?: boolean;
}

