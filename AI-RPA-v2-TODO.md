# AI-RPA v2(浏览器扩展)—— 构建 TODO

> 配套设计:[`AI-RPA-v2-browser-extension-design.md`](AI-RPA-v2-browser-extension-design.md) · v1:[`AI-RPA-v1-design.md`](AI-RPA-v1-design.md)
> 这是**动手清单**;为什么这么做看设计文档。全部在 `feat/canvas-rpa` 工作区,**未提交**。

## 锁定的架构决定(已与用户对齐)
- **控制方式 = CDP / `chrome.debugger`**(可信输入 `isTrusted=true`;接受顶部"正在调试"黄条)。
- **录制 + 运行都在用户真实浏览器**;服务器端 Live Browser(headed/Xvfb)**退役**,仅留作无人值守备用执行器。
- 触发:用户说"给 X 做机器人" → **Agent 经扩展在用户浏览器开新标签页到 X**(方案 a)。
- 录制方式:**Agent 起草步骤,只在拿不准时请用户点某个真实元素**(Agent 主导的混合式)。
- Agent "看页面" = **照搬 Claude in Chrome:AXTree 快照 + `ref_N`**;落进 DSL 时转成**我们的稳定富定位**(`role/name/text/css/nth`)。

---

## 现状盘点

**✅ 已有(可复用/参考)**
- Stage 0 扩展 `extension/`:`page-agent.js`(pick + replay 引擎,**content-script 版**)、`background.js`(跨导航编排:每步重注入 + 等 `complete`)、`popup.*`、`canvas-bridge.js`。用户已验证 Demo 在真实 IP 跑通。
- 运行桥(Canvas→扩展):`canvas-bridge.js` + `frontend/src/lib/extension-bridge.ts` + `RobotStepsOverlay` 蓝按钮 + `canvex-workspace` 接线。
- v1 服务器端:`author_robot`、`robot_runner`、`FlowPickView/DriveView`、富定位 resolver、`Robot/RobotRun` 模型 —— **DSL / 富定位 / 模型 / 写门全复用**。

**♻️ 要改**
- `page-agent.js` 的**执行部分**:content-script 合成事件 → **CDP 可信输入**。
- `background.js`:加 `chrome.debugger` attach/detach + CDP 封装。
- `author_robot`:不再开服务器浏览器,改为**发指令给扩展**。

**🗑️ 要废(录制不再走)**
- 在 Canvas Live Browser 里点选录制(服务器端浏览器)—— 正是它撞反爬。
- 运行桥里的 content-script 执行(被 CDP 执行取代)。

---

## 任务清单(按顺序)

### Phase 1 — CDP 执行器地基(重写执行,先做)✅ 代码完成 / 待用户真机验收
- [x] `manifest.json` 加 `"debugger"` 权限
- [x] background:`chrome.debugger.attach(tabId,"1.3")` / `.detach` 生命周期 + attach 失败/黄条处理 + 每标签一次 attach
  - 加固:attach「已附加」歧义 → detach 再 attach「夺回」,外部占用(DevTools/别的调试扩展)给可读报错;detach/re-attach 竞态用 `detaching` map 串行化;`onDetach` + `tabs.onRemoved` 兜底清 `runs/attached`
- [x] CDP 封装:`cdp()`(sendCommand+lastError 封装)、`cdpClick`(move→press→release,release `buttons:0`)、`cdpSelectAll`、`cdpEnter`;resolve/measure 仍走 `chrome.scripting`(免信任、直接拿 JSON)
- [x] 把 DSL 执行改成 CDP:
  - [x] `navigate` → `chrome.tabs.update` + `navGate`(比 `Page.navigate` 少一类边界;导航非信任敏感)
  - [x] `click` → 页面内 `resolve` 出**视口 CSS px 中心** + **elementFromPoint 遮挡命中测试** → `Input.dispatchMouseEvent`(可信)
  - [x] `type` → 可信 click 聚焦 + 全选 + `Input.insertText`(可信);`submit` → 可信 Enter
- [x] 保留「跨导航状态在 background、每步重注入 page-agent」的编排;并把「等页面就绪」升级成 `navGate`(**动作前**布监听,杜绝旧 `waitComplete` 抓到导航前的 `complete` 导致下一步跑在旧 DOM 上)
- [x] 经 4 路对抗式审查(cdp 正确性 / 生命周期 / 回归 / MV3),7 条确认 + 2 条低危已全部修掉(遮挡误点、release buttons、导航前 complete 竞态、空步卡兜底、孤儿标签、attach 夺回、attach/detach 竞态、日志写串行化、tab 关闭清理)
- **验收(待用户真机)**:load 后跑 Demo(navigate google → type iPhone 17 → submit),输入是可信事件(顶部出现「正在调试」黄条);在用户真实 IP 落到真实结果页。

### Phase 2 — AXTree 快照 + ref 映射(照 Claude in Chrome)✅ 代码完成 + 真机(Chromium)验证
- [x] **DOM a11y walk**(不是 CDP `getFullAXTree`)→ 精简成 role/name/ref 的缩进树。**为什么选 DOM walk 而非 CDP AX**:我们的验收要求是 `ref → 我们的富定位`,而 `locatorOf` 活在内容脚本隔离世界;CDP 的 `backendNodeId` 解析进的是页面**主世界**,`window.__canvex` 不在那里 → 得么主世界注入、么复制定位逻辑。DOM walk 复用 page-agent 现成的 role/name/locator,Agent 读到的树与我们落库的定位由**同一份代码**算出。(CDP getFullAXTree 留作后续高保真替换。)
- [x] `snapRefs` 映射(`ref_N → 元素`)每次 `snapshot()` 重建;闭包变量,靠 page-agent 幂等注入跨 executeScript 存活(与 Phase 1 resolvePoint 同机制)
- [x] 快照 → 给 Agent 读的**精简文本**(仿 `read_page` 的 YAML 缩进树);无趣包装节点折叠,缩进=可交互节点的嵌套深度
- [x] **`ref_N` → 稳定富定位**转换:`locatorForRef(ref, epoch)` 跑 `locatorOf`,与手工点选**同形**
- [x] page-agent 新增 `axName`(aria-labelledby/label[for] 解析)、`axRole`、`axLandmark`(命名 section/form + 顶层 header/footer 才算地标)、`axVisible`(排除 visibility:hidden/opacity:0);background `canvex-snapshot`/`canvex-ref-locator` 处理器;popup「拍快照」按钮 + 可点 ref → 富定位
- [x] 焦点对抗审查(1 agent)+ 真机 Chromium 探针验证,修掉:aria-hidden **子树**未剪、地标名用后代文本(噪音+烧 cap)、visibility:hidden 当可见、`epoch`+`tabId` 防跨标签/过期快照 ref 张冠李戴、tabId 解析移进 try 防挂起、exact-cap 假 truncated。跳过 D5(按 `!isVisible` 剪子树会误杀 `display:contents` 包装的可见子节点)
- **验收(已过,真机 Chromium 探针)**:realistic 页面快照里搜索框/按钮/链接都有 `ref_N`;任选 ref → 富定位 `{tag,role,name,css,nth,bbox,isPassword}`(与服务器端 pick 同形);aria-hidden/visibility:hidden 元素不出现;命名地标显示、匿名 section 折叠;过期 epoch 的 ref 被拒。

### Phase 3 — pick 在真实页面(录制的"你点这一下")✅ 代码完成 + 真机(Chromium)验证
- [x] pick 模式:高亮 + 捕获点击(复用 Phase 0 的 overlay);新增**带标签**(`startPick(label)`)—— 顶部横幅显示 Agent 想让你点什么(为 Phase 4「请点这个」铺路)
- [x] 点击 → 富定位 + **`elementToRef` 对应到 AXTree 的 ref**(逆 `locatorForRef`);`canvex-picked` 回传 `{locator, ref, epoch}`,`canvex-picked-saved` 同步给 popup;步卡带 `ref`+`provenance:"picked"`
- [x] **关键修**(真机探针抓到):`elementToRef` 原来会**向上爬到最近的快照祖先**,而 `main`/`nav` 是几乎所有元素的祖先 → 点非交互文本会错绑到 `main` 的 ref。改为**只精确匹配 `actionable(el)`**(locatorOf 描述的同一元素),匹配不到就 `null`。`actionable()` 本身已处理「点了交互控件内部的 span/icon」。
- **验收(已过,真机 Chromium 探针)**:点搜索框 → `ref_5` + 富定位 `{tag:input,role:textbox,css:"#q",nth:0}`(与 pick 同形);点链接内部 `<span>` → 爬到 `<a>` 的 `ref_2`;点纯文本 div → `null`;`ref→locator→resolve→elementToRef` 往返回到同一 ref(稳定)。pick 的 `chrome.runtime` 消息链与 Phase 0 已验证的一致,真机装扩展点选即可端到端。

### Phase 4 — 后端 Agent ↔ 扩展 编排(核心新增)📋 详细计划见 [`AI-RPA-v2-PHASE4-plan.md`](AI-RPA-v2-PHASE4-plan.md)
**通道已定(实读代码确认)**:工具在 pump 线程可「emit 一帧 + 阻塞等结果」不卡 SSE(browse 已证明)→ 复用 chat SSE 下发
`ext_command`,前端经 bridge 转扩展执行,结果 POST 到新 `FlowExtResultView` → 进程内 `threading.Event` rendezvous(键=token+command_id)解阻工具。**不需要 WebSocket / 不需要新轮询端点。**
- [ ] `author_robot` 改造:2 工具形态(`browser_open_and_snapshot` → LLM 起草 → `commit_robot_steps` 内联点选),不开服务器浏览器
- [ ] 后端:`emit_ext_command`(context/builder)+ rendezvous 模块 + `FlowExtResultView`(token 鉴权,不入库)+ 阻塞期心跳
- [ ] 前端:`ext_command`/`robot_steps` 两个 SSE case + extension-bridge 快照/点选包装器(按 command_id 关联)+ `postFlowExtResult` + 「请点 X」提示;`robot_steps` 复用 handlePick 尾部落步卡
- [ ] 扩展:command_id 串进 snapshot/pick/ref-locator 处理器 + open-tab + pin authoring tabId
- **验收**:聊天说"给 google 做机器人" → 用户浏览器开标签页 → Agent 起草 → 让你点搜索框 → 你点 → 画布出现步卡。

### Phase 5 — 运行(真实浏览器,CDP)
- [ ] 用 Phase 1 的 CDP 执行器跑保存的机器人步骤
- [ ] 状态回流画布(复用运行事件 + 蓝按钮,执行换成 CDP)
- [ ] (后置)自愈:AXTree 快照喂 Agent 重定位漂移的一步
- **验收**:保存的机器人一键在你浏览器跑完,状态回步卡。

### Phase 6 — 安全 / 权限
- [ ] 按域名授权:`host_permissions` 收紧(不用 `<all_urls>`)+ 运行前确认「将在 X 域名点击/输入」
- [ ] 写门 `allow_writes` + `_is_state_changing` 复用;首个不可逆动作前确认
- [ ] 密钥不进 DSL(password 字段拒存文本)
- [ ] debugger attach/detach 清理;多标签/多机器人隔离
- **验收**:运行前有域名确认;写操作被门挡住除非 allow_writes。

### Phase 7 — 双执行器 + 收尾
- [ ] `Robot.executor: server | extension | auto` 字段 + 迁移 + UI 开关(`auto`:server 撞反爬 → 提示切 extension)
- [ ] 更新设计文档 / README;打包 / Chrome Web Store(后置)

---

## 开放问题(建前/建中要定)
1. **后端 ↔ 扩展 通道**:现在是 WSGI `runserver`,上真 WebSocket 重。候选:① Canvas 页面中转 + 后端**长轮询/短轮询**一个新端点(轻,先用);② 上 ASGI/Channels WS(重,后期)。—— 倾向先 ①。
2. **AXTree 取法**:CDP `Accessibility.getFullAXTree` vs 自己 DOM a11y walk(可信度 vs 依赖)。
3. **快照时机 / `ref_N` 生命周期**:每次动作前重取?SPA 局部更新怎么办。
4. **多标签 / 多机器人并发**:一个 debugger 同时管几个标签的隔离。
5. **可信输入边界**:少数站点仍可能靠行为/节奏识别 —— 是否加人类化延迟。

## 里程碑
- **M1**(Phase 1–2):CDP 执行 + AXTree 快照跑通 —— "地基稳了"。
- **M2**(Phase 3–4):Agent 配合、真实页面录制出一个机器人 —— "录制搬进你的浏览器"。
- **M3**(Phase 5–6):运行 + 安全 —— "端到端可用"。
- **M4**(Phase 7):双执行器 + 上架。
