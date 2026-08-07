# TODOlist · 把 Canvex canvas 的增强 port 回 meired

> **方向(与 `TODOlist-port-from-meired.md` 相反)**:这一轮在独立版 Canvex 上做的若干增强已**反超** meired 的 `canvas` 产品线。本清单把这些能力 port **回** meired。
>
> **不动 Canvex 当源、改动落 meired**:只读 Canvex 取实现,改动落 meired(`/Users/eileen/Desktop/meired/`)。
> ⚠️ 本会话的硬约束是"只读 meired、改 Canvex",所以**本清单只做规划,不在本会话动 meired**。真正执行时反过来。

**源**:`/Users/eileen/Desktop/Canvex/backend/studio/` + `/Users/eileen/Desktop/Canvex/frontend/src/`
**目标**:`/Users/eileen/Desktop/meired/backend/apps/canvas/` + `/Users/eileen/Desktop/meired/frontend/src/`(canvas 相关;workspace 页是 `frontend/src/pages/dashboard/canvas/CanvasWorkspacePage.tsx`)

---

## 重新耦合不变式(每项都要套 —— 是反向移植解耦的逆操作)

Canvex 是单工作区 / 免费 / 无 library 的精简版;meired 是多租户 / 计费 / 共享基建。port 回去时要把 Canvex 砍掉的东西**加回**:

- **组织/鉴权**:所有新 DB 查询加 `organization` 作用域(`filter_canvas_for_user` / org FK);view 用 `IsAuthenticated` + `get_membership`,不能 AllowAny。
- **library.Asset**:Canvex 把结果存自己的 `DataAsset`;meired 走 `library.Asset`(带 org/folder)。新序列化器 / 视图要查 `library.Asset`,不是 `studio` 模型。
- **计费**:纯展示 / 布局类(Chat frame、零重叠、media library)**不碰计费**;只有"会触发生成"的改动(Split box→region、1K 档)要确认仍走 `reserve/commit/rollback`,别绕过额度。
- **前端状态**:meired 用 Redux + org 上下文;Canvex 用本地 state。新组件接 meired 的 store/RTK Query 习惯。

---

## A. 速赢:meired 现存 bug 的修复(低成本、高价值,优先)

### [x] A1. 生成图零重叠保证 — 已 port (meired)。tsc/eslint/66 单测 ✓;live pack-gen 未验(需 credit)
meired 现在**两个 bug 都在**,套图必叠 + 超大图外溢。
- **源**:`Canvex frontend/src/hooks/use-canvas-pinning.ts`
  - `createPlaceholder` 的 `imageBox`:去掉 `slotIdx !== undefined` 排除,让套图占位框也用 `resultSize`(否则 slot 框写死 400²、结果 2048² → 7 张叠一起)。
  - `replacePlaceholderWithImage`:结果按 `fit = Math.min(1, box.w/nativeW, box.h/nativeH)` 等比 cap 进预留框(否则超大 img2img 回显源图尺寸 → 居中外溢啃邻居)。
- **目标**:`meired frontend/src/hooks/use-canvas-pinning.ts` 同名函数(对照 meired:1208 `imageBox`、1436 replace 的 native 落位)。
- **复杂度**:小(各一处)。**无计费/org 影响**,纯前端布局。

### [x] A2. 1K 分辨率档 — 已 port (meired)。迁移 0010 已生成;**真实 meired 浏览器验证 ✓** (分辨率下拉 1K/2K/4K);计费确认 flat 不分档
- **源**:`Canvex frontend/src/lib/canvas-image-output-size.ts`(`edge = "4K"?4096:"1K"?1024:2048`)。
- **目标**:meired 同名 lib + resolution enum/UI(meired 只有 2K/4K)。
- **复杂度**:小。⚠️ **计费**:确认 1K 是否单独计价档(meired 成本常量可能按档,要加 1K 行)。

---

## B. 刻意**不** port —— base64 源内联

### [x] ~~B1. 本地源 base64 内联~~ —— **不移植,保留 meired 现状(URL 方式更优)**
最初以为是"部署痛点修复",**判断有误**。meired 已配好公网 host,公网 URL 没痛点;而且 URL 方式对 token 是**优势**,不是负担:

- **生成工具**(img2img):base64 vs URL 对 LLM token 影响不大(图发给图像 provider)。
- **Chat LLM 看图**(多模态 `image_url`):传**公网 URL** → provider 服务端自己 fetch,请求里只多几 token;传 **base64 data URI** → 整张图(2048² ≈ 几 MB base64)塞进请求体,**token 爆炸**。

所以 meired 用 URL = 既无部署痛点,又为"聊天模型看图"留了极省 token 的路。Canvex 用 base64(`source_to_inline_uri`)是为了**不依赖公网**,代价正是——要让 LLM 看图就得 base64、太贵,故 Canvex 干脆不做 chat-vision(对应之前用户拍板的"保持 meired 行为")。

👉 **结论**:base64 内联是 Canvex 的本地化取舍,**不 port 回 meired**。反而如果将来要做 chat-vision,meired 凭公网 URL 可以低成本实现,Canvex 不行。

---

## C. Chat 嵌原生 Frame(用户点名要 port 回去)

### [x] C1. Chat-in-a-frame — 已 port (meired)。**真实 meired 浏览器验证 ✓** (发消息→ensureChatFrame 建"Chat"frame→面板渲染 listChat 历史+新消息+回复, 22 气泡, 无报错)
meired 现在把每条消息当**普通画布文字**散落 pin 上去(`pinMessage` / `note-text`);Canvex 改成钉在原生 Excalidraw frame 上的**可滚动 HTML 面板**。
- **源**:
  - `Canvex frontend/src/components/canvas/ChatFrameOverlay.tsx`(面板:锚定 frame 屏幕 rect、像图片一样 `scale(zoom)`、选中才滚内容否则转发滚轮给画布、缩放始终转发)。
  - `Canvex frontend/src/lib/canvas-chat-frame.ts`(`findChatFrame` / `CHAT_FRAME_MARKER` / `isChatNoteElement`)。
  - `Canvex frontend/src/hooks/use-canvas-pinning.ts`:`ensureChatFrame`(找或建 frame、清旧 note-text)、`resolveChatColumnAnchor` 改成锚到 **frame 右沿**、`computeColumnStartY(bandLeft,fallbackY)` 泛化、`packRowStartXRef`(整行 x 一次性 claim)。
  - `Canvex frontend/src/pages/canvex-workspace.tsx`:`chatMessages` 本地 state、scene 加载时 merge 历史、`handleChatSubmit` 调 `ensureChatFrame`、挂 `<ChatFrameOverlay tick={excalidrawTick}>`。
- **目标**:`meired .../CanvasWorkspacePage.tsx` + 同名 hook/lib/组件。
- **复杂度**:大(纯前端,但面广)。
- **重新耦合**:
  - 删掉 meired 的 `pinMessage` 调用路径(改走面板);保留 `excalidraw-wheel-forward` / `excalidraw-bounds` 复用。
  - ⚠️ **多租户聊天历史**:meired 的 `listChat` 带 org/user 作用域,merge 逻辑(历史 + live)照搬即可,但分页/鉴权按 meired 的接口。
  - 顺带把 C1 依赖的 **right-of-frame 生成图布局** + **packRowStartXRef** 一起带过去(它们是 frame 特性的连带项)。
  - 删 dead `pinMessage` + 关联常量(`NOTE_WIDTH/NOTE_FONT_SIZE/...`)—— 跟 Canvex 一样收尾。

---

## D. 大功能

### [x] ~~D1. Media Library~~ —— **不移植,meired 自带 Pattern 系统已覆盖**
用户告知:meired 本就有 **Pattern 系统**(自带的素材/产物库),浏览已生成图的需求已满足,不必把 Canvex 的 Media Library port 过去。Canvex 当初做 Media Library 是因为它没有 library 基建(单工作区精简版);meired 不缺这块。
👉 **结论**:不 port。

### [x] D2. Spatial-prompt 提示瓦片(image-edit) — 已 port (meired)。tsc/eslint/5 个新 spatial 单测 ✓;ImageEditBar 在真实 meired 渲染无报错;live 编辑出图未验(需 credit)
meired **没有**;Canvex 把"干净源图 + 空间提示"分离,arrows/shapes 不烧进源图而进提示瓦片。
- **源**:`Canvex frontend/src/lib/canvas-spatial-prompt.ts`(`buildSpatialPrompt`)、`use-image-edit` / `use-split` 的干净源处理、后端 image.py 的提示拼接。
- **目标**:meired 对应 lib + image-edit 路径。
- **复杂度**:中。计费不变(还是一次生成)。

### [x] D3. Split「框→区域」 — 已 port (meired)。后端 py_compile ✓ (region_clause 透传 split prompts + cutout LLM step);分割 tab 渲染 ✓;live split 未验(需 credit);split 原子退款逻辑未动
meired 有 cutout/split,但**没有**区域化这层(选框 → 区域坐标)。
- **源**:`Canvex frontend/src/hooks/use-split.ts` 的 `subjectRegionClause`、`canvas-spatial-prompt.ts`,后端 `image.py` 经 service→view→`create_split_jobs` 透传 region。
- **目标**:meired split 路径。
- **复杂度**:中。⚠️ **计费**:split 在 meired 有原子退款,region 只是多带个参数,别动退款逻辑。

---

## E. 本会话(2026-06-23, 分支 `feat/canvas-sse-streaming-i18n-ui` / commit `d65ae7d`)增强 —— 流式 + 交互 + 动画

> 这批是 SSE 切换、逐 token 打字机、ChatGPT 风 UI、GSAP 动画那一轮在 Canvex 上做的, meired `canvas` 产品线**全缺**(除特别注明)。
> 审计结论(7-agent 跨库对比, 2026-06-23): meired 在 **i18n / 64px 气泡字号 / shimmer** 上其实**已追平甚至更规范**, 真正的差距集中在下面这几项。
> **源**: Canvex `feat/canvas-sse-streaming-i18n-ui` 分支。**目标**: meired 同名/对应文件(workspace 页 `frontend/src/pages/dashboard/canvas/CanvasWorkspacePage.tsx`, chat 输入 `frontend/src/pages/dashboard/canvas/ChatOverlay.tsx`, chat 面板 `frontend/src/components/canvas/ChatFrameOverlay.tsx`)。

### [x] E1. 纯样式速赢(零 org/计费/library 耦合, trivial–small, 一次做完) —— 已 port (meired, 分支 `feat/fe-canvas-streaming-ui`)。tsc/eslint ✓;**真实浏览器验 ✓**(thinking-glow 环渲染 + `@property --thinking-angle` 注册 + reduced-motion;浮动按钮 `rounded-md`;发送键 ghost 无橙填充 + 有字时图标 `text-primary` 橙线条)。save-status 同形同高 / ChatFrame 去 "Thinking…" 文字属未触发态(纯 className 替换, 未单独验)。
> **`/code-review` 后续修正(meired 已修, 这 3 处 Canvex 源也有同样问题, 回头反向修 Canvex)**:
> 1. **发送键橙线条**: Canvex 用 `text-primary`(在 Canvex `--primary`=ember 故是橙); meired `--primary`=砖红 `#e33529`(primary→ember 只 scope 在 `.excalidraw`, ChatOverlay 是其同级 sibling), 直接抄会渲染成**红**。meired 改用 `text-ember`(#ff6825), 与 thinking-glow 环同色。⚠️ Canvex 在 meired 语境下若哪天 primary≠ember 也会踩, 但 Canvex 自身 primary=ember 暂无碍。
> 2. **reduced-motion 冻结弧**: `.thinking-glow::before` 在 reduced-motion 下只 `animation:none` 会冻成单边橙弧(conic 彗尾不对称, 不像 glow-breathe 对称可冻)。改成 `display:none`(与同块 `.canvas-shimmer-sweep` 同策略)。**Canvex 源同 bug, 待反向修**。
> 3. **mask 只有 -webkit-**: 加上无前缀标准 `mask:` shorthand 让标准 `mask-composite:exclude` 有 source(纯健壮性, 当前浏览器无变化)。**Canvex 源同, 待反向修**。
全是纯前端 className/CSS, 风险最低:
- **输入框 thinking 橙色光环**: 源 `index.css` L191–238(`.thinking-glow::before` conic-gradient + `@keyframes thinking-glow-rotate` + **顶层** `@property --thinking-angle` + reduced-motion 收口)、挂载 `components/canvas/ChatOverlay.tsx` L182–188(wrapper `cn("relative flex items-center rounded-xl", isStreaming && "thinking-glow")`)。→ meired `index.css`(`@property` 必须放**顶层**不能进 `@layer`)+ `pages/dashboard/canvas/ChatOverlay.tsx` L180 给 wrapper 补 `rounded-xl` + `isStreaming && "thinking-glow"`。meired 已有 `--ember` token。
- **浮动按钮(地图/回到最新)圆角方形**: 源 `canvex-workspace.tsx` L148 `FLOATING_BTN_BASE` 用 `rounded-md`。→ meired `CanvasWorkspacePage.tsx` L137 `rounded-full → rounded-md`。
- **保存状态块同形同高**: 源 `canvex-workspace.tsx` L1205(`rounded-md ... h-8 flex items-center`)。→ meired `CanvasWorkspacePage.tsx` L1115 `rounded-full → rounded-md`、`py-1 → h-8 flex items-center`(三者同形同高)。
- **ChatFrame 去 "Thinking…" 文字只留 spinner**: 源 `ChatFrameOverlay.tsx` L148–153(只 `<Loader2 animate-spin>`)。→ meired `components/canvas/ChatFrameOverlay.tsx` L122–127 删文字 span(顺手清掉那处**硬编码英文** "Thinking…")。
- **发送键去橙填充 + 有字时图标线条变橙**: 源 `ChatOverlay.tsx` L224 `variant="ghost"` 写死 + L233 `SendHorizontal cn("size-4", canSend && "text-primary")`。→ meired `ChatOverlay.tsx` L210 `variant` 改写死 `"ghost"`(现为 `canSend?"default":"ghost"` 实心橙底)+ L218 图标加 `canSend && "text-primary"`。两者是一个设计的两半, 一起改。

### [x] E2. Stop 按钮(流式中点击中止回复) —— 已 port (meired)。tsc/eslint ✓;`handleStopStream → streamAbortRef.current?.abort()` 接好 + `onStop` 传入 ChatOverlay + 按钮流式中切 `type=button`/`<Square>`/`aria-label=chat.stop` + `chat.stop` 加进 en/zh locale(无 i18next missingKey 警告)。**Stop 形态切换 + 真实中止需 live stream(credit)未验**。 —— small, 链路已就绪, 最划算
- **源**: `canvex-workspace.tsx` `handleStopStream = () => streamAbortRef.current?.abort()`(L866), 传 `onStop`(L1138); `ChatOverlay.tsx` L216–235 流式中按钮切 `type="button"` + `onClick={onStop}` + 渲染 `<Square>`。
- **目标**: meired `CanvasWorkspacePage.tsx` 新增 `handleStopStream`(meired **已有** `streamAbortRef` + `postChatStream(...,{signal})` 全链路, L260/812–814/844, 只差暴露给 UI)、`ChatOverlay.tsx` 加 `onStop` prop(现注释 L20–21 明写"先不加 Stop")。
- **计费**: SSE/流**不做内联 reserve**(图/视频走异步 job), Stop 中止流**不需回滚任何 credit**; 已 emit `tool_result` 的 job 由独立的 `sceneAbortRef` 轮询照常 pin/计费, 未到 `tool_result` 的 placeholder 由 finally 的 `markPlaceholdersFailed` 收口(已有)。recoupling 几乎为零。

### [x] E3. 逐 token 打字机(assistant_delta + 匀速吐字) —— 已 port (meired)。**保留 NDJSON 不切 SSE**(views.py 的 `for event in stream_canvas_agent: yield _ndjson_line(event)` 自动透传 assistant_delta, 零改)。后端: builder.py 加 `AIMessageChunk` import + `StreamEvent.ASSISTANT_DELTA` + `stream_mode=["updates","messages"]` + messages 分支(checkpoint_ns 子图过滤)。前端: types/api.ts 加 assistant_delta 联合成员;CanvasWorkspacePage 加 streamingText/streamFinalizing/streamDeltaIdRef/pendingAssistantRef/resetStream/handleStreamSettled + handler 的 start-reset/tool_call-段切/assistant_delta/deferred-assistant/**finally 改成 Canvex 守卫结构**(supersede);ChatFrameOverlay 加 StreamingBubble(rAF CPS=70/MAX_LAG=160)+ MessageBubble 改 {role,content,typing}。**验证**: tsc/eslint ✓;前端 295 单测 ✓;后端 builder+views 76 测 ✓(含新增 `test_streams_assistant_delta_tokens` 覆盖 token 累积/子图过滤/空文本跳过);log-format lint ✓;fresh dev server 干净启动无报错(之前的 "role of undefined" 是 stale-HMR 旧 chunk, 已用 fresh server 证伪)。**live 打字机效果需真实 LLM(credit)未验**;后端 builder.py 改动需 `docker compose restart web` 才在 live 进程生效(无热重载)。 —— 后端 small + 前端 medium
> ⚠️ **不依赖 SSE**: NDJSON 一样能载 `assistant_delta` 行。meired **保留 NDJSON 传输, 只新增 delta 帧**(不重写传输层、不重测鉴权)。SSE framing 切换本身**不 port**(见"刻意不 port")。
> ⚠️ 真·流式: LLM 边生成边把 token 流给后端 → 后端来一个 delta 立刻转一行, 不缓冲整段; "逐字"观感是**前端** `StreamingBubble` 把忽快忽慢的 delta 匀速渲染合成的, 不是后端逐字喂。
- **后端(small)**: 源 `builder.py` `stream_canvas_agent` L509 —— `stream_mode=["updates","messages"]`(L555)、`messages` 分支按 `AIMessageChunk` + `checkpoint_ns` 子图过滤后 yield `{"event":"assistant_delta","id","content"}`(L572–576)、`StreamEvent.ASSISTANT_DELTA`(L159)、import `AIMessageChunk`。→ meired `backend/apps/canvas/services/agent/builder.py`(现 L554 单 `stream_mode="updates"`, docstring 还写"故意不要 token 增量" —— 要改); 保持 meired 多带的 `org_id/scene_id/user_id` kwargs; `checkpoint_ns` 过滤直接照搬(否则 subagent token 漏进用户气泡)。
- **前端(medium)**: 源 workspace 状态机 `canvex-workspace.tsx` L1010–1042(`streamingText`/`streamFinalizing`/`streamDeltaIdRef`/`pendingAssistantRef`/`resetStream(commitPending)`/`handleStreamSettled`)、`ChatFrameOverlay.tsx` `StreamingBubble`(rAF 匀速 drip, CPS=70 / MAX_LAG=160, 追平+finalizing 调 `onSettled` 交棒)、`types/canvex.ts` L179 加 `assistant_delta` 成员。→ meired `CanvasWorkspacePage.tsx`(现 `assistant` case 直接 `setChatMessages` 整段贴, L940–953)、`components/canvas/ChatFrameOverlay.tsx`(加 `StreamingBubble` + props)、`types/api.ts` L541–545 给 `CanvasChatStreamEvent` 加 `assistant_delta`。
- **重新耦合**: meired `finally` 块结构与 Canvex 不同 —— 必须照搬 supersede 守卫(`if (streamAbortRef.current === abort)`)否则快速连发会 clobber; meired `MessageBubble` 是 `React.memo({message})`, port `StreamingBubble` 时要适配签名 + 补 `streamingText` 触发的滚动到底。不碰计费。
- **测试**: meired `backend/apps/canvas/tests/test_views.py` 的 `mock_stream` 序列要插入 `assistant_delta` 帧并更新断言(Content-Type 仍 `application/x-ndjson` 不变)。

### [x] E4. GSAP 生成图落地入场 —— 已 port (meired)。新建 `components/canvas/CanvasLandingOverlay.tsx`(逐字复制 Canvex, 依赖/helper 签名全一致: gsap ^3.14.2 / elementScreenRect / getAiChatImageUrl)+ 在 `CanvasWorkspacePage` 的 `CanvasGeneratingOverlay` 同级挂载(excalidrawApiRef + tick=excalidrawTick)。tsc/eslint ✓;**浏览器验**: 挂载无报错 + mount-seed 正确(已有 AI 图 0 spurious ghost)。**live GSAP 入场动画需真实生成(credit)未验** —— 但是已验证过的 Canvex 代码逐字搬。 —— small, 依赖全就绪, 近乎逐字复制
- **源**: `components/canvas/CanvasLandingOverlay.tsx`(整文件: `gsap.timeline().fromTo` scale+fade+drop + ember glow bloom, mount-seeded 只让**生成结果**动一次, `elementScreenRect` 定位, reduced-motion 跳过), 挂载在 `canvex-workspace.tsx`(与 GeneratingOverlay 同级)。
- **目标**: meired 新建同名组件 + 在 `CanvasWorkspacePage.tsx` 的 `CanvasGeneratingOverlay` 同级挂载(传 `excalidrawApiRef` + `tick`)。
- **依赖**: meired **全部就绪** —— `gsap ^3.14.2`(裸 `gsap.timeline`, 不需 `@gsap/react`)、`elementScreenRect`(`lib/excalidraw-bounds.ts`)、`getAiChatImageUrl`(`lib/excalidraw-custom-data.ts`, 签名一致)、ember token。纯展示不碰计费。

### [x] E5. (可选) framer-motion 入场 + shimmer 精修 —— 已 port (meired)。**不装 framer-motion**(STANDARDS §13 反对引重依赖, meired 刻意没装), 改用 CSS。shimmer 精修: index.css 改成 Canvex 克制值(sweep 30/0.42/70 + 2.6s, glow 0.28↔0.6 + 2.8s)。Minimap 入场: 新增 `canvas-pop-in` keyframe(scale 0.94→1 + fade, 0.18s, origin-bottom-left)+ reduced-motion 收口。**ImageEditBar 入场刻意跳过**: 其根带 inline `translate(-50%,0)` + useLayoutEffect 量测/visibility, CSS transform 动画会打架, 边际收益不值。tsc/eslint ✓;295 单测 ✓;computed-style 验 canvas-pop-in/refined-shimmer ✓(live toggle 因 preview 重启换源登出未验)。
- **framer 入场**(Minimap / ImageEditBar 浮现): 源 `canvex-workspace.tsx` L1183–1199(`AnimatePresence`+`motion.div`)、`ImageEditBar.tsx` L311(`motion.div`, `x:'-50%'` 替代 inline translate)。⚠️ meired **未装 framer-motion** —— 要么 `npm i framer-motion`, 要么用 meired `index.css` 已有的 `@keyframes`(如 `grow-in`)近似 scale+fade **避免引依赖**。价值中等。
- **shimmer 精修**(可选审美): meired `index.css` L506–534 已有同名 class(`canvas-shimmer-sweep` / `canvas-glow-breathe`), 只是参数是精修前版本; 把 4 个数值改成 Canvex 的"更宽 30/70 + 0.42 透明 + 2.6s/2.8s"即追平"更克制"观感。功能已等价, 非必须。

### 刻意**不** port(本会话)
- ~~**SSE framing 切换**~~ —— 用户零感知 + 要重测鉴权; 打字机不依赖它, meired **留 NDJSON 只加 delta 帧**(见 E3)。
- ~~**i18n 整套**(TS 模块化结构 / canvas 语言切换按钮 / localStorage key)~~ —— meired 已有**更规范**的等价物(JSON locale 的 `canvas` ns + 全局 `LanguageSwitcher`(canvas 侧栏已渲染)+ Excalidraw langCode + `LanguageDetector`)。只有 help/media 等**功能缺失**带的零碎 key 缺, 随对应功能走。
- ~~**64px 气泡字号**~~ —— meired `ChatFrameOverlay.tsx` L142 已是 `text-[64px]`, 无差异。
- ~~**sidebar 去橙 / ChatGPT 中性化 / 品牌行**~~ —— **用户 2026-06-23 拍板保持 meired 暖色**(dune/ember 与 landing/dashboard 一致); 且整文件不能替换(会抹掉 `CreditBadge`/返回 dashboard/路由选场景)。
- ~~**chat 绿/红状态色、徽标色**~~ —— meired 写死绿=成功/红=错误是刻意语义(`--primary`=品牌橙不适合表达 success/error)。
- (base64 源内联 / `canvas-media-url` / `MAX_UPLOAD_IMAGES` 已在 B1 + 查漏里覆盖, 同样不 port。)

### 落地顺序(E 批, 未开始)
E1(纯样式速赢)→ E2(Stop, 链路已就绪)→ E4(GSAP landing, 依赖就绪)→ E3(打字机, 工作量最大)→ E5(可选)。
每项落地后: meired 的 `tsc`/`eslint`/后端测试要过; 改 meired 前先按 `CLAUDE.md` 读对应 `STANDARDS.md`(前端项读 `frontend/STANDARDS.md`; E3 后端项另读 `backend/STANDARDS.md`)。live 出图/聊天联调等 provider 充值(现 `403 insufficient_user_quota`)。

---

## 建议顺序

A1 → A2(速赢,先把 meired 现存 bug 修了)→ C1(Chat frame,面最广)→ D2/D3(image-edit 增强)。(B1、D1 不 port。)

每项落地后:meired 的 `tsc`/`eslint`/后端测试要过;计费相关项额外验证额度路径没被绕过。
