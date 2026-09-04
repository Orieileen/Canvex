<div align="center">
  <h1>Canvex</h1>
  <p>Canvex 是一个具有对话、skills、生成和编辑图像和视频能力的无限画布 LLM Agent。通过场景管理，可以将多个画布用于不同的项目。</p>
  <p>
    <a href="https://react.dev"><img src="https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB" alt="Frontend"></a>
    <a href="https://www.djangoproject.com/"><img src="https://img.shields.io/badge/Backend-Django%20%2B%20DRF-092E20" alt="Backend"></a>
    <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1" alt="Database"></a>
    <a href="https://redis.io/"><img src="https://img.shields.io/badge/Queue-Celery%20%2B%20Redis-DC382D" alt="Queue"></a>
    <a href="https://github.com/langchain-ai/deepagents"><img src="https://img.shields.io/badge/Agent-deepagents-1C3C3C" alt="Agent"></a>
  </p>
</div>

语言：[English](./README.md)

## 功能

- **聊天即创作** —— 在画布底部聊天框输入提示词，agent 生成一张或多张图片（或一段视频）并落到画布上。对话记录本身就是画布上的一个框，能像别的元素一样拖动、缩放、滚动。
- **任意图片上的 AI 工具栏** —— 选中图片即弹出浮动工具栏：
  - **编辑** —— 用提示词改风格/改内容。
  - **抠图** —— 一键去背景成透明主体。
  - **拆分** —— 从一张图产出上下两张：透明主体 + 去掉主体的干净背景。
  - **换视角** —— 拖一个 3D 立方体，从新机位重渲染（fal.ai LoRA）。
  - **视频** —— 把静图变成一段动画。时长、比例、画质三个旋钮**全部按你选的模型来**，不是画布写死的一张表：veo3 只出 8 秒，sora-2 是 4/8/12/16/20，七个模型不收 1:1，还有十个根本没有比例这个入参 —— 那几个下拉直接不出现。
  - **样机** —— 借深度把一张设计图贴到另一张图上，带 深度 / 蒙版 / 不透明度 控制。
  - **合并 / 调整 / 下载 / 发到聊天** —— 本地拍平选区、Lightroom 风格调色面板、导出画布、或把图作为LLM Agent参考附件。
- **多图合成** —— 一次框选最多 8 张图，「图像」页签会变成「合成 N 张图…」，这些图会一起发给供应商。其余工具是单图操作，多选时置灰。
- **框 & 箭头标注** —— 精细化编辑图片：在图上画框/箭头/文字来指向要改的区域。
- **Skills（技能）** —— agent 自己判断该不该用的 playbook（如 `image-prompt-sop` 把模糊需求改写成高质量单图提示词、`amazon-listing-pack-sop` 一键生成协调的 7 张亚马逊套图）。侧栏「技能库」可以装自己的：拖一个 `SKILL.md` 进去（或者直接在浏览器里写），下一条消息 agent 就会用上，**不用重启**。停用和删除也在那里；聊天框里那个是按单条消息临时跳过。
- **场景** —— 侧栏里多个独立画布：新建、重命名、删除、快速切换；编辑自动保存。**置顶是浏览器本地的偏好**（localStorage），不跨设备同步。
- **原图就是原图** —— 拖进来、粘进来、或者用工具栏打开的图，都按**原生像素**落到画布：Canvex 走后端上传，而不是让画布把它压到 1440px 再重编码。工具栏和粘贴那两条还带一个跟着光标走的放置预览。
- **生成过程看得见** —— 点下生成的那一刻，画布上就按**结果的尺寸**预留好一个框；失败时它原地变成一张带供应商原始报错的卡片，而不是一个红色墓碑。渲染中刷新页面，它会把任务接回来继续等。
- **素材库** —— 保存你生成过的所有图片/视频，按画布分组；点缩略图即可重新插回当前画布。

## 架构概览

```mermaid
flowchart LR
  subgraph FE["前端 — React + Excalidraw"]
    Chat["聊天框"]
    Bar["AI 工具栏"]
  end
  subgraph BE["后端 — Django + DRF"]
    Agent["deepagents agent<br/>(skills + tools)"]
    API["job 端点"]
  end
  Q[["Celery 队列<br/>canvas · canvas_cpu"]]
  Prov["图像 / 视频 / fal.ai 供应商"]

  Chat -->|"POST /chat/ (SSE)"| Agent
  Agent -->|"generate_image · generate_video"| Q
  Bar -->|"编辑 · 抠图 · 拆分 · 换视角 · 视频"| API --> Q
  Q --> Prov --> Q
  Q -->|"轮询 job → 落到画布"| FE
```

- 聊天 agent 是 **deepagents**（`create_deep_agent`），带两个工具（`generate_image`、`generate_video`）、一份按场景隔离的 memory 文件、以及按需展开的 **SKILL.md** 技能。每轮对话历史从数据库回放（不需要独立的记忆存储）。
- 每次生成都是异步 **job**：API 建一条 `QUEUED` 记录、提交后入 Celery 队列；前端轮询 job 直到结果就绪再落到画布。抠图是两段链（LLM 出白底 → CPU rembg 出 alpha）。

## 部署

### 1）克隆

```bash
git clone https://github.com/Orieileen/Canvex.git
cd Canvex
```

### 2）配置

```bash
cp .env.example .env
```

本地跑的话默认值直接可用，**这里不填任何 API key** —— 通道在应用内配置（第 4 步）。`.env` 只管基础设施：端口、数据库，以及 `PUBLIC_MEDIA_BASE`（见下表）。

### 3）启动（Docker）

前置：Docker + Docker Compose。

- Docker Desktop：[https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
- Docker Compose 安装文档：[https://docs.docker.com/compose/install/](https://docs.docker.com/compose/install/)

```bash
docker compose up -d --build
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:28000

### 4）添加通道

由于各家供应商的请求参数各不相同，Canvex 预设了一套 API 供应商格式（不是广告）：

1. **聊天（LLM agent）模型** —— Canvex 预设了 LLM agent 的第三方供应商 **[兔子 tu-zi](https://api.tu-zi.com/)**：在 tu-zi 注册后拿到 API key，填进 Canvex 的通道配置即可用。必须是支持 OpenAI 风格 **tool calling** 的 key —— 不支持的填进来，聊天框会回一段文字然后画布上什么都不发生。
2. **图片生成 · 自定义模板** —— Canvex 预设了生成图片的第三方供应商 **[API Mart](https://apimart.ai/)**：在 apimart 注册后拿到 API key，填进配置即可用。编辑图片、拆分图片、以及 LLM agent 调用的生图 tool，都用这一把 key。
3. **视角重渲染** —— 先去 **[fal.ai](https://fal.ai/)** 注册拿到 API key，用于「换视角」（改变机位）功能。
4. **视频生成 · 自定义模板** —— Canvex 预设了生成视频的第三方供应商 **[API Mart](https://apimart.ai/)**：同样是注册拿到 API key 填进配置即可用。


#### apikey使用步骤：
**快捷配置** —— 打开 http://localhost:5173，点左侧栏的「通道配置」。在「快捷配置」中填入对应供应商的key即可。下面列出Canvex可用预设：

| 角色 | 预设 |
| --- | --- |
| 聊天 | **[兔子 tu-zi](https://api.tu-zi.com/)**、OpenAI、Google、DeepSeek、智谱 GLM |
| 生图 | **[API Mart](https://apimart.ai/)**、OpenAI、Google |
| 视频 | **[API Mart](https://apimart.ai/)** |
| 换视角 | **[fal.ai](https://fal.ai/)** |

### 以下有三种方法可以使用：
**1.聊天/llm agent用[兔子](https://api.tu-zi.com/)、生图和视频用 [API Mart](https://apimart.ai/)，变换视角使用[fal.ai](https://fal.ai/)是这个项目经过测试得出跑的最稳最便宜的供应商** —— 这里每个功能都是对着它们做出来、验过来的，所以想最快跑通就配这两家。其余几条聊天/llm agent官方供应商通道也可以使用，不过openai等国外供应商一方面比较贵，一方面api并不好买，除了tu-zi也可以使用国内llm厂商，而图片apimart则是便宜+稳定。换视角只有一个选项，因为视角 LoRA 只在 [fal.ai](https://fal.ai/) 上。

**2.从一段 curl 开始配置供应商** —— 如果要使用不在Canvex列表的供应商走这条：把你需要的api供应商文档里的示例 `curl` 粘进去，Canvex向导会替你自动把通道拼出来，不用写 JSON。（这个功能可能不适配所有供应商）

**3.新建自定义供应商配置** —— 完全自己写请求模板。你需要知道供应商所有的请求参数以及值怎么写，并手动拼成json填入自定义供应商

模型行右边的 ⚡ 会真发一次最小生成。它只出现在生图和换视角通道上：聊天通道要验的是它认不认 `tools` 参数，直接在聊天框里说「生成一张图」最快；视频则太慢，撑不过一次同步测试 —— 对视频来说，画布上第一条真片子就是那次测试。

每条通道名字左边有一个**状态点**：绿 = 上次调用通了，橙 = 上次失败，空心 = 还没调用过。真实生成也会更新它，不只是 ⚡ —— 一条通道哪天悄悄坏了（key 过期、额度打光、供应商换端点），在这里一眼能看见，而不是变成又一次莫名其妙的生成失败。展开失败的卡片，能看到供应商返回的原文，**上面还有一句**说这属于哪类问题、该改哪儿：key 过期、余额打光、模型名供应商不认、以及人家自己挂了，在原始报错里长得都差不多，而其中只有一部分是靠改配置能解决的。

每个模型行下面还能挂自己的**覆盖项** —— 一条通道底下挂着四十个在时长、比例、键名上互相不一致的模型，而不是建四十条通道，靠的就是它。如果你是手写通道：这些旋钮填错**大多不会报错**，只是静默失效 —— 比例发到一个供应商不读的键上不是错误，只是那个设置永远不起作用。

## 环境变量

**照第 2 步 `cp .env.example .env` 之后，这个文件一行都不用改。** 里面每一项都有能直接跑的默认值；`docker compose up` 需要它**存在**，但不需要你动它。（这里不展示各项配置了）
[.env.example](./.env.example)。）


说明：

- 从旧版本升级：原有的 `CANVAS_CHAT_*` / `CANVAS_IMAGE_PRIMARY_*` / `CANVAS_IMAGE_FALLBACK_*` / `CANVAS_ANGLE_FAL_*` / `CANVAS_VIDEO_*` 会被迁移 `0008` / `0010` / `0013` / `0015` 自动导进库，导完就不再读取，可以从 `.env` 里删掉。
- 产品免费、单工作区：没有鉴权，计费是空操作桩（`CANVAS_CREDIT_COST_*` 不起作用）。

## API

所有路由在 `/api/v1/canvas/` 下。

| 用途 | 端点 |
| --- | --- |
| 场景（CRUD） | `GET/POST /scenes/`、`GET/PATCH/DELETE /scenes/{id}/` |
| 聊天（SSE 流） | `POST /scenes/{id}/chat/` |
| 图像编辑 / 生成 | `POST /scenes/{id}/image-edit/` → `GET /image-edit-jobs/{job_id}/` |
| 拆分（主体 + 背景） | `POST /scenes/{id}/split/` → 返回两个 job，都在 `/image-edit-jobs/{job_id}/` 轮询 |
| 视频 | `POST /scenes/{id}/video/` → `GET /video-jobs/{job_id}/` |
| 换视角（fal.ai） | `POST /scenes/{id}/angle/` → `GET /angle-jobs/{job_id}/` |
| 进行中的 job（恢复轮询） | `GET /scenes/{id}/active-jobs/` |
| 每个场景的 job 历史 | `GET /scenes/{id}/image-edit-jobs/`、`/video-jobs/`、`/angle-jobs/` |
| 发到聊天的上传 | `POST /scenes/{id}/upload-attachment/` |
| 素材库 | `GET /media-library/folders/`、`GET /media-library/folders/{scene_id}/items/` |
| Agent 当前看得见的技能 | `GET /skills/` |
| 装 / 卸技能 | `GET` / `POST /skill-library/`、`PATCH` / `DELETE /skill-library/{id}/` |
| 通道（CRUD + 嵌套的模型） | `GET/POST /image-providers/`、`GET/PATCH/PUT/DELETE /image-providers/{id}/` |
| ⚡ 测一条通道 | `POST /image-providers/{id}/test/` —— 失败也返 **200**，带原始报文 + 诊断码 |
| 表单字段表 + 一键预设 | `GET /image-providers/schema/` |
| curl 向导 | `POST /image-providers/wizard/parse/`（只解析不发送）、`POST /image-providers/wizard/probe/`（拿**还没保存**的通道真发一次生成） |
| 工具栏选择器读的模型列表 | `GET /image-models/`（回包里**不含** base URL / key） |

聊天端点走 **SSE**（`text/event-stream`，每个事件的帧格式是 `data: <json>\n\n`）。事件类型：`user_created`、`assistant_delta`（逐 token 的文字流，实际量最大的就是它）、`tool_call`、`tool_result`、`canvas_asset`（`{url}`，agent 本轮产出、客户端要落到画布的图）、`assistant_final`、`assistant`、`error`、`done`。

## 后端

技术栈：**Django + DRF + Celery + Redis + PostgreSQL + deepagents**（底层是 LangChain / LangGraph）。

```
backend/
├── config/                      # Django 工程 (settings, celery, urls, wsgi/asgi)
└── studio/                      # 主 app，挂在 /api/v1/canvas/
    ├── models.py                # Scene, ChatMessage, ImageEditJob/Result, VideoJob,
    │                            #   AngleJob/Result, DataFolder/DataAsset,
    │                            #   ImageProvider/ImageModel (通道), Skill
    ├── views.py  serializers.py  urls.py
    ├── tasks.py                 # Celery: canvas.image_edit_job / image_edit_cutout_job
    │                            #   / video_job / angle_job / cutout_llm_step
    ├── tests/                    # 预设与端点的契约、curl 导入、比例、通道诊断、
    │                             #   聊天协议、请求模板
    └── services/
        ├── image.py video.py                 # **只**建 job —— 真正调供应商的在
        │                                     #   agent/tools/ 里, 见下
        ├── angle.py                          # 建 job + 调 fal.ai
        ├── image_client.py                   # OpenAI 兼容图像客户端, 由一个 ImageChannel
        │                                     #   构造 (库是唯一配置来源)
        ├── image_channels.py                 # 库里那两级行 → 每个调用点消费的那一个
        │                                     #   ImageChannel; 通道类型规则、预设、表单
        ├── template_client.py                # 真正跑一条用户写的请求模板: 发送、轮询、
        │                                     #   从回包里把结果挖出来
        ├── request_template.py               # 模板格式本身 (占位符放哪儿)
        ├── curl_import.py                    # 供应商的示例 curl → 那份模板
        ├── channel_health.py                 # 每次真实往返之后写那个状态点
        ├── channel_diagnosis.py              # 供应商报错 → 「这属于哪类问题」
        ├── attachments.py scenes.py billing.py (空操作) http_retry.py listings_utils.py
        └── agent/
            ├── builder.py        # create_deep_agent (model, tools, skills, memory, store)
            ├── skills.py  context.py
            ├── skill_md.py       # 解析 + 准入检查上传的 SKILL.md
            ├── tools/            # **不只是 agent 的工具** —— 全产品每一个图/视频 job
                                  #   都在这儿真正执行, 包括工具栏发起的
                                  #   (common.py, image.py, video.py)
            └── skills/           # 只是出厂种子 —— 迁移 0018 把它导进库, 运行时以库为准
                                  #   (改这些文件不生效)
```

### 异步 job 流水线

一个生成请求会在事务里建 `QUEUED` job、提交后入 Celery 队列（返回 `202` + `{job_id, status}` —— 拆分返回两个，两条 leg 各一个）。任务跑在专用队列上：

| 队列（worker） | 池 | 任务 |
| --- | --- | --- |
| `canvas`（`worker_canvas`） | gevent | `image_edit_job`、`video_job`、`angle_job`、`cutout_llm_step` |
| `canvas_cpu`（`worker_canvas_cpu`） | prefork | `image_edit_cutout_job`（rembg alpha，CPU 密集） |
| `excalidraw`（`worker`） | prefork | 默认队列 |

抠图/拆分是两段链：第一段（LLM，跑 `canvas`）出白底图，第二段（rembg，跑 `canvas_cpu`）把白底转透明 alpha。前端轮询 job 端点（或 `/active-jobs/`），就绪后落到画布。聊天 agent 调用的图像/视频工具建的是同样的 job —— agent 返回一句"已入队"，不阻塞等渲染。

## FAQ

- **查日志**（某个 job 失败时）—— 要带上三个 worker：

  ```bash
  docker compose logs -f backend worker worker_canvas worker_canvas_cpu
  ```

- **图像结果不对或报错** —— 在侧栏「通道配置」里核对 base URL、key 和模型名，用 ⚡ 测一下。视频通道也在同一个面板里配，但**没有 ⚡**（见第 4 步）：对它来说，画布上第一条真片子就是那次测试。
- **视频好像卡住了** —— 多半没有。视频供应商本来就要几分钟；模板通道的轮询预算给到了约 50 分钟，那个数是照 APIMart 一次真实出片实测定的。整个等待期间画布上都留着那个占位框，刷新页面也还在。
- **某次生成栽在源图上** —— 它会直说：job 翻成 FAILED，带着供应商自己的报错原文，画布会把它显示在占位卡片上。这**不是** `PUBLIC_MEDIA_BASE` 的问题 —— Canvex 要么把源图内联成 base64，要么主动推给供应商，从不指望谁来访问你的机器。唯一还需要「公网可达」的，是**你自己粘进来的外部 URL**。图生视频那一类见下一条。
- **图生视频报「抓不到你的图」** —— 有些视频供应商既不收 base64 源图、又要求图片地址公网可达。对这种，通道上的 `upload_path` 指向供应商自己的上传端点，Canvex 在生成之前先把字节推过去（仍然是**我们往外发**请求，没有人来访问你的机器）。API Mart 的视频预设自带这一项；手写的视频通道要自己填。
- **前端请求被 CORS 拦** —— 保持 `CORS_ALLOW_ALL_ORIGINS=true`（默认），或把你的来源加进 `CORS_ALLOWED_ORIGINS`。
