# AI-RPA(影刀式)v1 设计文档

> 自然语言 → 可复用的确定性步骤流程("机器人");用户在画布浏览器里**点选真实元素**告诉 AI 目标,而非纯靠文字描述。
>
> 本文档由一次多 Agent 工作流产出:4 个 Agent 钉死精确接入点(文件/符号/行号)、3 个 Agent 对抗性挑洞、1 个 Agent 合成。所有 `file:line` 引用来自对真实代码的勘察。

---

## 0. 一句话

AI 把你的意图**编译成一串带类型的步骤(DSL)**,由一个**可信解释器**逐步驱动已有的后端 Playwright。**跑机器人时不调 LLM**——模型只用于 (a) 编写 NL→DSL、(b) 定位失效时自愈。用户用**点选**给每步指定目标元素,得到的富定位既用于运行、也用于自愈。

---

## 1. 范式与目标

- **不是自主 agent**,是 **RPA 编写器**:一次编写、反复运行的确定性流程。
- **v1 = 有人看着跑(attended)**:一个浏览器,画面走已有的 browse-monitor 帧。
- **差异化(vs 传统影刀/录制回放)**:每个动作步的目标是**富定位** `{role, name, text, css, fallbacks[], bbox, description}`,由用户在**活 DOM** 上点选生成(`elementFromPoint`),同一份定位驱动**自愈**——页面改版时 AI 重新定位并修补,传统录制回放在这里就崩了。
- **底座已存在**:每步都是 `fn(page, *args)` 交给 `PlaywrightSession.call`(`playwright_session.py:135`)marshal 到 owner 线程执行。无需新解释器管道,只需新的 `_op_*` 函数 + 一个运行驱动。

---

## 2. ⚠️ 对抗验证推翻的三个 v1 假设(先看这个)

我们之前聊定的方案里,有三条被挑洞证明**在当前底座上不成立**,v1 设计据此已修正:

### 2.1 「接管登录/验证码」在 v1 底座上做不到 —— 这是最大的一条
页面是 **headless**(`browser.new_page`,`CANVAS_BROWSER_HEADLESS` 默认 True),而唯一的 client→server 通道是一个 `{x,y}` 跑 `elementFromPoint`——它**只解析节点、不分发输入**。真正的登录/验证码需要真实的鼠标移动/点击/键盘转发 + 低延迟实时画面。**一个"我来操作"按钮扣在纯截图的 headless 页上,看着能交互,实际什么都不会发生。**
→ 见 §3「需要你拍板」的登录 fork。

### 2.2 浏览器 session 会在 turn 结束时被销毁,撑不过人类思考时间
`close_session(id(ctx))` 在 pump 的 finally 里(`builder.py:839`),`agent.stream()` 一返回就触发。而 attended 编写需要 session **跨人类点击的思考时间**存活,且**没有 interrupt/resume**(`builder.py:12` 明确"No checkpointer",config 只有 `{recursion_limit:25}`)。所以"AI 起草步骤 → 等你点 → 继续"在原底座上**不可实现**。
→ **修正**:把 session 生命周期**从 graph turn 解耦**——`close_session` 移出 pump finally,给 `PlaywrightSession` 自己的 TTL + 一个显式 `POST /flow/session/close`,让拾取以独立请求打到一个能活过 turn 的 session。**不要绕 interrupt()**(它被刻意去掉了)。

### 2.3 「拾取不受截图延迟影响」—— 实际是反的(TOCTOU)
拾取准确性**恰恰依赖"显示的帧 == 活 DOM"**:用户点的是一张滞后的、缩小的 JPEG,`elementFromPoint(vx,vy)` 在**当前** DOM 上解析。若截图与解析之间页面动了(懒加载/横幅/动画/reflow),就绑到**另一个**元素,而且看着像对的。最糟的是拾取 op 排在某个 in-flight 步骤后面(owner 线程单串行队列)。
→ **修正**:①只在 op 队列空闲时接受拾取 + 拾取时冻结页面;②解析要**原子**——一个 op 同时跑 `elementFromPoint` + `page.screenshot` + 服务端画高亮框,一起返回;③每帧盖一个 **DOM-version nonce**,拾取 POST 回传,后端不匹配就 409 让重拾。

---

## 3. 🔨 需要你拍板的决定(我已给推荐)

| # | 决定 | 我的推荐 |
|---|---|---|
| **A. 登录/接管** ✅**已定** | v1 能不能登录?(§2.1) | **补最小输入分发**:加一个独立 `POST /flow/drive`,`page.mouse.click(vx,vy)` + `page.keyboard.type`。够简单表单登录(点框→输入→点登录),**不做 CDP**。验证码、丝滑实时交互、live-hover 留 v2。理由:完全砍掉登录 → v1 只能自动化全公开页面,对真实运营任务太受限;最小输入分发是有界的加法(2 个 op + 1 个端点)。 |
| **B. session 生命周期** | 允许浏览器活过 streaming turn 吗? | **允许**。显式 `/flow/session` 生命周期 + 为编写调高 `CANVAS_BROWSER_SESSION_IDLE_TIMEOUT`。纯机械修正,无争议。 |
| **C. 部署拓扑** | 单 worker 约束能接受吗? | **v1 接受**。`_sessions` 是进程内全局(`playwright_session.py:90`),prefork 下拾取 POST 可能落到别的 worker → 拾取全 409。把 flow-authoring 钉到单 web worker(专用路由)。真正的 browser-worker+IPC 是 v2。 |
| **D. 坐标契约** | 传 0..1 分数 还是 CSS-viewport px? | **CSS-viewport px**(`vx,vy`)+ 显式 `browser.new_page(viewport={1280,720})`,DPR 无关,viewport 通过 `flow_session` 事件下发。 |
| **E. 写操作门** | 机器人默认只读吗? | **默认只读**。你的核心场景本就是"爬取→写表"(只读)。写步骤(点 Pay/Delete/Submit)需要**每机器人的显式 allow-writes 能力** + 首次不可逆点击前确认。把现有 `CANVAS_BROWSER_OPERATOR_ALLOW_SUBMIT`(只管 Enter)扩到覆盖破坏性点击。 |
| **F. 凭证** | 登录机器人怎么存密钥? | **v1 不内联密钥**:登录走 takeover 步(现场输)或运行时从 `Robot.variables` 提示,**绝不**把密码写进 type 步的字面文本。持久凭证库仍是 v2。 |
| **G. 自愈回写** | 自愈成功后自动写回机器人吗? | **不自动**。人工确认成功运行后才回写,机器人在两次编辑间保持不可变。 |

> ✅ **全部已定**:A 选「补最小输入分发」(v1 能登录简单表单),B–G 按推荐。下文即最终方案,可直接照 §13 动手。

---

## 3.5 触发方式(编写 vs 运行)

**编写触发**:聊天里说一句("帮我做个自动导出订单的机器人")→ agent 调 `author_robot` 工具,**同时**:创建 token 键的**持久浏览器 session** + 在画布上开出「交互浏览器帧(pick)」+「步骤卡片帧」+ 起草步骤。之后的拾取(`/flow/pick`)、追加/纠正(继续发聊天)都挂在这个持久 session 上;「**保存为机器人**」按钮收尾(落 `Robot`、关 session;或空闲超时自动关)。
- **"进入编写" = 创建持久 session,"保存/超时" = 关闭**——即 §2.2/§3B 的 session 解耦两个边界;触发方式和 session 生命周期是同一件事。
- **teardown 修正**(实现注意):不能无条件把 `close_session` 移出 pump finally——普通 web_operator turn 仍要在 turn 末关(否则 Chromium 滞留到 idle-reap)。改为 pump finally **有条件跳过**:仅当本 turn 起了要保活的 authoring session(`ctx` 上一个 `keep_session_alive` 标志)时才不关,交给 `/flow/session/close` 或 idle-reap。
- **入口**:聊天优先 + 画布「＋新建机器人」按钮兜底(discoverability)。

**运行触发**:v1 每个已存机器人(= 一个步骤卡片帧 + `Robot` 行,按 scene 存)上「▶ 运行 / ✎ 编辑」→ POST `SceneRobotRunView` → `stream_robot_run`(确定性,不调 LLM),画面流进 monitor 帧。可选:聊天 `run_robot(name)` 工具。**定时/事件触发 = v2**。

---

## 4. 步骤 DSL(动作集 + 富定位 + 元数据)

动作集(持久化为 `Robot.steps` = 有序 JSON 列表,同 `Scene.data` 的 JSONField 形状):

```
navigate | click | type/fill | select | wait_for | extract/extract_table
| loop | takeover | save_download/export
```

每个动作步:

```jsonc
{
  "action": "click",
  "target": {                    // 富定位:拾取生成 + 自愈消费
    "role": "button",
    "name": "导出",
    "text": "导出",
    "css": "button.export-btn",
    "fallbacks": ["text=导出"],
    "bbox": [x, y, w, h],
    "description": "右上角的导出按钮",
    "nth": 0                      // 拾取时若 >1 命中,记录消歧索引
  },
  "provenance": "picked",        // guessed | picked | self-healed —— 步卡上显示置信度
  "kind": "read",                // read | state-changing —— 驱动写操作门(§3E)
  "precondition": { "wait_for": "..." }  // state-changing 步 / loop 体必须有
}
```

- `page.evaluate` 返回**JSON 序列化的节点属性**(不是句柄),正好是富定位形状。
- **运行时解析顺序**(净新增的 resolver,叠在 `_op_*` 之上):`css`(`page.locator`)→ `get_by_text` → `fallbacks[]` 依次;动作前断言 `locator.count()==1`(或 `nth`);为 0 或 >1 → 自愈/takeover,**绝不静默 `.first`**。今天的 `_resolve_locator`(`browser_primitives.py:103`)只按 ARIA role+name 解析,富字段是净新增。
- `Robot.variables` JSONField 存运行时提示的值(如凭证),**避免把密钥内联进 type 步字面文本**(§3F)。

---

## 5. 三模式交互帧 + 拾取数据流

### 5.1 三模式(同一个帧,复用 browse-monitor)
- **watch**:被动看(机器人在跑)。
- **pick**(编写默认):点 → 活 DOM 解析 → **不触发**元素。
- **drive**(§3A,显式"我来操作"切换):点 → **真触发**(简单表单登录)。**pick 与 drive 是两个独立后端端点**(`/flow/pick` 只解析、`/flow/drive` 才分发输入),**不用一个端点靠 client mode 区分**——否则一次 toggle race 就可能把"安全拾取"变成真点了"下单"。

模式 chrome 必须**醒目且默认安全**:全帧描边色 + 不同光标(pick 用十字、drive 用箭头)+ 常驻横幅("PICKING — 点击不会触发" vs "YOU ARE DRIVING — 点击是真的");默认 pick;drive 在导航/空闲/单次动作后**自动回退** pick。

### 5.2 拾取交互(v1,无实时 hover)
`点 → 活 DOM 上 elementFromPoint 解析 → 高亮解析到的元素 → 用户确认`。无 live-hover(那要 CDP,v2)。确认里显示解析到的 `role+name+text` + bbox 高亮,并给**DOM 树微调**("不对?⬆父 / ⬇子"**不重新点**就沿祖先链重解析)——挽救"抓到了包裹 div,我要的是里面的链接"这种粒度错。

### 5.3 图源修正(重要)
确定性 `PlaywrightSession` **今天没有截图 op**,`browse_frame` 目前**只**由另一个 browser-use 浏览器(`tools/browser.py`)喂。必须给确定性 session 加 `_op_screenshot(page)=page.screenshot()` 并经 `ctx.emit_browse_frame`(`builder.py:717`)发出,让**拾取截图和拾取解析来自同一个 page**。

### 5.4 跨请求关联(核心难点)
SSE 是单向的(`views.py` StreamingHttpResponse),拾取是**独立 POST** `scenes/<uuid:scene_id>/flow/pick/`。`id(ctx)` 不能当 key(内存地址、GC 复用、进程内)。方案:
1. 给 `CanvasAgentContext` 加 `session_token = uuid4().hex`(`context.py:19`);
2. `_sessions` 改**按 token 键**(`playwright_session.py:90/94/114`),加 `get_session(token) -> PlaywrightSession|None`;
3. turn 开始时发一个 `flow_session` SSE 事件 `{token, viewport:{w,h}}`;client 在拾取 POST 里回传 token。
4. 线程亲和让独立请求天然安全:`FlowPickView` 在外来请求线程上 `session.call(_op_pick, x, y)`,入队 owner 线程并阻塞,只是排在该 session 队列里 in-flight op 后面。
5. **多 worker 注意**:单 web worker 约束(§3C)。

### 5.5 坐标反投影(帧像素 → 页面 CSS 视口 px)
在 `BrowseMonitorPanel` 里(`rect/zoom/frame` 在作用域内)算:

```
sx = clientX - paneRect.left;  sy = clientY - paneRect.top
fx = (sx - rect.left) / zoom;  fy = (sy - rect.top) / zoom
s  = min(frame.width/Wimg, frame.height/Himg)
offX = (frame.width  - Wimg*s)/2;  offY = (frame.height - Himg*s)/2
ix = (fx - offX)/s;  iy = (fy - offY)/s        // 落在 letterbox 外则拒绝
vx = ix * (Wviewport/Wimg);  vy = iy * (Hviewport/Himg)   // 发送 (vx, vy)
```

`Wimg/Himg = img.naturalWidth/Height`(按 naturalWidth 归一同时消掉 DPR 与 1024px 缩放)。发 **CSS 视口 px**,`elementFromPoint` 与 deviceScaleFactor 无关。viewport 显式 `browser.new_page(viewport={1280,720}, device_scale_factor=1)` 并随 `flow_session` 下发,不在 client 硬编码。

---

## 6. 编写闭环

- **流程**:你说目标 → AI 从 NL + `body.aria_snapshot`(`_op_snapshot`,`browser_primitives.py:99`)起草步骤 → 拿不准的目标请你点 → 你拾取 → 目标填好 → 试跑 → 编辑/确认 → 存成命名机器人。
- **问不问的规则**(取代含糊的"unsure"):静默起草定位;**只在** resolver 命中 0 或 >1、或试跑该步失败时才请你拾取。恰好 1 命中的步静默猜,但打 `guessed` 徽章供你一键确认。**过度问 = "每个元素都要点",比录制回放还累,便利性反转;问太少 = 悄悄发一个坏定位。**
- **前向编写 / 边确认边执行**:某步目标一确认,**立刻确定性执行该步(不调 LLM)**让页面前进到下一元素存在的状态;每张步卡有"运行到此"回放 1..N-1 来铺垫再(重)拾取。这解决"整机器人试跑会在第一个未拾取步就死"的鸡生蛋。
- **DSL 侧通道**:编写 @tool 通过 `ctx.produced_dsl`(新字段,仿 `produced_assets` `context.py:33`)返回 DSL,**不走** tool 返回串(被 clamp 到 `TOOL_RESULT_MAX_CHARS=2000`,`builder.py`,会切碎富定位);`drain_new_robot_draft()` 发 `StreamEvent.ROBOT_DRAFT`。

---

## 7. 自愈

- LLM **只在运行时定位失效那步**被调,一步一次,绝非每步。唯一现存模型路径 `_get_extract_model`(`browser_primitives.py:48`)。
- **需要结构化 pass/fail**:**不要**复用 `_run_op` 的字符串扁平化路径(`browser_primitives.py:151-167`,它吞掉异常类型给 LLM 读)。解释器必须按抛出的异常分支(locator-miss vs timeout vs nav-error),所以直接 `session.call(op)` 看类型、或让 op 返回带类型结果。
- **安全约束**:自愈次数封顶(1–2);healed 候选必须过 role/name/text 相似度 + bbox 邻域校验,**拒绝改了 role 或落在授权 bbox 之外的**;区分 timeout("还没出现"→重试/等)与真 miss("漂移"→自愈)。喂给 healer 的页面文本是**攻击者可控的**——把自愈约束到该步自己的 `fallbacks[]` + 结构匹配,不做自由重解读。
- **state-changing 步永不自动执行 healed 定位**——暂停进 takeover/确认。若 `CANVAS_BROWSER_API_KEY` 未设,视为"自愈禁用 → 暴露 miss",不静默硬失败。healed 定位仅在人工确认成功后回写(§3G)。

---

## 8. 机器人持久化 + 无 LLM 运行模式

- **持久化 = 一等 Django 模型 `Robot`(+ `RobotRun`),不是 StoreBackend `/robots/` 路由**。store 默认 InMemoryStore(不透明 blob);命名、可列、可编辑、可运行的产品对象要用每个同类对象(`Scene/ChatMessage/ImageEditJob/VideoJob`)都用的模型形状。
  - `Robot`:`scene=FK(Scene)`, `name`, `steps=JSONField`, `variables=JSONField(default=dict)`, 时间戳, `db_table='canvas_robots'`。
  - `RobotRun`:仿 `ImageEditJob` 的 `Status` TextChoices + `error` TextField(`models.py:145-208`)。
  - 迁移 `studio/migrations/0003_*`。
- **运行模式 = 新服务函数** `stream_robot_run(robot_id, *, scene_id)`(新 `robot_runner.py`),**仿** `stream_canvas_agent` 的 pump→queue→SSE 骨架(`queue.Queue()`/sentinel/`aborted`/daemon `_pump`/外层 drain/finally teardown),但驱动**确定性解释器**`for i,step in enumerate(robot.steps): interpret_step(...)`,**不走** `agent.stream()`。
  - **绝不把机器人执行走 deep-agent**:tool-in-agent 每 turn 重调 LLM,且受 `AGENT_RECURSION_LIMIT=25`(`builder.py:222`)限——30 步机器人会撞顶。确定性解释器无此限。
  - `interpret_step` 按 `step.type` 分发到 `session.call(_op_goto|_op_click|_op_type|...)`;复用 `emit_browse_frame/emit_browse_log`(`context.py:42-50`)让现有 monitor/log 帧渲染运行中的机器人;加 `StreamEvent.ROBOT_STEP {index,status,locator}`。
  - 新 `SceneRobotRunView`(`POST scenes/<uuid:scene_id>/robots/<robot_id>/run/`)仿 `SceneChatView.post` 的 event_stream/`_sse_event`/StreamingHttpResponse/X-Accel-Buffering(`views.py:251-319`),跳过 ChatMessage 持久化。attended → SSE 请求内联执行,无 Celery。
  - **加运行级墙钟 deadline + 每步时间预算**(这条确定性路径没有 `_run_coro_blocking` 封顶);每步必须发帧保 SSE/proxy 连接热;限并发运行数(browse 信号量不覆盖此路径)。

---

## 9. 后端接入点(文件/符号)

| 类别 | 内容 |
|---|---|
| **复用** | `PlaywrightSession.call`(`playwright_session.py:135`)——唯一 op 入口,每步和拾取 op 都走它;`_nav_refusal`(`browser_primitives.py:170`)+ `is_public_http_url`(`common.py:121`)每个 navigate 前;`_op_goto/_op_click/_op_type/_op_read_text`(`browser_primitives.py:94-125`)作解释器分发目标。 |
| **新增** | `_op_resolve_point/_op_pick(page,x,y)`(挨着 `_op_goto`):`page.evaluate` 跑 elementFromPoint、上溯到可动作祖先、返回富定位 dict;`_op_screenshot(page)=page.screenshot()` 喂 `ctx.emit_browse_frame`(`builder.py:717`)。 |
| **扩展** | session key:`get_or_create_session(id(ctx))`(`browser_primitives.py:142`)改用 `runtime.context.session_token`;`close_session(id(ctx))`(`builder.py:839`)改 token 且**移出 pump finally**(§2.2);`_sessions:dict[str,...]` 重键 + `get_session(token)`;`_route_guard/_host_blocked` **DNS 解析域名 + fail CLOSED**(§11);`context.py` 加 `session_token` + `produced_dsl`;`builder.py` 加 `StreamEvent.FLOW_SESSION/ROBOT_DRAFT/ROBOT_STEP` + `drain_new_robot_draft()` + 在 tools 列表(`:423`)注册 `author_robot`(behind `settings.CANVAS_RPA_ENABLED`,提示段同块追加——agent 是缓存进程单例 `:387`,tool 不能运行时挂)。 |
| **新文件** | `tools/robot_authoring.py`(仿 `tools/browser.py` 的 browse @tool)、`robot_runner.py`、`models.py` Robot/RobotRun + 迁移、`views.py` FlowPickView + FlowDriveView + SceneRobotRunView、`urls.py` 路由 `flow/pick/`+`flow/drive/`+`robots/<id>/run/`。 |

---

## 10. 前端接入点(文件/符号)

- **扩展 `BrowseMonitorOverlay.tsx / BrowseMonitorPanel`(`:58`)**:`<img>`(`:97`)加 ref + `onClick` 拾取处理(算坐标、`stopPropagation`、`onPick`),`mode!=='watch'` 时启用;**保留**现有 `onPointerDown` stopPropagation(`:90`)防 Excalidraw 拖选;角标(`:93`)旁加 mode 切换 + "我来操作"。
- **扩展 `canvex-workspace.tsx`**:`browserMode` state(`~:360`);把 mode/onModeChange/onPick 传给 `<BrowseMonitorOverlay>`(`:1377`);加 `flow_session` SSE case,token 存 stream-local(仿 `browseMonitor.frameId` `:941-946`),finally 清(`:1192`);`handlePick` POST `(vx,vy)` 到 `/flow/pick`;`:1381` 后渲染 `<RobotStepsOverlay tick={excalidrawTick}/>`(overlay 必须依赖 `tick`,`:736`,才能在 pan/zoom 重投影)。
- **新 `RobotStepsOverlay.tsx`**(仿 `BrowseLogOverlay.tsx` 的 `BrowseLogPanel :67` + `useFrameAnchoredPanel :89`):可编辑步卡(typed DSL 的 input/select)取代只读行;保留外层 `onPointerDown` stopPropagation 让输入不平移画布;编辑改了 target 相关字段就标 `needs re-validate` 并**阻止存为命名机器人**直到重校验(一键"对活页重校验",无 LLM)。
- **新 `canvas-robot-steps-frame.ts`**(仿 `canvas-browse-log-frame.ts`):`ROBOT_STEPS_FRAME_MARKER`、`serializeRobotSteps/getRobotStepsData`(同守卫 JSON.parse)。
- **扩展 `use-canvas-pinning.ts`**:`ensureRobotStepsFrame`(仿 `ensureBrowseLogFrame :1114`)+ `persistRobotSteps=patchFrameCustomData`;**新帧必须经 `buildFrameElement` 设 `customData.aiChatType`**(`convertToExcalidrawElements` 会丢 customData;`getAiChatType` `excalidraw-custom-data.ts:14` 是唯一判别符)。
- **新 `canvas.service.ts`** `postFlowPick`(仿 `postChatStream :168-180`);**扩展 `excalidraw-bounds.ts` `elementScreenRect`(`:30`)** 加 §5.5 反投影。
- **i18n `canvas/browseLog.ts`**:加 `modeWatch/modePick/modeDrive/driveButton`(zh `driveButton='我来操作'`)。

---

## 11. 安全与健壮性(对抗验证折叠为设计决策)

| 严重度 | 风险 | 决策 |
|---|---|---|
| HIGH | **DNS-rebinding/redirect SSRF**:`is_public_http_url` 只在检查时解析一次,`_host_blocked` 只挡 IP 字面量且 **fail-open**,ALLOWLIST 默认空 → 域名解析到 169.254/10.x 可达云元数据 | `_route_guard` **DNS 解析域名 + 挡私网/环回/链路本地 + fail CLOSED**(`route.abort()` on 任何异常);解释器要求非空 `CANVAS_BROWSER_ALLOWLIST`;基础设施层锁出网 |
| HIGH | **拾取/drive 端点未认证**:仿 AllowAny 无 CSRF,token 走 SSE → 泄露者可操控已登录浏览器 + �slaught DOM | token 绑到 chat stream 同一 auth/session,当短命单 turn bearer、turn 末轮换;POST 强制 Origin/CSRF;只返结构属性(role/name/css),不返原始页面文本/值 |
| HIGH | **自愈重定向**:'删除本行' miss 后自愈到 '删除账户';页面文本可 prompt-注入 healer | §7 全部约束;state-changing 步永不自动执行 healed |
| HIGH | **点击无写门**:只 Enter 被 `CANVAS_BROWSER_OPERATOR_ALLOW_SUBMIT` 门(`:241`),`_op_click`(`:110`)裸奔 → 确定性运行可直接点 Pay/Delete | §3E:分类 read/state-changing;默认只读;每机器人 allow-writes + 首个不可逆点击前确认;写门扩到覆盖破坏性点击 |
| HIGH | **漂移页回放**:改版/重排后定位漂移,循环体('删第一行'×N)操作错内容 | 每个 state-changing 步 + 每个 loop 体前 `wait_for/assert` 前置条件;指纹 URL + 稳定结构锚,不符即 abort;dry-run 先解析全部目标 diff |
| HIGH | **密钥泄露**:drive 期间截图持久化(→ customData → scene.data autosave;→ DataAsset);type 步字面文本(密码/OTP)明文进 `Robot.steps` + SSE + 步卡 customData | `mode==drive/takeover` 时**全程禁截图**;拾取时检测 `input[type=password]`/`current-password` **拒绝存文本** → 强制 takeover 步或运行时变量;`ROBOT_DRAFT` 帧脱敏 type 步文本 |
| HIGH | **§2 的三条**(接管不可行 / 生命周期 / TOCTOU) | 见 §2 与 §3A/B |
| MED | **歧义 `.first` + 粒度错拾取** | 断言 `count()==1`(或 `nth`);确认显示 role+name+text + bbox + 父/子微调;持久化消歧锚 |
| MED | **无整体运行 deadline**:30 步 × 30s/op 可占死 gthread worker | 运行级墙钟 + 每步预算 + abort partial-failure + 限并发 |
| MED | **空闲回收 + proxy 超时**杀掉编写:owner 线程 300s 空闲回收(`settings.py:231`),无字节 SSE 撞 proxy read timeout | 定时发 SSE keepalive 注释;`session.call` keepalive-ping(<300s)或为编写调高超时;回收后**回放已确认步自动重铺**而非白页 |

---

## 12. v1 边界 + v2 backlog

**v1 IN**:NL→DSL 编写 @tool(behind `CANVAS_RPA_ENABLED`)、三模式交互帧(watch+pick+**最小 drive**,`/flow/drive` 输入分发,§3A 已定)、活 DOM 拾取、富定位 resolver + 自愈、`Robot/RobotRun` 模型、确定性 `stream_robot_run`、单 web worker 约束、默认只读 + 写门。

**v1 OUT**:CDP、live hover-highlight、调度/无人值守、browser-worker 队列、持久凭证库、代码沙箱/逃生舱、录制模式、复杂嵌套控制流。

**v2 backlog**:CDP 交互视图 + live hover;专用 browser-worker 进程 token/IPC 寻址(真正的多进程修复);调度/无人值守 + 队列;完整输入转发接管(验证码);多并发机器人(需脱离 scene-singleton 帧模型);凭证库集成;自愈定位自动回写。

> **v2 大方向:用户浏览器执行(扩展式)** —— 见 [`AI-RPA-v2-browser-extension-design.md`](AI-RPA-v2-browser-extension-design.md)。把执行从"云端假身份 Playwright"换成"用户真实浏览器里的 Canvex 扩展",用真实 IP+指纹+登录态从根上绕过反爬(本仓库已实测:服务器端有头+Xvfb 仍被 Google/Amazon 的 IP 信誉拦)。DSL/录制/定位/模型/写门全部复用,是加一个 `RobotExecutor` 实现;代价是退成 attended,故两执行器并存。

---

## 13. 构建顺序

1. **session-token 重键 + 生命周期解耦** —— 用 `session_token` 替 `id(ctx)`,`close_session` 移出 pump finally。跨请求拾取的地基。`context.py`, `playwright_session.py`, `browser_primitives.py`, `builder.py`
2. **确定性 session 的 pick + screenshot op** —— `_op_resolve_point/_op_pick`、`_op_screenshot` 喂 `emit_browse_frame`。`browser_primitives.py`, `playwright_session.py`, `builder.py`
3. **flow_session 事件 + FlowPickView + 路由** —— turn 起发 `flow_session {token,viewport}`;resolve-only 端点 + Origin/CSRF + token 认证;`get_session(token)`。`builder.py`, `playwright_session.py`, `views.py`, `urls.py`
4. **前端拾取通道 + 三模式帧 + 最小 drive** —— mode chrome + img onClick + 反投影 + `browserMode` + token 处理 + `postFlowPick`;后端 `FlowDriveView` + `_op_drive_click(page,vx,vy)`/`_op_drive_type(page,text)`(§3A 已定,drive 用于简单表单登录,复用同一坐标反投影)。`BrowseMonitorOverlay.tsx`, `canvex-workspace.tsx`, `canvas.service.ts`, `excalidraw-bounds.ts`, `i18n/browseLog.ts`, `views.py`, `urls.py`, `browser_primitives.py`
5. **NL→DSL 编写工具 + DSL 侧通道** —— `author_robot` @tool + `produced_dsl` + `drain_new_robot_draft`(绕 2000 字 clamp)。`tools/robot_authoring.py`, `context.py`, `builder.py`, `settings.py`
6. **步卡帧 + 可编辑 overlay + 持久化** —— robot-steps 帧模块、`RobotStepsOverlay`、`ensureRobotStepsFrame/persistRobotSteps`、needs-re-validate。`canvas-robot-steps-frame.ts`, `RobotStepsOverlay.tsx`, `use-canvas-pinning.ts`, `canvex-workspace.tsx`
7. **富定位 resolver + typed op 结果** —— `css→get_by_text→fallbacks[]` + `count()==1`,typed pass/fail 供自愈分支。`browser_primitives.py`
8. **Robot + RobotRun 模型 + 迁移** —— 一等模型 + CRUD/list 路由。`models.py`, `migrations/0003_robot.py`, `serializers.py`, `urls.py`
9. **确定性运行模式解释器** —— `robot_runner.stream_robot_run`(仿 pump/queue/SSE,无 agent.stream/无 recursion 限)+ `ROBOT_STEP` 帧 + `SceneRobotRunView`。`robot_runner.py`, `builder.py`, `views.py`, `urls.py`
10. **自愈 + 写门 + 前置条件 + 运行 deadline** —— capped/相似度校验/state-changing 不自动执行;read/write 分类 + allow-writes 门;`wait_for` 断言;墙钟 + 每步预算。`robot_runner.py`, `browser_primitives.py`, `settings.py`
11. **SSRF 加固 + 密钥抑制** —— `_route_guard` DNS 解析 + 挡私网 + fail closed;drive 期间禁截图 + 拒存密码字段文本。`playwright_session.py`, `common.py`, `browser_primitives.py`, `builder.py`

> 1–4 是能看到"点选拾取 + 简单登录"跑通的最小闭环;5–6 加上编写+步卡;7–9 让机器人能存能跑;10–11 是上线前的安全/健壮硬门槛。

---

## 14. 决定已全部锁定

A = 补最小输入分发(v1 能登录简单表单),B–G 按 §3 推荐。**方案定稿**,从 §13 第 1 步动手。
