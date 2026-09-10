---
name: amazon-listing-pack-sop
description: 用户要一整套 Amazon 上架图时用这条技能。常见说法有「做一套 Amazon 主图」「7 张套图」「Amazon listing 套图」「上架图包」「Amazon 7-pack」「listing image set」。并行生成标准的 7 张套图 —— 主图、信息图、另一角度、细节特写、两张场景图、尺寸对比 —— 七张共用同一张 img2img 源图, 所以每个角度里都是同一个产品。提示词故意留白, 让 img2img 自己决定这个产品该突出哪些细节(杯子就拍手柄, 挂画就拍背面挂钩, 地毯就拍底面纹理)。
allowed-tools: generate_image
authorized-tool-calls: 7
---

# amazon-listing-pack-sop

> **本文说明文字用中文, 但发给图像模型的 prompt 一律保持英文。**
> 预设生图模型是 gpt-image-2, 英文提示词的出图质量明显更稳 —— 而这条技能的全部价值
> 就在提示词质量上。下面表格里那 7 段、以及示例里 `prompt=` 的内容, 都不要翻译。

## 什么时候用

用户这一轮要的是**一整套互相配套的 Amazon 上架图**时匹配这条技能。常见说法:

- 「做一套 Amazon 主图 / 7 张套图 / listing 套图 / 上架图包」
- 「Amazon 7-pack / listing image set / product photography pack」
- 「出一套上架图」

**不要用在:**
- 单张图的请求 → 走 `image-prompt-sop`
- 没有「套 / 套图 / pack / set」字样的随口一句「画一张图」「来张图」——
  别把七张的流程强加在一个只想要一张的人身上
- 视频请求 → 不相干, 走 `generate_video`

## 前置检查: 必须有附件(硬门槛)

这条技能是图生图。**七个角度共用同一张源图**, 用户真实的产品才能贯穿整套 —— 这正是
「套图」这两个字的意义。没有共用源图的话, 每个角度都变成从一句泛泛的「这个产品」文生图,
结果就是七个互不相干的随机产品。用户抱怨的「牛头不对马嘴」说的就是这个失败模式。

派发任何 `generate_image` 之前, 先确认对话里有一条标着
`[Canvas attachments for this turn]` 的系统消息。**没有就必须拒绝**, 按用户的语言回:

- 中文: 「做这套图需要参考你的实际产品图。请先在 canvas 上选中一张产品图, 点右上
  『Send to chat』把它附上, 然后重新发指令, 我会按 7 个角度生成统一套图。」
- 英文: "I need your actual product as a reference to generate this set.
  Please select a product image on canvas, click 'Send to chat' to attach it,
  then re-send your request and I'll produce the 7-angle pack."

没有附件时**一次 `generate_image` 都不要调**。工具层对套图调用(任何带 `slot_index`
的调用)本来也会硬拒 —— 所以跳过这道前置检查的下场是七个调用全被工具层打回, 报错原文
照样是上面那句话。省掉这一轮往返, 提前拒。

## 七张图的模板(Amazon 通用, 不挑品类)

在**同一轮回复里并行**派发 7 个 `generate_image`。每个调用 `n=1`(一个角度出一张,
**不是** `n=4` 把同一句提示词批量跑四遍)。

下面的「角度」说的是**这一格该是什么样的镜头**, 但提示词是故意留白的。模型通过 img2img
看得见源图, 产品相关的细节由它自己定(比如第 4 格, 它会自己挑最有辨识度的地方: 杯子的
手柄、挂画背面的挂钩、地毯的底面、椅子的接榫)。你给方向, img2img 填具体内容。

| # | 角度 | 尺寸 | 提示词(留白的简短指令 —— 保持英文, 细节交给 img2img) |
|---|---|---|---|
| 1 | 主图-纯白背景 | `1:1` | Place this product centered on a pure white seamless studio background (RGB 255,255,255), product filling ~85% of the frame, soft even studio lighting, subtle soft contact shadow directly beneath the product. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Photorealistic, sharp focus. No added text, no watermark, no props. Keep any branding printed on the product itself. |
| 2 | 信息图-卖点标注 | `1:1` | Place this product on a subtle off-white / light gradient background. Add 3-5 thin arrows pointing at its most distinguishing features, each with a short, large, legible sans-serif label of one or two words. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Clean infographic style, photorealistic product. |
| 3 | 另一角度 | `1:1` | Render this product rotated roughly 90° from the reference view, or as a 3/4 view, revealing what the reference does not show. Same product as the reference — identical colors, materials and design; only the viewpoint changes. Neutral white balance, consistent color grading. White seamless background, even studio lighting, photorealistic, sharp focus. |
| 4 | 细节特写 | `1:1` | Macro close-up of this product's most distinguishing detail — texture, mechanism, stitching, joint or edge. Same product as the reference — identical color and material, just magnified. Neutral white balance, consistent color grading. Neutral background, bright even light, high detail, photorealistic. |
| 5 | 场景图-自然光 | `1:1` | Place this product in a natural in-use lifestyle setting that suits what it is. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Mid-day natural light, shallow depth of field, editorial mood, 35mm, photorealistic. |
| 6 | 场景图-暖光 | `1:1` | Place this product in an indoor evening setting under warm golden-hour light, cozy mood. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Shallow depth of field, 35mm, photorealistic. |
| 7 | 尺寸对比 | `1:1` | Show this product alongside a clear scale reference appropriate to its size — a common everyday object for small and mid-size items, a person or furniture for large ones. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Neutral interior background, daylight, 35mm, photorealistic. |

`size` 字段直接传比例字符串(跟前端 `IMAGE_EDIT_SIZES` 一致): `1:1` / `4:3` / `3:4` /
`3:2` / `2:3` / `16:9` / `9:16` / `21:9` / `9:21` / `auto`。canvas 的供应商(apimart)
原生收比例, **不要**传 `1024x1024` 这种像素串。

## 每个调用的提示词怎么拼

每句提示词是一条简短的 img2img **编辑指令**(通常一两句话)。**主体由附件提供**, 你
**永远不要**描述这个产品是什么(「modern canvas wall art」「ergonomic chair」
「ceramic mug」都不行)。每句提示词都以 `this product` / `Place this product` /
`Render this product` 开头, 指的就是那张附件。往里拼这几样:

1. **角度方向** —— 用上面表里的措辞, 尽量逐字照抄。那种留白是有意的: img2img 会从源图
   继承主体, 以及视觉上合适的细节。

2. **身份锁(每个调用都要)** —— 末尾追一句把产品身份钉在源图上:
   `same product as the reference — colors, materials and design identical`。
   七张读起来是**同一个产品**而不是七个近似品(经典的「拼凑感」), 靠的就是这一句。

   锁的是产品的**身份**, 不是它的**姿态**: 角度 / 场景 / 构图的指令已经说了要变什么,
   所以这句话要写成身份(「同样的颜色、材质、设计」), **绝不能**写成
   `identical image` —— 那会让 img2img 原样复述源图, 把换角度、换场景的指令全忽略掉。

3. **通用摄影锚点**:
   - 白底 / 影棚镜头(#1、#2、#3、#4、#7): `photorealistic, sharp focus, high detail`
     (这几张默认就是 50mm 等效, 不必每张都写焦段)
   - 场景镜头(#5、#6): `35mm, shallow depth of field, editorial mood`
   - **每张都要**: `neutral white balance, consistent color grading` —— 套图最常见的
     翻车不是单张不好看, 是七张的白平衡和对比度对不齐, 摆在一起一眼就散。

4. **该用的负向锚点**:
   - 白底那几张: `no text, no logo, no watermark`
   - 主图(#1)另外加 `no props`, 产品占画面约 85%, 纯白 RGB(255,255,255)
     —— Amazon 主图的合规要求
   - **不要**再写 `no extra fingers, no distorted hands` —— 那是 Stable Diffusion
     时代的习惯, 在 gpt-image 上作用有限, 而且提到 hands 反而可能招来手。#7 的比例
     参照物现在默认用常见物件, 本来就不该出现手。

**为什么提示词要短、要留白**: gpt-image / Seedream 这类 img2img **本来就看得见源图**。
你写得越细(「挂在客厅墙上, 沙发和绿植虚化在后面」), 就越是把品类假设焊死进去 —— 而
一旦假设跟源图对不上(源图是个杯子, 不是挂画), 模型要么忽略你的提示词随便出一张,
要么把源图扭曲成你描述的样子。两种都糟。提示词写短, 让 img2img 自己继承上下文。

## 调用的形状

**在同一轮回复里并行**派发全部调用。**每个调用都必须带 `image_urls`**
(`[Canvas attachments for this turn]` 里那个附件 URL)、**`label`**、**`slot_index`**:

- `slot_index`(从 0 开始)决定横向位置
- `label` 是这一格的永久标题(比如「1-主图-纯白背景」, 生成完之后一直留在图上方)
- `image_urls` 决定这是图生图而不是文生图

```
generate_image(prompt="<angle 1>", size="1:1", n=1, image_urls=[<attached>],
               label="1-主图-纯白背景", slot_index=0)
generate_image(prompt="<angle 2>", size="1:1", n=1, image_urls=[<attached>],
               label="2-信息图-卖点标注", slot_index=1)
generate_image(prompt="<angle 3>", size="1:1", n=1, image_urls=[<attached>],
               label="3-另一角度", slot_index=2)
generate_image(prompt="<angle 4>", size="1:1", n=1, image_urls=[<attached>],
               label="4-细节特写", slot_index=3)
generate_image(prompt="<angle 5>", size="1:1", n=1, image_urls=[<attached>],
               label="5-场景图-自然光", slot_index=4)
generate_image(prompt="<angle 6>", size="1:1", n=1, image_urls=[<attached>],
               label="6-场景图-暖光", slot_index=5)
generate_image(prompt="<angle 7>", size="1:1", n=1, image_urls=[<attached>],
               label="7-尺寸对比", slot_index=6)
```

系统提示词里那个「一轮最多两个工具调用」的上限**对这条技能不适用** —— 本文件
frontmatter 里的 `authorized-tool-calls: 7` 把它抬上去了。

### label 长度 —— 硬上限

每个 `label` **不得超过 12 个中文字 / 24 个 ASCII 字符**(含 `<序号>-` 前缀)。标签渲染
在占位框上方一条定宽的带子里, 超了会在视觉上溢进下一格。前端**故意不给标签换行** ——
换行会把整行往下推, 破坏套图的对齐。

合格: `1-主图-纯白背景`(7 字)、`5-场景图-自然光`(8 字)、`Lifestyle scene 2`(16 ASCII)。

太长就砍到只剩要点:
- ❌ `4-产品最有辨识度部位的特写细节`(15 字) → ✂ `4-细节特写`(5 字)
- ❌ `Detailed close-up of the most distinguishing part`(49) → ✂ `Detail close-up`(15)

用户明确要少于 7 张时(「3 张」「5 张」), 按这个优先级挑:
`1, 5, 2, 7, 3, 6, 4`(主图 → 场景 → 信息图 → 尺寸对比 → 另一角度 → 第二张场景 → 细节)。
`slot_index` 要重新编成连续的 0..N-1, 画布那一行才不会有空格。

## 不要这么做

- ❌ 在没有 `[Canvas attachments for this turn]` 的情况下调**任何**一个
  `generate_image` —— 提前拒。带 `slot_index` 的套图调用只要没有源图, 工具层会全部硬拒。
- ❌ 在提示词里描述产品主体(「modern canvas wall art」「ergonomic chair」
  「ceramic mug」)—— 主体由 img2img 源图携带, 在提示词里点名反而可能覆盖掉源图的真实形状。
- ❌ 写死那些**预设了品类**的细节 ——「挂在客厅墙上」「背面的锯齿挂钩」「旁边站个人
  作比例参照」。这些把挂画的假设焊进了本该同样适用于杯子 / 地毯 / 椅子 / 服装的提示词。
  让 img2img 按源图自己决定。
- ❌ 把这些调用串起来(等 #1 出完再调 #2)—— 它们互相独立, 同一条回复里一起派发。
- ❌ 有附件却忘了传 `image_urls` —— 那样每个角度都会是不同的产品, 「套图」就没意义了。
  (工具层有一层自动注入的兜底, 但那只是双保险, 别指望它。)
- ❌ 单个调用用 `n=4` —— 那给的是**同一个角度**的四个变体, 不是四个不同角度。
  每个角度都要有自己的调用。
- ❌ 提示词里放品牌名 / 商标(「Apple 风格的杯子」)—— 下游的侵权检查会把这一格判死。
- ❌ 对 #2 信息图承诺具体的文字内容(「标签上会写 16x24 inches」)—— 只描述版式,
  接受模型可能渲染出一堆看着像文字的乱码。用户在意标签内容的话可以要求重做。
- ❌ 用户没明确要求就生成不到 7 张。

## 调用示例

**用户:**〔通过「Send to chat」附上一张产品图〕「帮我做一套 Amazon 主图」

**Agent(单轮, 7 个并行 tool_call —— 每个都带 `image_urls`):**

```
generate_image(
  prompt="Place this product centered on a pure white seamless studio background (RGB 255,255,255), product filling ~85% of the frame, soft even studio lighting, subtle soft contact shadow directly beneath the product. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Photorealistic, sharp focus. No added text, no watermark, no props. Keep any branding printed on the product itself.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="1-主图-纯白背景", slot_index=0,
)
generate_image(
  prompt="Place this product on a subtle off-white / light gradient background. Add 3-5 thin arrows pointing at its most distinguishing features, each with a short, large, legible sans-serif label of one or two words. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Clean infographic style, photorealistic product.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="2-信息图-卖点标注", slot_index=1,
)
generate_image(
  prompt="Render this product rotated roughly 90° from the reference view, or as a 3/4 view, revealing what the reference does not show. Same product as the reference — identical colors, materials and design; only the viewpoint changes. Neutral white balance, consistent color grading. White seamless background, even studio lighting, photorealistic, sharp focus.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="3-另一角度", slot_index=2,
)
generate_image(
  prompt="Macro close-up of this product's most distinguishing detail — texture, mechanism, stitching, joint or edge. Same product as the reference — identical color and material, just magnified. Neutral white balance, consistent color grading. Neutral background, bright even light, high detail, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="4-细节特写", slot_index=3,
)
generate_image(
  prompt="Place this product in a natural in-use lifestyle setting that suits what it is. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Mid-day natural light, shallow depth of field, editorial mood, 35mm, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="5-场景图-自然光", slot_index=4,
)
generate_image(
  prompt="Place this product in an indoor evening setting under warm golden-hour light, cozy mood. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Shallow depth of field, 35mm, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="6-场景图-暖光", slot_index=5,
)
generate_image(
  prompt="Show this product alongside a clear scale reference appropriate to its size — a common everyday object for small and mid-size items, a person or furniture for large ones. Same product as the reference — colors, materials and design identical. Neutral white balance, consistent color grading. Neutral interior background, daylight, 35mm, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="7-尺寸对比", slot_index=6,
)
```

**Agent 的回复文字**: 「已开始生成 7 张套图(主图 · 信息图 · 另一角度 · 细节特写 ·
场景图×2 · 尺寸对比), 每张 15-30 秒, 会陆续出现在画布上。」

---

**用户(没有附件):**「做一套 Amazon 7 张主图」

**Agent(单轮, 不调任何工具 —— 前置检查拒掉):**

回复文字: 「做这套图需要参考你的实际产品图。请先在 canvas 上选中一张产品图, 点右上
『Send to chat』把它附上, 然后重新发指令, 我会按 7 个角度生成统一套图。」
