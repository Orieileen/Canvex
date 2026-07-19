# Canvex RPA — 浏览器扩展(Stage 0 原型)

在**你自己的浏览器**里跑 RPA 机器人 —— 用你的**真实 IP、真实指纹、已有登录态**执行,从根上绕过
「IP 信誉 / 反爬指纹 / 登录态」三堵墙(见 [`../AI-RPA-v2-browser-extension-design.md`](../AI-RPA-v2-browser-extension-design.md))。

这是**第一步(Stage 0)**:独立最小扩展,**不接 Canvas、不改后端**,只为验证核心命题 ——
把那个在服务器端被 IP 拦掉的「Google 搜 iPhone 17」机器人,在你真实浏览器里跑出**真实结果**。

## 装(load unpacked)

1. Chrome 打开 `chrome://extensions`
2. 右上角开 **开发者模式 / Developer mode**
3. **加载已解压的扩展程序 / Load unpacked** → 选这个 `extension/` 目录
4. 工具栏出现 “Canvex RPA” 图标,点开就是弹窗

## 用

- **跑 Demo:Google 搜 iPhone 17** —— 一键跑 `navigate google → type「iPhone 17」→ 提交搜索`,
  在**当前标签页**执行。**在你自己的机器上应能落到真实 iPhone 17 结果页**(你的住宅 IP 不被 Google 拦)。
- **开始点选** —— 进入 pick 模式(页面顶部绿色横幅 + 十字高亮);在页面里点任意元素 → 记录成一个
  `click` 步骤(和服务器端 pick 一样的富定位)。点完在弹窗里看步骤列表。
- **运行已录步骤 / 清空** —— 跑/清你点选出来的步骤。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3;权限 `activeTab/scripting/tabs/storage/debugger`(原型期 host 用 `<all_urls>`,生产要按域名最小化) |
| `page-agent.js` | 注入真实页面的引擎:pick(`elementFromPoint`→富定位)+ `resolve`(富定位→元素)。**搬自 v1 的定位语义**,`css→role/name` 解析、visible 优先、歧义**绝不静默猜**(与服务器端一致)。`execStep`(合成事件回放)已被 CDP 可信执行取代,留作 DSL 语义说明/降级路径 |
| `background.js` | 编排中枢 + **CDP 可信执行器(Phase 1)**:`chrome.debugger` 发 `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`,页面收到 `isTrusted=true` 事件。分工:**解析/测量**走 `chrome.scripting`(免信任、拿视口 CSS px 中心 + `elementFromPoint` 遮挡命中测试),**派发**走 CDP。按步驱动、每步重注入、`navGate`(动作前布监听)跨导航前进 —— 运行状态住在 worker,不在页面 |
| `popup.html` / `popup.js` | 土 UI:跑 Demo / 点选 / 运行 / 步骤+日志 |

## 已验证(在真实 Google 页面上,通过 in-app 浏览器)

- pick:搜索框解析出 `{role:combobox, name:搜尋, css:#APjFqb, nth:0}` —— **与服务器端 pick 完全同形**。
- type:把「iPhone 17」写进搜索框 ✓;submit:跳到 `google.com/search?q=iPhone+17` ✓。
- 歧义安全:对 Google 两个 `input[name=btnK]` 的裸选择器,resolver **正确拒绝**(`ambiguous: 2 matches`)——
  这正是 v1「绝不静默 `.first`」的行为。真实使用里**点选**按钮会拿到唯一路径,click 就不歧义。

## ⚠️ 为什么这个沙箱里演示不出"真实结果"

本仓库所在沙箱里**所有**浏览器(docker 无头/有头、in-app 浏览器)都走**同一个被标记的出口 IP
`103.123.133.62`**,所以在这里跑 Demo 一样会吃 Google 的 “unusual traffic” 验证页。
**这恰恰是本扩展存在的意义** —— 它跑在**你的机器、你的住宅 IP** 上,而那个我在沙箱里无法模拟。
**你在自己的 Chrome 里 load 这个扩展、点 Demo,才能看到真实结果。**

## Stage 1(已做一半):Canvas → 你的浏览器"运行桥"

`canvas-bridge.js`(只在 Canvex 源注入的 content script)把 Canvas 页面 ↔ 扩展 background 打通
(用 `window.postMessage` 中继,**不用知道扩展 ID、不用改 Django**)。前端 `frontend/src/lib/extension-bridge.ts`
探测扩展 + 发机器人步骤;`RobotStepsOverlay` 上多了个蓝色 **「在我的浏览器运行」** 按钮(扩展在线时才显示)。
点它 → 扩展在**新标签页**用你的真实身份跑该机器人,每步状态回流到画布步卡。

**测试前必须**:①在 `chrome://extensions` 点本扩展的 🔄 **重新加载**(manifest 变了、content script 是新的);
② **刷新 Canvas 页面**(localhost:5199)让新前端 + 桥生效。然后在某个**有步卡的机器人**上就能看到蓝按钮。
(还没做:pick 回传画布、`Robot.executor` 双执行器开关、按域名授权 —— 见设计文档 §10。)

## Phase 1(CDP 可信输入)—— 请你在自己的 Chrome 上验收

执行从「content script 合成事件(`isTrusted=false`)」换成了 **`chrome.debugger` / CDP 可信输入(`isTrusted=true`)**——
这是把 RPA 搬进你真实浏览器后**行为反爬也识别不出**的关键。**代码 + 4 路对抗式审查已过,真机验收只能你来做**
(沙箱里没有你的 Chrome、没有你的住宅 IP)。

**跑 Demo 的步骤**
1. `chrome://extensions` → 本扩展 🔄 **重新加载**(manifest 加了 `debugger` 权限、background 全重写)。
2. 点扩展图标 → **跑 Demo:Google 搜 iPhone 17**。
3. **应看到**:①顶部出现黄条「Canvex RPA started debugging this browser」(可信输入的标志,正常);
   ②新/当前标签页导航到 google → 搜索框被输入「iPhone 17」→ 回车 → 落到**真实结果页**(你的住宅 IP);
   ③弹窗日志三步全 `ok`,末尾「完成」;④跑完黄条消失(每次运行结束自动 detach)。

**这次一起修掉的**(确认项):遮挡命中测试(consent 弹层挡住时不再静默误点、如实报 `occluded`)、
`navGate`(导航前布监听,多步机器人不会跑在旧 DOM 上)、mouseReleased `buttons:0`、空步卡兜底、
attach 失败不留孤儿标签、attach「夺回」+ attach/detach 竞态串行化、tab 关闭清理、日志写串行化。

## Phase 2(AXTree 快照 + `ref` 映射)—— Agent「看见」页面的方式

照搬 Claude in Chrome 的方法:给当前页拍一张**可访问性树快照**(role + 可访问名 + 缩进层级),每个可交互/结构
元素带一个临时 `ref_N`;Agent 读这棵精简树来起草步骤,拿不准时让你点某个 `ref`,我们把这个 `ref` 转成**与手工
点选同形的富定位**落进 DSL。**实现走 DOM a11y walk(不是 CDP `getFullAXTree`)**——因为 `ref → 富定位` 依赖
`locatorOf`,它活在内容脚本隔离世界,而 CDP 的 `backendNodeId` 在页面主世界,两边 `window.__canvex` 不通;DOM
walk 让「Agent 读到的树」与「我们落库的定位」由同一份代码算出。(CDP AX 树留作后续高保真替换。)

- `page-agent.js`:`snapshot()`(建树 + 重建 `ref→元素` 映射 `snapRefs`,靠幂等注入跨调用存活)、
  `locatorForRef(ref, epoch)`(转富定位;`epoch`/`tabId` 防跨标签或过期快照的 ref 张冠李戴)。地标只在**命名**
  (section/form)或**顶层**(header/footer)时才收;`aria-hidden` **子树**整体剪掉;`visibility:hidden`/`opacity:0`
  不算可见。
- `background.js`:`canvex-snapshot` / `canvex-ref-locator` 两个只读处理器(`chrome.scripting`,不碰 CDP/信任)。
- `popup.js`/`popup.html`:**拍快照 (AXTree)** 按钮 → 渲染这棵树,每个 `ref_N` 可点 → 显示它的富定位。

**验收(已在真机 Chromium 探针里过)**:realistic 页面快照里搜索框/按钮/链接都有 `ref_N`;任选 ref → 富定位
`{tag,role,name,css,nth,bbox,isPassword}`(与服务器端 pick 同形);隐藏元素不出现;命名地标显示、匿名 section
折叠;过期 epoch 的 ref 被拒。**在你自己浏览器里试**:reload 扩展 → 打开任意页 → 弹窗点「拍快照」→ 点树里某个
`ref` 看它转出的富定位。(尚未做:iframe/shadow DOM 穿透 —— 已知限制,后置。)

## Phase 3(在真实页面点选 + 绑回 `ref`)—— 录制的「你点这一下」

Agent 起草步骤时拿不准某个元素,就让**你在自己的页面上点一下**;我们把这一点**同时**转成富定位(落进 DSL)和
它对应的 AXTree `ref`(绑回 Agent 正在推理的那棵树)。

- `page-agent.js`:pick 的 `click` 现在回传 `{locator, ref, epoch}`;新增 `elementToRef(el)`(逆 `locatorForRef`:
  点到的元素 → 它的 `ref`,**只精确匹配 `actionable(el)`**,匹配不到就 `null` —— 不向上爬到 `main`/`nav` 地标误绑)。
  `startPick(label)` 支持顶部横幅显示「Agent 想让你点:X」。
- `background.js`:`canvex-pick-start` 透传 `label`;`canvex-picked` 把 `ref`+`provenance:"picked"` 写进步卡。
- `popup.js`:步卡显示 `[ref_N]` 徽标;点选后 locout 显示「已点选 ↔ ref_N → 富定位」。

**验收(已在真机 Chromium 探针里过)**:点搜索框 → `ref_5` + 富定位(与 pick 同形);点链接内部 `<span>` → 爬到
`<a>` 的 `ref_2`;点纯文本 div → `null`;`ref→locator→resolve→ref` 往返稳定。**在你自己浏览器里试**:拍快照 →
「开始点选」→ 点某个元素 → 看步卡里那一步带上 `[ref_N]`、locout 显示绑定关系。
