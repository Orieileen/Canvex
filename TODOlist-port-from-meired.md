# TODOlist · 从 meired 反向移植 canvas → Canvex

> **方向**:meired 的第二产品线 `canvas` 已比独立版 Canvex 领先多个版本。本清单把 meired canvas 的能力**解耦**(剥掉计费 / 组织鉴权 / library / 共享基建)后移植回独立版 Canvex,让 Canvex 追平。
>
> **不动 meired**:只读 meired 判断"哪些是 canvas 的内容",所有改动落在 Canvex(`/Users/eileen/Desktop/Canvex/`)。

**源**:`/Users/eileen/Desktop/meired/backend/apps/canvas/` + `/Users/eileen/Desktop/meired/frontend/src/`(canvas 相关)
**目标**:`/Users/eileen/Desktop/Canvex/backend/studio/` + `/Users/eileen/Desktop/Canvex/frontend/src/`
**参考**:meired 仓库根 `TODOlist-canvas.md`(当初正向移植的全过程,功能背景最全)

---

## 锁定决策(2026-06-20)

1. **数据库**:Canvex **MySQL → Postgres**。meired canvas 本就是为 PG 写的,模型近 1:1;原生 UUID + jsonb,不用 `CHAR(36)` 绕路;agent 记忆可直接用 PostgresStore 选项。Canvex 是原型、仅 4 migration,开发数据可丢 → 起干净 PG;若要留数据走 pgloader。
2. **前端主题**:Canvex **全局**采用 meired 观感。整块合并 meired `index.css` 的 `@theme / :root / .dark`(暖色板 ember/terra oklch、radius 0.75),不做 token 映射层。
3. **抠图模型**:保留 `briaai/RMBG-1.4`(非商用许可,已接受;商用部署再换 MIT/Apache 如 MODNet)。

## 解耦不变式(每个移植项都套这套)

- **计费**:删 `credit_event` FK、`reserve/commit/rollback/partial_refund`、成本常量、split 原子退款、前端 `loadBilling()`。Canvex 免费。
  - ⚠️ 前端**移除** Redux billing dispatch 和取 org 上下文的 `store` import,**不是**恢复 Redux。
- **组织/鉴权**:删 `organization`+`user` FK、`get_membership`、`filter_canvas_for_user`、`IsAuthenticated` → 塌缩成 AllowAny 单工作区空操作(保留接口签名便于将来加回)。
- **library.Asset / 共享基建**:把 provider 无关的小工具拷进 `studio/`;结果存 Canvex 自己的 asset 存储。

---

## Stage 0 · 解耦地基(基建,先行)

> **范围收敛**(2026-06-20 执行时定):Stage 0 = 换库 + 全局主题/radix,做成一个干净可独立合的 PR。
> 原列的**计费/org 空操作 stub 移到 Stage 1**(跟模型/首个调用方一起落,避免无人调用的死代码);
> **基建小工具(retry/SSRF/poll/upload_path/job_lifecycle 等)移到 Stage 2**(跟生成核心一起落、跟 Canvex 现有 `studio/tools/common.py` 一并 reconcile);
> `CANVAS_*` settings 配置块跟随其消费阶段(provider 进 Stage 2、agent 进 Stage 5)。

### 后端 — 换库 PG ✅(已落,分支 `feat/port-from-meired-stage0`)
- [x] `config/settings.py` DATABASES → `django.db.backends.postgresql` + `POSTGRES_*` 变量
- [x] `requirements.txt`:`mysqlclient` → `psycopg[binary]>=3.2`
- [x] `backend/Dockerfile`:去掉 `default-libmysqlclient-dev`
- [x] `docker-compose.yml`:`mysql:8.0` → `postgres:16`(env / `pg_isready` healthcheck / `postgres_data` volume / 两处 `depends_on`)
- [x] `.env.example`:`MYSQL_*` → `POSTGRES_*`
- [x] `README.md` / `README.zh-CN.md`:badge / 变量表 / 技术栈 / sqlite 注解
- [x] 自检:代码/配置零残留 mysql;4 个现有 migration 纯 Django ORM(无 MySQL 专有 SQL,PG 可直接 apply)
- [ ] **待你验证**:`docker compose up -d --build` 起 PG + 跑 migration(我这边无 docker/PG)

### 前端 — 全局主题 + radix(进行中)
- [ ] 全局合并 meired `index.css`(535 行:`@theme inline` + `:root`/`.dark` 暖色 token + Bayon/Inter 字体 + radius 0.75)到 Canvex `frontend/src/index.css`(122)+ reconcile `styles/canvex-shadcn.css`(511 行,Canvex 自有 shadcn 覆盖);肉眼回归 Canvex 现有非 canvas 页面
- [ ] 补 radix 缺失原语:`@radix-ui/react-popover`(SkillSelector 要),对比 meired UI 组件依赖逐个补齐
- [ ] i18n:合并 meired `i18n/{en,zh}.json` 的 canvas 命名空间到 Canvex `i18n`(可推到 Stage 6 前端核心一起)

---

## Stage 1 · 后端整体重 port(删 studio 业务层 → 从 meired apps/canvas 重建)

> **策略(2026-06-20 拍板)**:不增量合并,**整体重 port**。删 studio 业务逻辑,从 meired `apps/canvas/` 整体搬,剥计费/org,存储映射到 Canvex `DataAsset`。`config/`(PG/AllowAny/CORS/celery)保留。
> **一并删、不要**:Canvex 独有的 `graphs.py` / `memory.py` / `video_script.py` / `agent/flowchart.py` / 半成品 `agent/service.py`(flowchart + video_script 两个独有能力放弃)。

### 共同变换(每个 port 文件都套)
- **计费**:删 `credit_event` FK / reserve·commit·rollback·partial_refund;成本常量保留但置 0;`reserve_or_friendly_message` → 返回 None
- **org/auth**:删 `organization`/`user` FK 与 `get_membership`/`filter_*`;视图 AllowAny 单工作区;`get_scene_and_org` → 直接取 scene
- **存储**:`library.Asset`/`library.Folder` → `DataAsset`/`DataFolder`;`persist_canvas_image_results` / `persist_canvas_attachment` / `get_or_create_canvas_scene_folder` 适配到 DataAsset 接口
- **导入路径**:`apps.canvas.*` → `studio.*`;`apps.common.*` / `apps.listings.*` 的小工具(retry/poll/SSRF/upload_path/image_client)拷进 studio

### B1 · 清场 + 契约
- [ ] 删 studio 业务文件(留 `apps.py` / `migrations/__init__` / `admin` 壳;删 models/views/serializers/tasks/tools/agent/graphs/memory/video_script 旧内容)
- [ ] 定 studio 模块布局镜像 meired:`studio/services/{image,video,angle,scenes,attachments,billing}.py` + `studio/services/agent/{builder,tools/*}` + `studio/constants.py` + `studio/permissions.py`
- [ ] 写 billing no-op stub + org/auth no-op stub + **DataAsset 适配层**(meired 落库函数改调 DataAsset)
- [ ] port `constants.py`(`SPLIT_INPAINT_PROMPT` / `CUTOUT_LLM_PROMPT`;成本常量置 0)

### B2 · 模型 + 迁移
- [x] port 7 模型 `Scene` / `ChatMessage` / `ImageEditJob` / `ImageEditResult` / `VideoJob` / `AngleJob` / `AngleResult`;剥 org/user/credit;asset FK → `DataAsset`;`ImageEditJob` 带 `source_images`/`intermediate_image`/`split_partner`/`num_images`/`resolution`;`DataFolder`/`DataAsset` 保留;旧 `Excalidraw*` 删除
- [x] 删旧 migrations 0001–0004(引用已删模型)
- [ ] 新建 `0001_initial`:**B4 全部 port 完成后**跑 `docker compose run --rm backend python manage.py makemigrations studio` 自动生成(确定性正确,避免手写 9 模型迁移盲写出错),再 `migrate`——放 B5(中途破树时 makemigrations 可能卡)

### B3 · 服务 + tasks + agent ✅(workflow port,coherence PASS)
- [x] port `services/{image,video,angle,scenes,attachments}`:image(n=1 扇出 + provider fallback 链 + cutout 两段)、video(重试 + 可达性断言)、angle(fal.ai);`save_canvas_source_image` 走 models date 路径(剥 user)
- [x] port `services/agent/{builder,context,skills,tools/{image,video,common}}`:deepagents 单例 + 干净事件流 + skills(amazon-listing-pack-sop / image-prompt-sop);**不带 flowchart**;`common.py` 内含 DataAsset persist 适配
- [x] port `tasks.py`(5 task,name `canvas.*`,queue canvas/canvas_cpu + `job_lifecycle`,billing 走 no-op stub)、`signals`(source_image 同步清理)、`celery_signals`(rembg 预热);`apps.ready()` 挂载
- [x] 基建:`services/{http_retry,listings_utils,image_client}.py`

### B4 · 视图 + serializer + url + 配置 ✅
- [x] serializers(读写分离 + create;Result `get_url` 走 `DataAsset.file.url`)
- [x] views(全 AllowAny,15 个 view)+ urls;`config/urls.py` 挂 `/api/v1/canvas/`
- [x] settings `CANVAS_*` 块 + `PUBLIC_MEDIA_BASE`/`INTERNAL_MEDIA_BASE` + CELERY_TASK_ROUTES;`.env.example` CANVAS_* 样例;requirements 补 `langgraph-checkpoint-postgres`/`psycopg-pool`;docker compose `worker_canvas`(gevent)/`worker_canvas_cpu`(prefork)

### 收口清理 ✅
- [x] 删旧孤儿:`admin.py`(引用已删模型)、旧 `agent/`、`tools/`、`graphs.py`、`memory.py`、`video_script.py`;反查保留文件无残留引用(放弃 Canvex 独有 `canvex-workspace` SKILL)

### B5 · 后端验证(docker)✅ 主体通过
- [x] `manage.py check` → 0 issues;`shell -c "import studio.views, studio.tasks, studio.services.agent.builder"` → 16 objects(无版本漂移)
- [x] `makemigrations studio` → `0001_initial`(9 模型);`migrate` → OK
- [x] `up -d --build --remove-orphans` → 全容器 Started,postgres healthy,旧 mysql 孤儿移除
- [x] smoke:scene POST/GET 通(`/api/v1/canvas/`+DRF+PG 读写);worker_canvas 健康(`concurrency: 20 (gevent)`,5 task 注册,ready)
- [ ] chat→生图落 DataAsset(需 `.env` 填 CANVAS_CHAT_API_KEY + 图片 provider)—— 凭据就绪后验
- ⚠️ 旧前端仍打 `/api/v1/excalidraw/`(已不存在)—— 等 Stage 6–8 前端 port 才通

> **Stage 1 后端整体重 port = 完成并 smoke 验证(2026-06-20)。** 下一步:前端(Stage 0 全局换肤 + Stage 6–8)。

## Stage 6 · 前端核心

- [ ] 移 meired:`CanvasWorkspacePage`、`use-canvas-pinning`、`use-canvas-selection`、`submit-canvas-job`、六标签 `ImageEditBar`、`ChatOverlay`、`SkillSelector`、`canvas.service.ts`(NDJSON + 指数退避 + active-jobs resume)、`types`
- [ ] 接 image/video/angle/split 四个 edit hook;**剥掉 Redux/billing dispatch**
- [ ] `use-resume-canvas-jobs`:从 inline 提成 hook

## Stage 7 · 前端浮层 + 工具

- [ ] `Minimap`、`CanvasMeasureOverlay`、`CanvasImagePlacementOverlay`、`CanvasGeneratingOverlay`
- [ ] `use-merge-layer`(客户端拍平,≤4× 导出)、`use-canvas-image-import`(拖/贴/'9' 导入)、`use-back-to-latest`、`use-suppress-swipe-nav`、`use-selection-preview`
- [ ] lib:`excalidraw-bounds` / `excalidraw-custom-data` / `excalidraw-wheel-forward` / `canvas-skill-events` / `canvas-scene-files` / `canvas-image-output-size`

## Stage 8 · 前端 3D mockup + 调色(最重)

> three.js Canvex 已有(0.183);只需加 transformers.js。

- [ ] `Mockup3dOverlay`(DecalGeometry + 深度位移网格 + gizmo)、`use-mockup`、`canvas-mockup.ts`
- [ ] `ImageAdjustOverlay` + `FloatingAdjustPanel` + `use-image-adjust` + `canvas-adjust.ts` + `image-adjustments.ts`(18 滑块 / 8 段 HSL)
- [ ] `depth-estimation.ts`(transformers.js Depth-Anything-V2-Small,WebGPU→WASM)+ `segmentation.ts`(**RMBG-1.4**)+ `transformers-env.ts`(WebGPU 丢失恢复)
- [ ] 加依赖 `@huggingface/transformers`;文档化首次 ~50MB 模型下载(缓存 IndexedDB);React 19 strict mode 下验证 GPU/HMR 不泄漏

## Stage 9 · 联调 + QA

- [ ] PG 迁移验证;`docker compose up -d --build` 干净起 + `.env.example` 可跑
- [ ] 多 worker(gunicorn -w N)下 agent store 一致性
- [ ] E2E:新建 scene → chat 生图 → 生视频 → angle → split → mockup → 历史浏览
- [ ] Excalidraw 0.18 imperative API 契约回归(pinning / updateScene / scrollToContent)

---

## 关键集成风险(逐阶段消化)

- **换库**:Canvex 现 MySQL,改 PG 后所有迁移要重跑;留数据需 pgloader / dump-load。
- **React 19 vs 18**:meired 是 18,Canvex 是 19;three.js + transformers.js 的 WebGL/并发渲染/Suspense/HMR 需在 19 下验证(strict mode 重挂可能双触发 GPU init)。
- **主题全局化**:暖色板会改 Canvex 全站观感,合并后逐屏回归。
- **transformers.js 打包**:~50MB ONNX 懒加载;Vite tree-shaking 需确保只在 `use-mockup` 动态 import。
- **RMBG 许可**:`briaai/RMBG-1.4` 非商用(已接受)。
- **radix 版本/缺件**:补 popover 等;对齐 `@radix-ui/*` 版本。
- **NDJSON 事件**:meired 7 路 union,Canvex `use-chat` 较简,合并完整解析 + skill badge 嗅探。
