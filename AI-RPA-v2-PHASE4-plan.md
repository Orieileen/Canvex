# AI-RPA v2 — Phase 4:Agent ↔ 扩展 编排(实施计划)

> 配套:[`AI-RPA-v2-TODO.md`](AI-RPA-v2-TODO.md)(总清单) · [`AI-RPA-v2-browser-extension-design.md`](AI-RPA-v2-browser-extension-design.md)(设计)
> Phases 1–3 已完成(CDP 执行器 / AXTree 快照+ref / 真实页面点选),都在 `extension/`,**未提交**。
> 本文是 Phase 4 动手前的计划,**基于对现有代码的实读**(5 路并行阅读 backend/frontend/extension),不是猜测。

## 0. Phase 4 是什么

让**聊天 Agent 在一次对话轮次里**借扩展驱动用户**自己的**浏览器完成录制:
开标签页 → 拍 AXTree 快照 → **起草步骤(引用 ref)** → 对**拿不准**的元素让用户点一下 → 生成步卡。
`author_robot` **不再开服务器端 Playwright 浏览器**,改成给扩展发指令。这是 v2 第一块碰 Django 的改动。

## 1. 已确认的架构(来自实读代码)

**关键事实 —— 工具可以「发事件 + 阻塞等结果」而不卡住 SSE。** `stream_canvas_agent`(`builder.py:666`)
把 langgraph 跑在一条**后台 pump 线程**上(`_pump`,`builder.py:756`,daemon),工具函数都在这条线程里执行;
`ctx.emit_*` 回调(`emit_browse_log/frame/flow_session`,`builder.py:739-754`)只是往一个 `queue.Queue`(`:726`)
**非阻塞 put**;WSGI 请求线程另跑一个 `while: frames.get(); yield` 循环把帧刷成 SSE(`views.py:345` `event_stream`,
带 `X-Accel-Buffering:no`)。所以:**工具发一帧后立即被另一条线程刷给客户端,工具随后阻塞轮询也不影响这一帧的送达**——
这正是 `browse` 已在用的机制(设计注释 `builder.py:717-725`)。→ **「发 ext-command → 阻塞等结果」通道架构上已被证明可行。**

**通道设计(不需要 WebSocket、不需要新轮询端点):**

```
Agent 工具(pump 线程)
  │ 1. ctx.emit_ext_command({command_id, op, ...})        ← 复用 chat SSE 帧队列
  ▼
SSE 帧 → 请求线程刷出 → 前端 handleChatSubmit 的 case "ext_command"
  │ 2. extension-bridge.ts 包装器 post({__canvexTo:"ext", payload:{type, command_id, ...}})
  ▼
canvas-bridge.js(内容脚本)→ background.js(Phase 1-3 的 canvex-snapshot/pick/ref-locator 处理器)
  │ 3. 执行(快照/点选/ref→定位),background 把结果推回 sender.tab
  ▼
canvas-bridge.js → window.postMessage {__canvexFrom:"ext", payload:{..., command_id}}
  │ 4. extension-bridge.ts 监听器按 command_id 对上 → canvas.service.postFlowExtResult(sceneId,{token,command_id,result})
  ▼
POST /scenes/<id>/flow/ext-result/  (新端点,token 鉴权)
  │ 5. 设置进程内 rendezvous:threading.Event + 结果槽,键 = (session_token, command_id)
  ▼
被阻塞的工具 event.wait() 返回 → 拿到结果 → 继续(转 ref→定位 / 追加步卡)
```

**鉴权**:所有 flow/* 端点是 `AllowAny` + 无 CSRF(`settings.py:111` 认证类为空),唯一边界是**每轮不可猜的
`session_token`**(`context.py:29`,经 `flow_session` SSE 帧下发)。新端点沿用同一 token-bearer 模型,并把
`command_id` 绑定到 token。

**单进程假设(load-bearing)**:rendezvous 存在进程内存(仿 `playwright_session._sessions`);只因为部署是
`runserver`(单进程多线程 ThreadedWSGIServer)pump 线程与 ext-result 请求线程共享内存才成立。多 worker(gunicorn
prefork)下结果 POST 可能落到别的进程 → 需换 Redis/DB 共享存储。**现在单进程,先用进程内;文档标注此限制。**
(`FlowPickView` 的 409 注释已有同款告警。)

## 2. Agent 循环形态(推荐:2 个工具,LLM 起草一次)

「Agent 起草步骤」本质是 LLM 对快照推理,不能在单个工具内部完成(工具不调主 LLM)。同时系统提示把**每轮工具数
限制在 2**(`builder.py:127`)、递归上限 25(`:235`)。因此推荐:

- **工具 A `browser_open_and_snapshot(url)`**:emit `ext_command{op:"open_snapshot", url}` → 阻塞等快照 →
  返回**精简的可交互元素清单**(ref+role+name,控制在 `TOOL_RESULT_MAX_CHARS=2000` 内;完整 AXTree 另经 emit 事件
  给前端展示)给 LLM。(1 次工具调用)
- **LLM 一次性起草整张步骤表**,每步标注 `ref`(有把握)或 `uncertain:true`(拿不准)。
- **工具 B `commit_robot_steps(steps)`**:遍历——有 `ref` 的 → emit `ref-locator` 命令阻塞拿到富定位;
  `uncertain` 的 → emit `pick{label}` 命令 → **阻塞等用户在自己页面点一下** → 拿到 `{locator, ref}`;
  组装最终步骤 → emit `robot_steps` 事件 → 前端生成步卡。(1 次工具调用;点选在工具内阻塞完成)

→ **正好 2 个工具/轮,点选内联在工具 B**,绕开工具数上限与递归上限。
(备选:单工具内用 sub-model 起草——仿 `_self_heal` 的 extract 模型;更复杂,v1 先不做。)

## 3. 分层改动清单

### 后端
- **`context.py`**:`CanvasAgentContext` 加 `emit_ext_command: Callable | None`(仿 `emit_flow_session`)。
- **新 rendezvous 模块**(如 `ext_rendezvous.py`):`register(token, command_id) -> Event`、`wait(token, command_id, deadline)`、
  `resolve(token, command_id, result)`、`abort(token)`;进程内 dict + `threading.Event` + 结果槽;带 deadline 与
  abort 感知。
- **`builder.py`**:`StreamEvent` 加 `EXT_COMMAND`、`ROBOT_STEPS`;`stream_canvas_agent` 里装 `_emit_ext_command`
  (仿 `:747`),`finally` 置空(`:905`)。
- **`robot_authoring.py`(重写)**:删掉 `get_or_create_session`/`_op_goto`/`_op_screenshot`/`keep_browser_session=True`/
  `emit_flow_session`(不再开服务器浏览器);实现工具 A + 工具 B,emit ext-command + 阻塞 rendezvous。**守卫**:
  `ctx.emit_ext_command is None`(invoke 非流式路径)→ 优雅拒绝;`CANVAS_RPA_ENABLED`;**扩展在线**信号(见下)。
- **`views.py` + `urls.py`**:`FlowExtResultView`(POST `scenes/<id>/flow/ext-result/`),token-bearer、409 `session_gone`、
  `resolve()` rendezvous。**绝不持久化**用户真实浏览器的截图/内容/密钥(仿 `FlowDriveView` live-only)。
- **心跳**:chat SSE **没有** keepalive(不像 `SceneRobotRunView` 的 `_sse_stream_with_keepalive`)。被阻塞的工具
  在等人点选(可能几十秒~几分钟)期间**每 ~10s emit 一个心跳帧**(browse_log 或专门的 comment),并设**上限等待 +
  检查 `aborted`**(客户端断开时 pump 线程别永久 park)。

### 前端
- **`types/canvex.ts`**:`CanvasChatStreamEvent` 加 `ext_command`、`robot_steps`(末尾 `never` 穷尽检查会**强制**加 case)。
- **`canvex-workspace.tsx`**:
  - `case "ext_command"`(克隆 `flow_session` case `:1461`):按 `op` 调 extension-bridge 包装器(snapshot/pick/ref-locator),
    **按 `command_id` 关联**,拿到结果 → `postFlowExtResult(sceneId,{token,command_id,result})`。
  - `case "robot_steps"`:**复用 `handlePick` 尾部**(`ensureRobotStepsFrame` → live-else-persisted 读现有步 →
    追加 → `setRobotSteps` + `persistRobotSteps` + `invalidateSavedRobot`),provenance `"guessed"`。
  - 把 Agent 的「请点 X」**label 展示出来**(toast/横幅)。`flowSession` 语义**改造/并行**成「扩展支持的编写会话」,
    以 `extAvailable` 为门。
- **`extension-bridge.ts`**:加 `sendSnapshot`/`startPick(label)`/`refLocator` 包装器(带 `command_id` post,监听
  `__canvexFrom:"ext"` 回复**按 command_id/epoch 对上**);补上目前被丢弃的 snapshot/pick/ref-locator 回复监听。
- **`canvas.service.ts`**:`postFlowExtResult(sceneId, {token, command_id, result})`。

### 扩展
- **`background.js`**:把 `command_id` 串进 `canvex-snapshot`/`canvex-pick-start`/`canvex-ref-locator` 处理器及其回复
  (它们已 fan-out 到 `sender.tab`);加 `canvex-open-tab`(为编写开+导航一个标签页并回传 `tabId`,或复用 `canvex-run`
  的 newTab);**记住 authoring tabId**,snapshot/pick 都 pin 到它(background 快照回复已带 `tabId`+`epoch`)。
- **`page-agent.js`**:无改动(snapshot/locatorForRef/elementToRef/startPick(label) 已就绪)。

### 「扩展在线」信号
Agent 需要知道扩展是否装了才能走这条路。前端 `detectExtension()` 已有;把它的结果随 chat 请求上报(如请求头或
首帧),`author_robot` 据此决定:在线 → 走扩展;不在线 → **拒绝并引导安装扩展**(不回退开服务器浏览器,因为那正是
撞反爬的老路)。

## 4. 坑与对策

| 坑 | 对策 |
|---|---|
| chat SSE 无 keepalive,等人点选会静默 → 反代 idle 超时 | 阻塞时每 ~10s emit 心跳帧 + 上限等待 + 查 `aborted` |
| `emit_*` 只在流式路径装,invoke 路径为 None | 工具里 null-check,非流式优雅拒绝 |
| 每轮 2 工具 + 递归 25 上限 | 2 工具设计,点选内联在工具 B |
| `TOOL_RESULT_MAX_CHARS=2000` 截断 | 快照/定位走 emit 事件,不走工具返回串 |
| postMessage 多命令并发、无序 | 一律按 `command_id` 关联回复 |
| snapshot→pick 要同一标签页 | pin authoring `tabId`(background 回复已带) |
| 单进程 rendezvous | 文档标注;多 worker 时换 Redis/DB |
| 真实浏览器截图/密钥敏感 | ext-result **不入库**;沿用 live-only + `_strip_inlined_secrets` |
| 「我在命令哪个标签页」 | pin tabId + 显式 user-armed 会话 + `extAvailable` 门 |

## 5. 验证策略
- **单元**:rendezvous register/wait/resolve/timeout/abort;`FlowExtResultView` 200/409/坏 token。
- **集成**:模拟 ext-result POST 能解阻一个被阻塞的工具;`emit_ext_command` 帧确实进 SSE。
- **前端**:`ext_command` → bridge → 结果 POST 往返(mock 扩展);`robot_steps` → 步卡(复用已验证的 handlePick 尾部)。
- **真机(用户在自己 Chrome)**:装扩展 → 说「给 google 做机器人」→ 看到开标签页、快照、Agent 起草、「请点搜索框」横幅、
  点选、步卡出现。**沙箱无法验(无用户 Chrome/住宅 IP)**——这是用户验收项。

## 6. 里程碑
- **M4.1 ✅ 完成 + 验证(2026-07-19)** 后端管道:`ext_rendezvous.py`(register/resolve/wait,带 timeout+abort+heartbeat+race-safe)
  + `context.emit_ext_command` + `builder` 装 `_emit_ext_command` + `StreamEvent.EXT_COMMAND`/`ROBOT_STEPS` + `FlowExtResultView`
  (`flow/ext-result/`,token+command_id bearer,不入库)+ urls 路由。**容器内 17/17 通过**(rendezvous race/timeout/abort/heartbeat/
  cleanup;端点 200 且真解阻/409 command_gone/400/404);`manage.py check` 干净。改动全在 backend,bind-mount 即时生效,无需重建镜像。
- **M4.2 ✅ 完成 + 验证(2026-07-19)** 扩展 `background.js`:`command_id` 串进 snapshot/ref-locator/pick 回复;新增 `canvex-open-tab`
  (开+导航返回 tabId);pick 按 `msg.tabId` pin 到编写标签页 + 激活它;**异步 pick 路由**——`pendingPick[authoringTabId]={command_id,canvasTabId}`
  记住是哪个 Canvas 页发起的,pick 稍后从编写标签页触发时把 `canvex-picked-saved` 送回那个 Canvas 页(而非编写页)并带上 command_id;
  用完清除;`forget()` 加清 `pendingPick`。**Node mock-chrome 驱动真实 background.js:17/17 通过**(open-tab / command_id 回显 / tab-pin /
  pick 路由到正确的 Canvas 页而非编写页 / pendingPick 清除 / popup 手动路径保持)。page-agent/popup 不动。
- **M4.3 ✅ 完成 + 验证(2026-07-19)** 前端:`types/canvex.ts` 加 `ext_command`/`robot_steps` 到 SSE 联合 + `RobotStep.ref`;
  `canvas.service.postFlowExtResult`(409/错误不抛,resolve false);`extension-bridge.ts` 加 `sendExtCommand`(按 command_id 关联回复,
  超时 resolve `{error}`);`canvex-workspace.tsx` 加 `relayExtCommand`(op→扩展消息映射 + postFlowExtResult,pick 长超时 + 展示
  「请点 X」toast)+ `case "ext_command"`(fire-and-forget,heartbeat 忽略)+ `case "robot_steps"`(复用 handlePick 持久化落步卡)
  + deps;`browseLog` 加 `extPickPrompt`(en+zh)。**tsc 0 错 + eslint 干净 + sendExtCommand 6/6(关联/清理/超时,真实转译模块)+
  Canvas 应用实测加载无 console 报错。**端到端(真机装扩展 + M4.4)留待 M4.5。
- **M4.4 ✅ 完成 + 验证(2026-07-19)** `robot_authoring.py` 整体重写:`browser_open_and_snapshot(url)`(开标签页+快照,返回精简
  交互元素 ref 列表)+ `commit_robot_steps(steps)`(有 ref 的走 ref_locator,uncertain 的发 pick 让用户点,组装 → emit `robot_steps`);
  `_ext_command` 助手(register→emit→wait,带 heartbeat + is_aborted);扩展在线门(`ctx.ext_available` false → 引导装扩展,**不**回退服务器浏览器)。
  `context.py` 加 `emit_robot_steps`/`ext_available`/`is_aborted`/`rpa_authoring`;`builder.py` 装 `_emit_robot_steps`+`is_aborted`、
  串 `ext_available`、换工具注册、重写 RPA 系统提示(2 工具);`views.py` 读 `ext_available` 传下去;前端 `postChatStream` 带 `ext_available`
  + 调用点传 `extAvailable`。**验证:manage.py check 干净;2 工具流程 behavioral 16/16**(拒绝路径 + open→snapshot 存 tab/epoch + ref→locator +
  uncertain→pick(带 label/tabId)+ robot_steps 三步正确 navigate/type-from-ref/click-from-pick + provenance);前端 tsc 0 错 + eslint 干净 + 应用重载无 console 报错。
- **M4.5** 端到端(用户真机验收):装扩展 → 说「给 X 做机器人」→ 开标签页 → Agent 起草 → 「请点搜索框」→ 点 → 步卡出现。**沙箱无法验,交给用户。**

### 跨层对抗审查(2026-07-19,代码完成后)—— 发现并修复 6 个真实缺陷
5 路边界审查 + 对抗验证(重点:每个里程碑都用同一作者写的双边 mock 测的,共享的错误假设能骗过所有 mock)。9 条确认(去重 6 个),**全部已修 + 复验**:
1. **[高] MV3 SW 驱逐丢失点选路由** —— `pendingPick` 是内存态 SW 全局,长时点选期间无保活 → 工作线程 ~30s 被驱逐 → 点击唤醒的新工作线程 pendingPick 为空 → 结果回不去。**修:镜像到 `chrome.storage.session`,canvex-picked 内存缺失时从中恢复。**
2. **[高] 浏览器内运行绕过写门** —— 「在我的浏览器运行」用可信 CDP 执行 submit/pay/delete 却不检查 allow_writes(服务器 runner 有门,扩展没有)。**修:allowWrites 串到 runInBrowser→runs;background 加 `isStateChanging`(照抄 robot_runner 的关键词)在 runStep 派发前拦截。**
3. **[中] Agent 点选后不解除 pick 模式** —— page-agent click 不 stopPick → 标签页卡死(所有点击被吞)、脏步、第二次点选横幅陈旧。**修(不回归 popup 连续录制):canvex-picked 里仅当 `pend.command_id`(Agent 点选)才 stopPick;storage.local 仅手动点选追加。**
4. **[中] Agent type 步密码明文入库** —— commit 发出的密码字段 text 进 scene.data(世界可读),_strip_inlined_secrets 只在保存时跑。**修:emit 时 isPassword 则 text 置空。**
5. **[低] 第二次点选横幅陈旧** —— startPick 已 picking 时早返回。**修:即使已 armed 也刷新 label + ensureChrome。**
6. **[低] 无 role 可点元素被漏** —— _compact_interactive 正则对空 role 行(div[onclick]/[tabindex]/无 href <a>)误抓引号名 → 丢掉真能点的 ref。**修:首 token 以 `"` 或 `[` 开头的行也保留。**
+ RobotStep.submit 补进 TS 类型。**正确驳回(未改)**:open_tab 30s==30s 超时相等(两边都能处理);flow_session 现在孤立(是 Live Browser 退役的预期结果,v1 端点保留无害)。
**验证:扩展 mock-chrome 14/14 + 后端 _compact_interactive/密码/submit + manage.py check + 2 工具流 16/16 + 前端 tsc/eslint/应用重载无报错。**

## 7. 决定(已拍板 ✅ 2026-07-19)
1. **Agent 循环形态 = 2 工具**(`browser_open_and_snapshot` → LLM 起草 → `commit_robot_steps` 内联点选)。主 LLM 起草,不引 sub-model。
2. **没装扩展时 = 拒绝 + 引导装扩展**(扩展-only 编写;`detectExtension` 为 false 就解释并引导 load 扩展)。**不**回退开 v1 服务器浏览器——那正是撞反爬的老路。
3. **心跳 = 工具阻塞时自发心跳帧**(每 ~10s 一帧 + 上限等待 + 查 `aborted`);不动共享的 chat transport。

→ 三项均按推荐锁定;计划可直接进入实施(M4.1 后端管道起步)。
