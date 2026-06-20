---
name: amazon-listing-pack-sop
description: Use this skill when the user asks for a multi-image Amazon listing pack — typical surface forms include "做一套 Amazon 主图", "7 张套图", "Amazon listing 套图", "上架图包", "Amazon 7-pack", "listing image set". Generates the canonical 7-image set in PARALLEL — main shot, infographic, alternate angle, detail close-up, two lifestyle scenes, and scale reference — all sharing ONE img2img source so the same product carries across every angle. Open-ended prompts let img2img decide product-specific details (cup → handle close-up, wall art → back hook, rug → underside texture).
allowed-tools: generate_image
authorized-tool-calls: 7
---

# amazon-listing-pack-sop

## When to use

Match this skill on any user turn that asks for a coordinated multi-image Amazon
listing set. Surface forms:

- "做一套 Amazon 主图 / 7 张套图 / listing 套图 / 上架图包"
- "Amazon 7-pack / listing image set / product photography pack"
- "出一套上架图"

Do NOT use:
- Single-image requests → route to `image-prompt-sop`
- Casual "画一张图" / "来张图" without "set / pack / 套图" wording — don't impose
  a 7-image flow on what the user wanted as one shot
- Video requests → unrelated, route to `generate_video`

## Preflight: ATTACHMENT REQUIRED (hard gate)

This skill is image-to-image. ALL 7 angles share ONE source image so the user's
actual product carries across the set — that is the entire point of a "pack".
Without a shared source, each angle is text-to-image from a generic "this
product" prompt and you get 7 unrelated random products. The user's complaint
"牛头不对马嘴" (results don't match the source) is exactly this failure mode.

Before dispatching any `generate_image` calls, check that a system message
labeled `[Canvas attachments for this turn]` is present in the conversation.
If it is NOT, you MUST refuse and reply (match the user's language):

- Chinese: "做这套图需要参考你的实际产品图。请先在 canvas 上选中一张产品图,点
  右上 'Send to chat' 把它附上,然后重新发指令,我会按 7 个角度生成统一套图。"
- English: "I need your actual product as a reference to generate this set.
  Please select a product image on canvas, click 'Send to chat' to attach it,
  then re-send your request and I'll produce the 7-angle pack."

DO NOT call `generate_image` even once in the no-attachment case. The tool also
hard-refuses pack calls (any call with `slot_index` set) that arrive without a
source — so ignoring this preflight gets all 7 calls rejected at the tool layer
with the error string spelled out anyway. Save the round-trip; refuse upfront.

## The 7-image template (Amazon canonical, product-class agnostic)

Dispatch 7 `generate_image` calls IN PARALLEL within the same assistant turn.
Each call has `n=1` (one distinct shot per angle, NOT n=4 batching the same prompt).

The angles describe **what kind of shot** each slot is — but the prompts are
deliberately open-ended. The model sees the source via img2img and decides the
product-specific details (e.g. for slot #4 it picks the most distinctive detail
itself: a cup's handle, a painting's back hook, a rug's underside texture, a
chair's joint). You provide direction; img2img fills in the specifics.

| # | Angle | Size | Prompt (open brief — keep it short, let img2img decide details) |
|---|---|---|---|
| 1 | 主图-纯白背景 | `1:1` | Place this product centered on a pure white seamless studio background (RGB 255,255,255), product filling ~85% of the frame, soft even studio lighting, no shadow. Same product as the reference — colors, materials and design identical. Photorealistic, sharp focus. No text, no logo, no watermark, no props. |
| 2 | 信息图-卖点标注 | `1:1` | Place this product on a subtle off-white / light gradient background. Add 3-5 thin arrows pointing at its most distinguishing features, each with a short, large, legible sans-serif label (1-2 words, layout only — don't rely on exact text rendering). Same product as the reference — colors, materials and design identical. Clean infographic style, photorealistic product. |
| 3 | 另一角度 | `1:1` | Render this product from a notably different angle than the main shot (≈90° rotation or 3/4 view), revealing aspects not visible head-on. Same product as the reference — identical colors, materials and design; only the viewpoint changes. White seamless background, even studio lighting, photorealistic, sharp focus. |
| 4 | 细节特写 | `1:1` | Macro close-up of this product's most distinguishing detail (model picks what best showcases craftsmanship — texture, mechanism, stitching, joint, edge, etc.). Same product as the reference — identical color and material, just magnified. Neutral background, bright even light, high detail, photorealistic. |
| 5 | 场景图-自然光 | `1:1` | Place this product in a natural in-use lifestyle setting appropriate for its category (model decides the setting from what the product is). Same product as the reference — colors, materials and design identical. Mid-day natural light, shallow depth of field, editorial mood, 35mm, photorealistic. |
| 6 | 场景图-暖光 | `1:1` | Place this product in a clearly different setting from the natural-light scene — a different room or style, not merely relit — under warm evening / golden-hour light, cozy mood. Same product as the reference — colors, materials and design identical. Shallow depth of field, 35mm, photorealistic. |
| 7 | 尺寸对比 | `1:1` | Show this product alongside a clear scale reference (model picks an appropriate one — a hand for small items, a person or furniture for large items, a common object for mid-size). Same product as the reference — colors, materials and design identical. Neutral interior background, daylight, 35mm, photorealistic. No extra fingers, no distorted hands. |

`size` 字段直接传比例字符串 (跟 frontend `IMAGE_EDIT_SIZES` 一致): `1:1` /
`4:3` / `3:4` / `3:2` / `2:3` / `16:9` / `9:16` / `21:9` / `9:21` / `auto`。
canvas provider (apimart) 原生收比例, 不要传 `1024x1024` 这种像素串。

## Per-call prompt construction

Each prompt is a short img2img EDIT INSTRUCTION (1-2 sentences typically). The
source attachment supplies the SUBJECT — you NEVER describe what the product IS
("modern canvas wall art", "ergonomic chair", "ceramic mug"). Every prompt
opens with "this product" / "Place this product" / "Render this product"
referring to the attached source. Fold in:

1. **The angle direction** from the table above (use the wording close to verbatim;
   the openness is intentional — img2img inherits the subject and visually
   appropriate details from the source).
2. **Identity-lock anchor (EVERY call)**: append a short clause pinning the
   product's identity to the source — `same product as the reference — colors,
   materials and design identical`. This is what keeps all 7 shots reading as
   ONE product instead of 7 near-misses (the classic "拼凑感"). Lock the
   product's *identity*, not its *pose*: the angle / scene / crop instruction
   already says what to vary, so phrase the anchor as identity ("same colors,
   materials, design"), NEVER as "identical image" — that can make img2img echo
   the source unchanged and ignore the re-angle / re-scene.
3. **Universal photo anchors**:
   - White / studio shots (#1, #2, #3, #4, #7): `photorealistic, sharp focus,
     high detail` (50mm-equivalent is implied for these — no need to spell out
     focal length on every shot)
   - Lifestyle shots (#5, #6): `35mm, shallow depth of field, editorial mood`
4. **Negative anchors when relevant**:
   - White-background shots: `no text, no logo, no watermark`
   - Main image (#1): also `no props`, product filling ~85% of the frame on
     pure white RGB(255,255,255) — Amazon main-image compliance
   - Shots with a person/hand (#7): `no extra fingers, no distorted hands`

**Why short open-ended prompts**: gpt-image / Seedream-style img2img already
sees the source. The more you over-prescribe ("hanging on a living room wall
with sofa and plants softly blurred"), the more you bake in assumptions about
product class — and if those assumptions don't match the source (the source is
a cup, not wall art), the model EITHER ignores your prompt and does something
random OR distorts the source to fit your prompt. Both bad. Keep the prompt
short and let img2img inherit the right context.

## Tool call shape

Within ONE assistant turn, dispatch all calls in parallel. **Each call MUST
pass `image_urls` (the attachment URL from `[Canvas attachments for this turn]`),
`label`, and `slot_index`** — `slot_index` (0-based) decides horizontal
position; `label` titles the slot permanently (e.g. "1-主图-纯白背景" stays
above the image after generation finishes); `image_urls` makes it img2img
instead of text-to-image.

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

The default 2-tool-call cap in the system prompt does NOT apply when this skill
is active — `authorized-tool-calls: 7` in this skill's frontmatter lifts it.

### Label length — HARD LIMIT

Each `label` MUST be **≤ 12 中文字 / 24 ASCII chars** total (including the
`<index>-` prefix). The label renders above the placeholder rectangle in a
fixed-width band on the canvas — anything longer overflows into the next slot
visually. The frontend does NOT word-wrap labels, by design (a wrap would push
the row down and break pack alignment).

OK: `1-主图-纯白背景` (7 chars), `5-场景图-自然光` (8 chars), `Lifestyle scene 2` (16 ASCII).

Too long → truncate to the essence:
- ❌ `4-产品最有辨识度部位的特写细节` (15 chars) → ✂ `4-细节特写` (5 chars)
- ❌ `Detailed close-up of the most distinguishing part` (49) → ✂ `Detail close-up` (15)

If user explicitly asks for fewer than 7 ("3 张" / "5 张"), pick subset in
priority order `1, 5, 2, 7, 3, 6, 4` (main → lifestyle → infographic → scale →
alt-angle → second lifestyle → detail). Renumber `slot_index` to be 0..N-1
contiguous so the canvas row stays gap-free.

## Anti-patterns

- ❌ Running ANY `generate_image` call without `[Canvas attachments for this
  turn]` present — refuse upfront. The tool will hard-reject every pack call
  with `slot_index` set if it lands without a source image.
- ❌ Describing the product subject in the prompt ("modern canvas wall art",
  "ergonomic chair", "ceramic mug") — the img2img source carries the subject;
  naming it in the prompt can override the source's actual shape.
- ❌ Over-prescribing details that assume a product class — "hanging on a
  living room wall", "sawtooth hook on the back", "human silhouette next to it
  for scale". These bake wall-art assumptions into prompts that should work for
  cups / rugs / chairs / apparel too. Let img2img decide based on source.
- ❌ Chaining the calls (waiting for #1 to finish before calling #2) — they're
  independent, dispatch all together in one assistant message.
- ❌ Forgetting `image_urls` when an attachment IS present — every angle would
  look like a different product, the "set" loses meaning. (Tool has an auto-
  inject fallback for this, but rely on it as belt-and-suspenders only.)
- ❌ Using `n=4` on a single call — that gives 4 variants of ONE angle, not 4
  distinct angles. Each angle needs its own call.
- ❌ Putting brand names / trademarks in any prompt ("Apple-style mug"). The
  downstream IP infringement check tombstones the listing.
- ❌ Promising specific text rendering in #2's infographic ("the label will say
  '16x24 inches'") — describe the layout, accept the model may render lorem-
  ipsum-ish text. User can request a re-do if labels matter.
- ❌ Generating fewer than 7 without explicit user request to do so.

## Example invocation

**User:** [attaches a product image via "Send to chat"] "帮我做一套 Amazon 主图"

**Agent (single turn, 7 parallel tool_calls — all pass `image_urls`):**

```
generate_image(
  prompt="Place this product centered on a pure white seamless studio background (RGB 255,255,255), product filling ~85% of the frame, soft even studio lighting, no shadow. Same product as the reference — colors, materials and design identical. Photorealistic, sharp focus. No text, no logo, no watermark, no props.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="1-主图-纯白背景", slot_index=0,
)
generate_image(
  prompt="Place this product on a subtle off-white / light gradient background. Add 3-5 thin arrows pointing at its most distinguishing features, each with a short, large, legible sans-serif label (1-2 words, layout only — don't rely on exact text rendering). Same product as the reference — colors, materials and design identical. Clean infographic style, photorealistic product.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="2-信息图-卖点标注", slot_index=1,
)
generate_image(
  prompt="Render this product from a notably different angle than the main shot (≈90° rotation or 3/4 view), revealing aspects not visible head-on. Same product as the reference — identical colors, materials and design; only the viewpoint changes. White seamless background, even studio lighting, photorealistic, sharp focus.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="3-另一角度", slot_index=2,
)
generate_image(
  prompt="Macro close-up of this product's most distinguishing detail (model picks what best showcases craftsmanship — texture, mechanism, stitching, joint, edge, etc.). Same product as the reference — identical color and material, just magnified. Neutral background, bright even light, high detail, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="4-细节特写", slot_index=3,
)
generate_image(
  prompt="Place this product in a natural in-use lifestyle setting appropriate for its category (model decides the setting from what the product is). Same product as the reference — colors, materials and design identical. Mid-day natural light, shallow depth of field, editorial mood, 35mm, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="5-场景图-自然光", slot_index=4,
)
generate_image(
  prompt="Place this product in a clearly different setting from the natural-light scene — a different room or style, not merely relit — under warm evening / golden-hour light, cozy mood. Same product as the reference — colors, materials and design identical. Shallow depth of field, 35mm, photorealistic.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="6-场景图-暖光", slot_index=5,
)
generate_image(
  prompt="Show this product alongside a clear scale reference (model picks an appropriate one — a hand for small items, a person or furniture for large items, a common object for mid-size). Same product as the reference — colors, materials and design identical. Neutral interior background, daylight, 35mm, photorealistic. No extra fingers, no distorted hands.",
  size="1:1", n=1,
  image_urls=["[attached URL]"],
  label="7-尺寸对比", slot_index=6,
)
```

**Agent reply text**: "已开始生成 7 张套图 (主图 · 信息图 · 另一角度 · 细节特写 · 场景图×2 · 尺寸对比), 每张 15-30 秒, 会陆续出现在画布上。"

**User (no attachment):** "做一套 Amazon 7 张主图"

**Agent (single turn, NO tool calls — preflight refuses):**

reply text: "做这套图需要参考你的实际产品图。请先在 canvas 上选中一张产品图,
点右上 'Send to chat' 把它附上,然后重新发指令,我会按 7 个角度生成统一套图。"
