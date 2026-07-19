# AI-RPA v2:用户浏览器执行(扩展式执行器)设计文档

> 与 [`AI-RPA-v1-design.md`](AI-RPA-v1-design.md) 并列。v1 = 服务器端 Playwright 执行;
> 本文 = 在**用户自己的真实浏览器**里执行(装一个 Canvex 扩展,像 Claude in Chrome)。
> 二者**并存**,共用同一套 DSL、录制与模型。

## 0. 一句话

把机器人搬到**用户自己的浏览器**里跑 —— 用**真实 IP + 真实指纹 + 已有登录态**执行,从根上绕过
「IP 信誉 / 反爬指纹 / 登录态」三堵墙。画布从"画布内 live browser"退化成**编排台**;新增一个
`ExtensionExecutor`,与 v1 的服务器端执行器共用 `RobotStep` DSL 和 pick 引擎 —— 是**加执行器,不是重写**。

---

## 1. 动机:v1 服务器端执行器撞的三堵墙(已实测)

| 墙 | 现象(本仓库实测) | 根因 |
|---|---|---|
| **IP 信誉** | 「Google 搜 iPhone 17」机器人 3 步(navigate/type/click)**全 `ok`**,URL 到了 `google.com/search?q=iPhone+17`,但结果页是 **"unusual traffic … not a robot"** 验证页(IP `103.123.133.62`)。Amazon 直接白页。 | 服务器出口是**数据中心 IP**,被 Google/Amazon 标记。 |
| **反爬指纹** | 无头 UA=`HeadlessChrome` 被一眼识破;切**有头+Xvfb** 后 UA=正常 `Chrome`、Google 首页/搜索框能渲染,但搜索动作仍被 IP+行为拦。 | headless / TLS-JA3 / `navigator.webdriver`(Playwright 恒置 true)/ 行为特征。 |
| **登录态** | 服务器浏览器没有用户 cookie → 要 v1 的 **Drive/接管**手动过登录/验证码(§2.1/§3A)。 | 服务器是"陌生访客"。 |

**共同根因:服务器在用一个"假身份"浏览。** 在用户浏览器里执行,这三样**天然消失** —— 因为它
**就是用户本人在浏览**。附带红利:不再需要服务器端 Chromium / Xvfb / Docker 浏览器基建(v1 落地过程中
最脆弱、最难维护的一层)。

---

## 2. 核心洞察:DSL 与执行器本就解耦

- v1 的 `RobotStep`(`navigate|click|type` + 富定位 `role/name/text/css/nth/bbox`,见 v1 §4)**与"用哪个浏览器执行"无关**。
- 富定位靠 `elementFromPoint` / `querySelector` 解析 —— v1 那段 `_ELEMENT_FROM_POINT_JS`(`browser_primitives.py`)**本就是纯浏览器 JS**,搬进扩展的 content script 行为完全一致。
- 所以 v2 = 抽象出一个 **`RobotExecutor` 接口**,给它第二个实现:

```
interface RobotExecutor:
  resolve(x, y) -> RichLocator          # pick:活 DOM elementFromPoint → 富定位
  execute(step) -> StepResult           # navigate / click / type
  screenshot() -> jpeg                  # 监控帧
  snapshot() -> aria_text               # 自愈输入(v1 §7)
```

- **`PlaywrightExecutor`**(现有):`robot_runner._execute_step` + `_op_goto/_op_click_target/_op_type_target` + `_op_resolve_point/_op_screenshot` 收敛进来,**行为不变**。
- **`ExtensionExecutor`**(新):同样四个方法,在用户浏览器的 content script 里实现。

---

## 3. 架构:三层

```
┌─ Canvas 前端（编排台）──────────────┐   列/触发机器人、看运行状态+结果
│  不再是"画布内 live browser"          │   （运行事件仍走现有 StreamEvent 渲染）
└───────────────┬───────────────────┘
                │ REST（Robot CRUD）+ 运行事件流
┌───────────────┴───────────────────┐
│ Canvas 后端                         │   Robot/RobotRun 模型照用；两个执行器并存
│  ├ PlaywrightExecutor（云端，v1）    │   （混合调度，§9）
│  └ 经 WS 把 DSL 下发给扩展 ↔ 收事件   │
└───────────────┬───────────────────┘
                │ WebSocket（鉴权，DSL↓ / 事件↑）
┌───────────────┴───────────────────┐
│ Canvex 扩展（MV3，用户机器）─────────│
│  ├ background service worker（中枢） │   与后端 WS、chrome.tabs 导航、编排步骤
│  └ content script（真实页面内）      │   pick overlay + 富定位解析 + replay 输入
└────────────────────────────────────┘
```

`ExtensionExecutor` 的"浏览器"就是**用户真实的标签页**。

---

## 4. 传输:扩展 ↔ Canvas

| 选项 | 说明 | 取舍 |
|---|---|---|
| **(A) background ↔ 后端 WebSocket**（推荐） | 后端把机器人 DSL 逐步推给扩展 background,background 派给 content script 执行,结果沿 WS 回传。 | 跨机器通用(后端在云、扩展在用户机);机器人绑用户会话鉴权;运行事件复用现有 `StreamEvent {ROBOT_STEP, BROWSE_FRAME}` 形状,只是**方向从"后端产生"变成"扩展产生、后端转发给 Canvas 前端"**。 |
| (B) content script ↔ Canvas 前端 `window.postMessage` | 用户就在 Canvas 标签页时最直接。 | 机器人跑在**别的**标签页,仍需 background 中转;跨机器不成立。作 (A) 的补充,不作主路。 |

推荐 **(A)**:background service worker 作中枢,后端经 WS 下发 DSL(仿现有 `SceneRobotRunView`
的 `/robots/<id>/run/`,但**反向**:后端不再自己 `stream_robot_run`,而是把步骤发给扩展)。

---

## 5. 录制(pick)在真实页面 —— 比 v1 更简单

- 用户在**自己的标签页**点元素;content script 注入 pick overlay:高亮解析到的元素 + 十字光标 +
  常驻横幅("PICKING — 点击不会触发",复用 v1 §5.1 安全 chrome 语义)。
- **解析:直接搬 v1 的 `_ELEMENT_FROM_POINT_JS`** 进 content script → 同形状富定位
  `{tag, role, name, text, css, nth, bbox, isPassword}`。
- **坐标反投影(v1 §5.5 那套 letterbox 数学)不再需要** —— 点击发生在真实页面,直接
  `document.elementFromPoint(clientX, clientY)`。这是 v2 **净减复杂度**的一环。
- DOM 树微调(⬆父 / ⬇子沿祖先链重解析,v1 §5.2)照搬。
- pick 只回传**结构属性**(role/name/css),不回传页面原始文本/值(同 v1 §11 隐私约束)。

---

## 6. 回放(run)在真实页面

- content script 按 DSL 执行:
  - `navigate` → background `chrome.tabs.update(tabId, {url})`(navigate 前仍做 URL 合法性检查,但**不再需要 SSRF 出网防护**,§7);
  - `click` → 富定位解析元素 → `element.click()` / 派发事件;
  - `type` → focus + 逐字输入(`submit` → 回车)。
- **可信输入(trusted events)**:content script 的合成事件(`element.click()`、`dispatchEvent`)
  对多数站点够用,但 `isTrusted=false`,少数站点会拒。要真"硬件级"可信事件,可选
  **`chrome.debugger` 域发 `Input.dispatchMouseEvent/Key`**(真 `isTrusted`,但需 `debugger`
  权限 + 浏览器顶部黄条警告)。→ §11 待拍板。
- **截图**:content script 截不了任意标签页;监控帧走 background
  `chrome.tabs.captureVisibleTab`(**只能截当前可见标签页** → 运行时需把机器人标签页置前,或运行期不推实时帧、只推步骤状态)。
- **自愈**:content script 抓 `document.body` 的 aria/文本 snapshot 回传后端,复用 v1 §7 的
  LLM 重定位(约束照旧:capped、role/bbox 相似度校验、state-changing 步永不自动执行 healed)。
  v2.0 可先不上自愈,只回退到"暴露 miss + 请用户重点"。

---

## 7. 与 v1 的分工(复用矩阵)

| 组件 | v1(服务器端) | v2(扩展) |
|---|---|---|
| `RobotStep` DSL / `Robot`·`RobotRun` 模型 | 用 | **复用** |
| 富定位 + `_ELEMENT_FROM_POINT_JS` | `page.evaluate` | **同段 JS 搬进 content script** |
| 运行事件形状 `StreamEvent{ROBOT_STEP,BROWSE_FRAME}` | 后端产生 | **复用**(扩展产生 → 后端转发) |
| 执行 op | `_op_goto/_op_click_target/_op_type_target`(Playwright) | content script 等价实现(**新**) |
| 坐标反投影(v1 §5.5) | 需要 | **不需要**(真实页面 elementFromPoint) |
| SSRF `_host_blocked` / `is_public_http_url` | 需要(服务器出网) | **不需要** → 换成"按域名授权"(§8) |
| Xvfb / headless / `CANVAS_BROWSER_HEADLESS` | 需要 | **不需要** |
| 空闲回收 + `/flow/keepalive`(v1 §2.2) | 需要 | 换成标签页/连接生命周期 |
| 写门 `allow_writes` + `_is_state_changing` | 用 | **复用且更关键**(§8) |

**结论:难的部分(DSL、录制语义、富定位、自愈、写门、模型)全部复用;新增的只是"在 content script
里实现四个执行 op"+ 扩展骨架 + 传输桥。**

---

## 8. 安全与权限(扩展权重远高于 v1)

- 扩展能操作用户**已登录的会话**(邮箱/银行/内网)—— 比 v1 的陌生服务器浏览器**危险得多**,安全是 v2 的头等约束。
- **按域名最小授权**:扩展 `host_permissions` 按机器人涉及的域名**动态请求**,严禁 `<all_urls>`;
  运行前展示「本机器人将在 X、Y 域名上 点击/输入」并要用户确认。
- **写门复用且更关键**:`Robot.allow_writes` 默认关 + `_is_state_changing`(`robot_runner.py`,破坏性关键词表)照用;首个不可逆动作前**显式确认**。
- **密钥不进 DSL**(v1 §11 照搬):pick 到 `input[type=password]` 拒存文本 → 运行时变量 / 用户当场输入;type 密码字段永不进 `Robot.steps`/事件流。
- **扩展 ↔ 后端 WS 鉴权 + Origin 校验**:机器人绑用户会话的短命 token;防第三方页面/站点驱动你的扩展(等价 v1 §11 的"端点未认证"风险,在扩展侧重演)。
- **数据不外传**:pick/运行只回传结构属性与状态,不回传页面原始内容。

---

## 9. 最大代价:有人值守 vs 无人值守 → 混合双执行器

- 扩展执行**要求用户浏览器开着、机器开着** → **只能 attended**;**失去** v1 backlog(§12)里的
  "云端调度 / 无人值守"能力。这是本质权衡:
  - **云端(v1)**= 无人值守,但假身份 → 撞反爬;
  - **用户浏览器(v2)**= 真身份、过反爬,但要人/机在场。
- **推荐:两个执行器并存**。`Robot` 加一个偏好字段 `executor: server | extension | auto`:
  - 内部系统 / 无反爬 / 要定时 → `server`;
  - 有反爬 / 要登录态 / 想盯着看 → `extension`;
  - `auto`:先 `server` 试,**命中反爬特征**(unusual-traffic / challenge 页 / 空白页启发式)→ 提示用户切 `extension` 重跑。
- 影刀本身就是**桌面客户端 + 云端**双形态;这个混合正是往那个成熟形态收敛。

---

## 10. 构建顺序(v2)

1. **`RobotExecutor` 抽象** —— 把现 `robot_runner._execute_step` 收进 `PlaywrightExecutor`,定接口。纯后端重构、**不改行为**、v1 回归可测。`robot_runner.py`
2. **扩展骨架(MV3)** —— `manifest.json`、background service worker、content script 注入 + pick overlay(搬 `_ELEMENT_FROM_POINT_JS`)。先只做 pick,能在真实页面点出富定位。
3. **扩展 ↔ 后端 WS 桥 + 鉴权** —— 机器人绑用户会话;DSL↓ / 事件↑ 通道。`views.py`(WS/consumer)、扩展 background
4. **`ExtensionExecutor`** —— content script replay(navigate/click/type)+ 回传 `ROBOT_STEP` + 截图(captureVisibleTab)。执行器接口第二实现。
5. **`executor` 偏好 + 编排台 UI** —— `Robot.executor` 字段 + 迁移;Canvas 前端选执行器、看运行(复用现有运行事件渲染)。`models.py`、`migrations`、`canvex-workspace.tsx`
6. **安全硬门槛** —— 按域名授权 + 运行前确认 + `allow_writes` 复用 + 可信输入决策(合成事件 vs `chrome.debugger`)。
7. **`auto` 模式** —— server 撞反爬特征启发式 → 建议切 extension。

> 1–2 出"能在真实页面点选出富定位"的最小可见成果;3–4 出"真实浏览器里回放一个机器人";5 让两执行器可选;6–7 是上线安全门槛与体验闭环。

---

## 11. 开放问题 / 待拍板

- **传输**:WS(后端中枢、跨机器,推荐)vs 纯前端 `postMessage`(仅同页)。
- **可信输入**:content script 合成事件够不够?要不要上 `chrome.debugger`(真 `isTrusted`,但权限重 + 顶部黄条)?按站点分档?
- **截图/监控**:`captureVisibleTab` 只能截可见标签页 + 需 `activeTab` —— 运行时是否把机器人标签页置前?还是运行期只回步骤状态、不回实时帧?
- **多标签 / 多机器人并发**:一个扩展同时跑几个机器人如何隔离标签页与状态。
- **跨浏览器**:先 Chrome MV3;Firefox(WebExtensions)/ Safari 后续。
- **分发**:Chrome Web Store 审核(权限越少越易过)vs 企业内部 unpacked / 强制安装策略。
- **与 Claude-in-Chrome 类扩展共存**:同一浏览器多个自动化扩展的冲突与权限边界。

---

## 12. 一句话收尾

v2 不推翻 v1 —— 它**复用 v1 全部的 DSL / 录制 / 定位 / 模型 / 写门**,只把"执行"从云端假身份浏览器
换成用户真实浏览器,治好今天实测的 IP/指纹/登录三病;代价是从"无人值守"退成"有人值守",最优姿势是
**两个执行器并存、按站点/需求选**。
