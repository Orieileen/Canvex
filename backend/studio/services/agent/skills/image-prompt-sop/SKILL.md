---
name: image-prompt-sop
description: 用户要在画布上生成、创建、画一张或可视化一个图像时用这条技能 —— 产品图、场景图、样机、营销视觉、概念图、插画、图标都算。这条技能负责把一句含糊的需求改写成高质量提示词, 并在调用 `generate_image` 之前定好尺寸和张数。
allowed-tools: generate_image
---

# image-prompt-sop

> **本文说明文字用中文, 但所有提示词片段和示例保持英文。**
> 下面那些 `soft diffused softbox light from upper-left`、`shot on 50mm f/2.0` 之类的
> 短语是给你**直接抄进提示词**的, 预设生图模型是 gpt-image-2, 英文提示词的出图质量
> 明显更稳。不要翻译它们。

## 什么时候用

用户这一轮要一个视觉素材、自然应该触发 `generate_image` 时匹配这条技能。常见说法:

- 「画一个 / 帮我画 / 生成 / 来张 / 给我做个 / 出张图」
- 「product photo / mockup / lifestyle shot / hero image / banner / concept art / illustration / icon」
- 「show me what X looks like」「visualize X」

**不要用在:** 用户要视频(走 `generate_video`)、用户要的是对现有图的点评(不需要调工具)、
或者需求含糊到连下面这套改写也只能靠猜 —— 那种情况先问**一个**澄清问题。

## 五步改写法

调 `generate_image` 之前, 在脑子里过一遍这五项, 把答案揉成**一整句密集的提示词**。
**不要**把这个拆解过程展示给用户 —— 直接拿写好的提示词调工具。

### 1. 主体 + 取景

先说**是什么**, 再说**怎么框**。

- 产品: 写具体, 不要写抽象。
  ✅ `a ceramic pour-over coffee dripper, matte black, 1-cup size`
  ❌ `coffee equipment`
- 取景: `close-up macro` / `three-quarter product shot` / `top-down flat lay` /
  `wide environmental shot` / `eye-level lifestyle scene`

### 2. 光线 + 氛围

**只挑一种**布光 + **一个**氛围词。不要堆形容词。

- 影棚: `soft diffused softbox light from upper-left` / `bright even daylight` /
  `dramatic single key light, deep shadows`
- 自然光: `golden hour side light` / `overcast diffused daylight` /
  `morning window light through sheer curtain`
- 氛围: `clean` / `warm` / `moody` / `airy` / `editorial` / `cozy`

### 3. 背景 + 承载面

电商上架图的默认是**纯白无缝背景**, 除非用户暗示了场景。

- 白底产品图: `pure white seamless background, subtle soft contact shadow beneath the product`
- 场景图: `on a [oak/marble/linen/concrete] surface, blurred [kitchen counter /
  living room / café] background, shallow depth of field`
- 户外: 把地点写具体 —— `Mediterranean garden patio`, 不要写 `outdoors`

**别写 `no shadow`。** 产品悬在纯白上、一点阴影都没有, 出来像抠图贴上去的。实测同一
张源图, `no shadow` 那版飘着, 换成接触阴影之后立刻像一张真实的产品照。Amazon 只要求
纯白背景, 从来没有禁止阴影。

### 4. 相机 + 渲染风格

提示词**结尾**放技术锚点, 把输出钉在「真实照片」还是「插画」还是「渲染」上。

- 照片: `photorealistic, sharp focus on product, high detail, 85mm f/1.8`
- 插画: `flat vector illustration, limited palette (terracotta / sage / cream),
  thick outlines, no gradients`
- 3D 渲染: `soft global illumination, subsurface scattering on translucent parts`
- 手绘: `loose pencil sketch on cream paper, single-weight line work, no shading`

焦段和光圈仍然有用(它们真的会改变景深和透视), 但**具体的机身型号**
(`shot on Canon EOS R5`)基本是 2023 年之前的习惯, 现在的模型多半直接忽略。写不写都行,
别指望它。

### 5. 负向锚点(只在需要时)

某种翻车方式明显可能发生时, 才追一句 `no X`。

- 包装上的文字: `no added text, no watermark, no typography`
  —— **不要写 `no logo`。** 卖家的产品上本来就印着自己的品牌, 那句会让模型把它抹掉。
  要保住的话再追 `keep any branding printed on the product itself`。
- 产品图: `no human hands holding the product`

**不要**再写 `no extra fingers, no distorted hands, no warped face` —— 那是
Stable Diffusion 时代的习惯, 在 gpt-image 上作用有限, 而且提到 hands / face 反而可能
把它们招进画面。

没有明显要防的就整段跳过 —— 空洞的负向词会干扰一部分供应商。

## 尺寸怎么选

`generate_image` 收的是**比例字符串**(canvas 的供应商原生收比例):
`1:1` / `4:3` / `3:4` / `3:2` / `2:3` / `16:9` / `9:16` / `21:9` / `9:21` / `auto`。

| 用途 | 尺寸 | 为什么 |
|---|---|---|
| 方形主视觉 / Amazon 主图 / Instagram 帖子 | `1:1` | 默认。拿不准就选它 |
| 竖版产品细节 / Pinterest / 手机开屏 | `2:3` | 竖向, 上下留给产品的空间更多 |
| 横版 banner / 页头 / 桌面壁纸 | `3:2` 或 `16:9` | 横向; 3:2 是照片经典比例, 16:9 更电影感 |
| 不确定 / 让供应商看源图自己定 | `auto` | 图生图时跟着源图比例 |

- 用户说「给 Amazon 用」→ `1:1`(Amazon 强制主图为方形)
- 用户说「做 banner / 页头 / 封面」→ `3:2` 或 `16:9`
- 用户说「做 story / reel / 竖版」→ `2:3` 或 `9:16`

## 张数(`n`)怎么选

| 情况 | n |
|---|---|
| 用户要的是一张具体的图, 心里有数 | 1 |
| 用户在试想法、比风格 | 2 |
| 用户在做发散探索, 想多看几个, 说了「几张」/「a few options」 | 4 |

**不要超过 4**(工具本身也会截断)。**不要**在一轮里串多个 `generate_image` 调用 ——
用 `n` 就行。系统提示词里的安全规则也会拦。

## 不要这么做

- ❌ 拿用户那句五个字的原话直接调 `generate_image`。永远先过一遍五步改写。
- ❌ 堆八个形容光线的词 —— 一种具体的布光胜过一堆行话。
- ❌ 「Beautiful, stunning, masterpiece, 8K, award-winning」这类填充词。
  2024 年之后训练的模型要么忽略它们, 要么被带偏到俗气的方向。
- ❌ 调工具之前先让用户确认改写后的提示词。直接调 —— 他看到结果之后再提修改。
- ❌ 在回复里说图「好了」「在这儿」—— 工具是异步的, 画布要等生成完才更新。
  说「已开始」「已入队」「15-30 秒后会出现」。

## 改写示例

**用户:**「画个咖啡杯」

```
generate_image(
  prompt="A single ceramic espresso cup, off-white glaze with a tiny chip on the rim, on a worn oak café counter, soft window light from the left, shallow depth of field, photorealistic, 50mm f/2.0, eye-level three-quarter view",
  size="1:1", n=1,
)
```

**用户:**「给我做一个亚马逊主图, 卖一个不锈钢搅拌器」

```
generate_image(
  prompt="A stainless steel hand whisk, mirror-polished wire loops, ergonomic black silicone handle, centered product shot, pure white seamless background, soft even studio light, subtle soft contact shadow beneath the product, photorealistic, sharp focus, high detail, no added text, no watermark, keep any branding printed on the product itself",
  size="1:1", n=1,
)
```

**用户:**「几张极简风格的家居 mockup, 横版用做 banner」

```
generate_image(
  prompt="Minimalist living room corner, a single linen-upholstered armchair beside a slim brass floor lamp, neutral plaster wall, light oak floor, morning daylight from an off-frame window, airy editorial mood, wide environmental shot, photorealistic, 35mm f/2.8",
  size="3:2", n=4,
)
```
