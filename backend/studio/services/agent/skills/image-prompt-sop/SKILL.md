---
name: image-prompt-sop
description: Use this skill whenever the user asks to generate, create, draw, or visualize an image on the canvas — including product photos, lifestyle scenes, mockups, marketing visuals, concept art, illustrations, or icons. The skill rewrites vague requests into high-quality prompts and picks the right size + count before calling `generate_image`.
allowed-tools: generate_image
---

# image-prompt-sop

## When to use

Match this skill on any user turn that asks for a visual asset and would
naturally trigger `generate_image`. Typical surface forms:

- "画一个 / 帮我画 / 生成 / 来张 / 给我做个 / 出张图"
- "product photo / mockup / lifestyle shot / hero image / banner / concept art / illustration / icon"
- "show me what X looks like" / "visualize X"

Do NOT use this skill when the user wants a video (route to `generate_video`),
when they want feedback on an existing image (no tool call needed), or when
their request is so ambiguous that even the rewrite below would guess at
intent — in that case ask ONE clarifying question first.

## The five-step rewrite

Before calling `generate_image`, mentally run through these five fields and
fold the answers into a single dense prompt string. Don't show the user the
breakdown — just call the tool with the finished prompt.

### 1. Subject + framing

Lead with **what** and **how it's framed**.

- Product: name it concretely ("a ceramic pour-over coffee dripper, matte
  black, 1-cup size") not abstractly ("coffee equipment").
- Framing: `close-up macro` / `three-quarter product shot` / `top-down flat
  lay` / `wide environmental shot` / `eye-level lifestyle scene`.

### 2. Lighting + mood

Pick ONE lighting setup and ONE mood word. Don't stack adjectives.

- Studio: `soft diffused softbox light from upper-left` / `bright even
  daylight, no shadow` / `dramatic single key light, deep shadows`.
- Natural: `golden hour side light` / `overcast diffused daylight` /
  `morning window light through sheer curtain`.
- Mood: `clean` / `warm` / `moody` / `airy` / `editorial` / `cozy`.

### 3. Background + surface

For e-commerce listings the default is **pure white seamless** unless the
user implies a scene.

- Pack shot: `pure white seamless background, no shadow`
- Lifestyle: `on a [oak/marble/linen/concrete] surface, blurred [kitchen
  counter / living room / café] background, shallow depth of field`
- Outdoor: name the locale concretely (`Mediterranean garden patio`, not
  `outdoors`).

### 4. Camera + render style

End the prompt with technical anchors that pin the output to "real photo"
vs "illustration" vs "render".

- Photo: `shot on Canon EOS R5, 85mm f/1.8, photorealistic, sharp focus on
  product, high detail`
- Illustration: `flat vector illustration, limited palette (terracotta /
  sage / cream), thick outlines, no gradients`
- 3D render: `octane render, soft global illumination, subsurface scattering
  on translucent parts`
- Sketch: `loose pencil sketch on cream paper, single-weight line work, no
  shading`

### 5. Negative anchors (only when needed)

Append explicit "no X" when a common failure mode is likely:

- People shots: `no extra fingers, no distorted hands, no warped face`
- Text on packaging: `no text, no logo, no watermark, no typography`
- Product packs: `no human hands holding the product`

Skip this section if nothing obvious applies — empty anchors confuse some
providers.

## Size selection

`generate_image` 收 aspect-ratio 字符串 (canvas provider 原生是 ratio):
`1:1` / `4:3` / `3:4` / `3:2` / `2:3` / `16:9` / `9:16` / `21:9` / `9:21` / `auto`。

| Intent | Size | Why |
|---|---|---|
| Square hero / Amazon main image / Instagram post | `1:1` | Default. Pick this if unsure. |
| Portrait product detail / Pinterest pin / mobile splash | `2:3` | Vertical, more product real estate top-to-bottom. |
| Landscape banner / hero header / desktop wallpaper | `3:2` 或 `16:9` | Horizontal; 3:2 photo-classic, 16:9 cinematic. |
| 不确定要哪个 / 让 provider 看源图自动选 | `auto` | image-to-image 时跟着源图比例。 |

If the user says "for Amazon" → `1:1` (Amazon enforces square mains).
If the user says "for a banner / header / cover" → `3:2` 或 `16:9`.
If the user says "for a story / reel / portrait" → `2:3` 或 `9:16`.

## Count (`n`) selection

| Situation | n |
|---|---|
| User wants a specific shot, knows what they want | 1 |
| User is exploring an idea, comparing styles | 2 |
| User is doing creative discovery, wants variety, said "a few options" / "几张" | 4 |

Never go above 4 (tool clamps anyway). Never chain multiple `generate_image`
calls in one turn — use `n` instead. The safety rules in the system prompt
enforce this.

## Anti-patterns

- ❌ Calling `generate_image` with the user's raw 5-word request. Always
  rewrite through the five steps first.
- ❌ Stacking 8 lighting adjectives — picks one specific setup beats a
  buzzword salad.
- ❌ "Beautiful, stunning, masterpiece, 8K, award-winning" filler. Models
  trained post-2024 ignore these or actively bias toward kitsch.
- ❌ Asking the user to confirm the rewritten prompt before calling. Just
  call the tool — they can ask for changes after seeing the result.
- ❌ Promising the image is "ready" or "here" in the reply — the tool is
  async, the canvas updates when generation finishes. Say "started" /
  "queued" / "should appear in 15–30 seconds".

## Example rewrites

**User:** "画个咖啡杯"
**Tool call:** `generate_image(prompt="A single ceramic espresso cup, off-white glaze with a tiny chip on the rim, on a worn oak café counter, soft window light from the left, shallow depth of field, photorealistic, shot on 50mm f/2.0, eye-level three-quarter view", size="1:1", n=1)`

**User:** "给我做一个亚马逊主图,卖一个不锈钢搅拌器"
**Tool call:** `generate_image(prompt="A stainless steel hand whisk, mirror-polished wire loops, ergonomic black silicone handle, centered product shot, pure white seamless background, soft even studio light, no shadow, photorealistic, sharp focus, high detail, no text, no logo, no watermark", size="1:1", n=1)`

**User:** "几张极简风格的家居 mockup, 横版用做 banner"
**Tool call:** `generate_image(prompt="Minimalist living room corner, a single linen-upholstered armchair beside a slim brass floor lamp, neutral plaster wall, light oak floor, morning daylight from an off-frame window, airy editorial mood, wide environmental shot, photorealistic, 35mm f/2.8", size="3:2", n=4)`
