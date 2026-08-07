# 生图供应商配置搬到前端 — 设计

## 目标与范围

**目标**:用户在画布里生成每一张图时都能选用哪个模型(比如第一张用 Google、第二张用 GPT、第三张用豆包),而不是被后端 env 里写死的那一个绑住。供应商的 base_url、API key、请求参数全部在前端配置界面里填,配完即用,不改 env、不重启容器。做完之后**生图相关的 env 变量为 0**。

**这一轮只做生图。**

- **聊天模型不动**,继续走 `CANVAS_CHAT_*` env。原因是它有两个独立的技术障碍(见文末「已验证的结论」),和生图无关,单独做更清楚。
- **视频不动**,继续走 `CANVAS_VIDEO_*` env。`video.py` 完全没有通道参数化,是 `_require_config()` 直读 settings 的单槽结构,要跟进得先把它重构成和生图同构 —— 那是独立的一块工作量。

---

## 现状:抽象已经存在,只是被锁在 env 前缀里

生图这条链**每个函数都接受 `prefix: str`**,然后读 `{prefix}_XXX`。所以「通道」这个概念是现成的,只是:

1. 通道的**身份**是一个 env 变量前缀
2. 数量**固定为 2**(`CANVAS_IMAGE_PRIMARY` / `CANVAS_IMAGE_FALLBACK`)
3. 只有**部署者**能配

这三点正是要改的。下游的 fan-out、重试、回退全都只是把 `prefix` 往下传,**换掉解析层它们一行都不用动**。

### 16 个参数,分布在两个函数里

| 读取处 | 参数 |
|---|---|
| `image_client.build_image_client()` | `BASE_URL` `API_KEY` `MODEL` `IMAGE_FIELD` `IMAGE_AS_SINGLE` `RESPONSE_FORMAT` `QUALITY` `WATERMARK` `INLINE_IMAGE` `TIMEOUT` |
| `tools/image.py:_single_generation()` | `SIZE_MODE` `POLL_ENABLED` `POLL_URL` `POLL_MAX_ATTEMPTS` `POLL_INTERVAL` `POLL_TIMEOUT` |

所以改造面就是这两个函数的入参:`build_image_client(prefix)` → `build_image_client(cfg)`,`_single_generation(prefix, ...)` → `_single_generation(cfg, ...)`。

### 两个入口,汇到同一个卡点

- **Agent 路径**:`generate_image` 工具 → `_generate_with_fallback`
- **工具栏路径**:`POST /scenes/<id>/image-edit/` → `ImageEditJob` → celery `run_image_edit_job` → 同样是 `_generate_with_fallback`

只有一个卡点要改。但**工具栏那条是异步的** —— 选择必须**落到 `ImageEditJob` 行上**,worker 之后才读得到,不能只当请求参数传。

---

## 数据模型

两层。参数**不全在上层** —— 同一把 APIMart key 下面挂豆包和 Google 时,豆包要 `SIZE_MODE=pixel`(火山合法像素),Google 不要;有的模型异步轮询,有的同步直返。**这些差异是模型级的。**

```
ImageProvider
  id            uuid
  label         "APIMart"              人看的名字
  base_url      https://...            允许私有地址(见下)
  api_key       明文存储(见「key 的处理」)
  defaults      JSON,16 个参数的默认值
  created_at / updated_at

ImageModel
  id            uuid
  provider      FK → ImageProvider
  label         "Nano Banana"          工具栏里显示的就是这个
  model         供应商要的那个模型字符串
  overrides     JSON,只存与 provider defaults 不同的字段
  enabled       bool
  sort_order    int
```

**解析规则**:`resolve(model_id)` → `{**provider.defaults, **model.overrides, "model": model.model, "base_url": provider.base_url, "api_key": provider.api_key}`

**不建模型别名映射表**(`gemini-2.5 → 各家叫什么`)。穷举「所有供应商 × 所有模型」的命名差异是无底洞;每条 `ImageModel` 自己声明它那家要的字符串即可 —— 现在的 `{prefix}_MODEL` 就是这个语义。

---

## 两个缓存要处理

### `build_image_client` 的 `@functools.cache`

现在按 prefix 缓存,注释写明是为了**复用 TCP 连接池**。配置可编辑之后,按 id 缓存会在用户改完配置后继续发旧的。

**做法**:把缓存键从 `prefix` 换成**解析后完整配置的不可变元组**。用户改了任何字段 → 元组变了 → 自然拿到新 client,旧的被 LRU 淘汰;没改 → 命中,连接池照常复用。不需要任何显式失效逻辑。

### Agent 单例(本轮不涉及,记录备查)

`build_canvas_agent()` 是 `global _agent` 进程级单例,模型绑死在建图时。**已实测**:deepagents 0.7.5 不支持运行时换模型(`configurable_fields` 和 `init_chat_model(configurable_fields=…)` 都因为不是 `BaseChatModel` 被拒)。但建图只要 **21ms**,所以将来做聊天时直接改成每轮重建、不要缓存。本轮不动。

---

## 选择怎么流动

| 路径 | 载体 |
|---|---|
| 工具栏(异步) | `ImageEditJob.image_model` FK(可空) |
| Agent(同轮) | chat POST body → `ChatMessageCreateSerializer` → `CanvasAgentContext.image_model_id` → `generate_image` 工具读它 |

Agent 那条走的是**现成的路子** —— `attachments` 和 `disabled_skills` 就是这么传的,今天还在跑。`generate_image` 工具加一个可选参数,agent 不需要理解供应商。

**选择要粘住**:画布是连续多轮的,每次都重选很烦。存 scene 级(或 localStorage),默认沿用上次,单次可覆盖。

---

## 回退语义要改

现在是 primary 挂了自动切 fallback。用户**显式选了**模型之后再静默换供应商是错的 —— 出图风格完全不同,而他不知道发生了什么。

- **显式选择** → 不回退。失败就明确告诉他「这个通道失败了:<原始错误>」
- **没选(用默认)** → 保留现有回退行为

---

## 接口

```
GET    /api/v1/canvas/image-providers/            列表(含 api_key 明文,配置页要能回显)
POST   /api/v1/canvas/image-providers/            新建
PUT    /api/v1/canvas/image-providers/<id>/       修改
DELETE /api/v1/canvas/image-providers/<id>/
POST   /api/v1/canvas/image-providers/<id>/test/  发一次最便宜的真实调用,回传原始错误
POST   /api/v1/canvas/image-providers/import-curl/  见下
GET    /api/v1/canvas/image-models/               工具栏拉这个:{id, label, provider_label, enabled}
```

模型的增删改可以嵌在 provider 里(一次 PUT 带 models 数组),避免前端管两套 CRUD。

---

## 前端配置界面

### 不做预设,做「从 curl 导入」

不内置供应商预设(维护负担,且永远追不上)。但**那 16 个字段不是供应商的词汇,是 Canvex 适配器的词汇** —— 供应商文档会写「`image` 传 URL 数组」,不会告诉你 `IMAGE_AS_SINGLE` 该开还是关。用户要做的是把文档**翻译**成我们的旋钮,卡住的就是这一步。

**解法**:用户从供应商文档复制示例 curl 粘进来,解析请求体形状,自动推断 `base_url` / `IMAGE_FIELD` / `IMAGE_AS_SINGLE` / `RESPONSE_FORMAT`。完全贴合「对着文档填」的思路,只是把翻译自动化,且不需要维护任何供应商列表。推断不出来的字段留空让用户填。

### 字段提示直接用代码里现成的

`image_client.py` 的字段注释已经把每个旋钮为什么存在写清楚了,直接搬成表单提示:

- `IMAGE_AS_SINGLE` — 「tu-zi 的 schema 写 image=array,但实测只接受单 string;n=1 时开这个」
- `WATERMARK` — 「火山 doubao-seedream 默认右下角打 "AI生成" 水印;不传=用供应商默认,显式 false 才关掉」
- `INLINE_IMAGE` — 「供应商自己拉不到远程源图时开(火山北京跨境拉海外 CDN 会超时);开了就由后端下好转 base64 内联下发」

### 「测试连接」是必需品

没有预设之后它更是唯一的反馈回路。配错一个字段,现在的表现是三分钟后 celery worker 里一个看不懂的失败。必须能当场发一次最便宜的真实调用,**把供应商返回的原始错误原样显示**。

### base_url 允许私有地址

本地开源项目,用户很可能要接本机推理服务:

```
http://localhost:11434     Ollama
http://localhost:1234      LM Studio
http://192.168.1.x:8000    局域网另一台机器
```

**所以不做 SSRF 公网校验** —— 那会把这个场景整个砍掉。只校验是不是合法 http(s) URL。

⚠️ **必须写进字段提示**:后端跑在容器里,填 `http://localhost:11434` 会解析到**容器自己的** localhost,不是宿主机。接本机服务要填 `host.docker.internal:11434`。否则每个想接 Ollama 的用户都会卡在这里,而报错是「连接被拒绝」,完全看不出原因。

---

## key 的处理

威胁模型是**本地单机开源工具**,不是公网 SaaS。所以:**不加密、不鉴权、不做 SSRF 校验。**

`api_key` 就是一个普通 `CharField`,明文存库。加密在这里是演戏 —— 密钥只能放 env,而 env 和数据库在同一台机器上、同一个人手里,加了等于没加,却要付一个"加密密钥必须存在"的 env 依赖。**去掉它之后,生图相关的 env 变量真的降到 0。**

连带简化:**不需要「只写不读」**。GET 直接返回 key,配置页能显示用户填过什么、直接编辑,不用做"留空表示不修改"那种别扭交互。

只保留一条几乎不花钱的卫生要求:**key 不要进日志和错误响应**。开源项目里真实会发生的是用户把报错贴到 GitHub issue 求助 —— 供应商返回 401 时把原始报文透传给前端很方便,但那里面可能带着 Authorization 头。取配置后也别顺手把整个 config dict 打进日志(现在记的是 prefix,是安全的,改造后别退化)。

---

## env 迁移

现有部署 env 里配好的东西不能被打断。首次启动时如果库里没有任何 provider 而 env 有 `CANVAS_IMAGE_PRIMARY_MODEL` → **导入一次**,建出对应的 provider + model 记录,之后 env 只作为兜底/引导。

---

## 不在本轮范围

- 聊天模型(`CANVAS_CHAT_*` 保持 env)
- 视频(`CANVAS_VIDEO_*` 保持 env,且需要先重构成通道化)
- 鉴权 / 多用户 / 配置归属(当前 `Scene` 无 owner、全站 `AllowAny`,单机工具不需要)
- 模型能力探测(比如自动判断支持哪些尺寸)

---

## 实施顺序

1. **模型 + 迁移**:`ImageProvider` / `ImageModel` 两张表,`ImageEditJob.image_model` 可空 FK
2. **解析层**:`resolve(model_id) -> dict`;`build_image_client(cfg)`;`_single_generation(cfg, ...)`。下游 fan-out / 重试 / 回退不动
3. **接口**:CRUD + test + import-curl
4. **两个入口接上**:`ImageEditJob` 建任务时带上选择;chat POST → ctx → `generate_image`
5. **env 导入**
6. **前端**:配置页(表单 + curl 导入 + 测试按钮)+ 工具栏模型选择器 + 选择粘住
7. **回退语义**改成「显式选择不回退」

1–2 是核心,做完就能用 API 验证整条链;3–5 让它可配;6 才是界面。

---

## 已验证的结论(动手前实测,不是推断)

- `create_deep_agent(model=…)` **绑死在建图时**。`ChatOpenAI(...).configurable_fields(...)` → `RunnableConfigurableFields`,`init_chat_model(configurable_fields=…)` → `_ConfigurableModel`,**两者都不是 `BaseChatModel`,都被 `create_deep_agent` 拒绝**(报 `count is not a BaseChatModel attribute` —— 它把非 `BaseChatModel` 当字符串处理)。
- 但**建一次图只要 21ms**(5 次实测 23/21/21/21/22,含真实工具集 + skills + CompositeBackend)。所以将来做聊天时:**每轮重建,不要缓存** —— 省 21ms 不值得引入缓存失效 + 多 worker 不一致的复杂度,而且改完配置立刻生效正是搬到前端的初衷。
- 生图和工具栏两条路径**确实汇到 `_generate_with_fallback` 一个卡点**。
- `build_image_client` 的 `@functools.cache` 是为**TCP 池复用**存在的,不是为了省构造开销 —— 所以不能简单删掉,要换缓存键。
