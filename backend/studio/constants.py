"""Canvas 常量 — 从 meired apps/canvas/constants.py port。

Canvex 无计费体系:成本常量保留接口名但置 0(billing stub 的 cost_credits 恒算 0,
reserve() 因 cost<=0 短路返 None,全程免费),让 port 过来的代码零改动。
Prompt 常量原样保留(功能必需,split / cutout 两条路径靠它)。
"""

# Canvex 免费 → 成本恒 0(保留常量名,port 代码零改动;将来要计费只改这两个值 + billing.py)。
CANVAS_IMAGE_COST_PER_OUTPUT = 0
CANVAS_VIDEO_COST = 0


# Split "擦除主体、保留背景" 那条腿传给 image-edit provider 的 prompt。五条指令缺一不可:
# (1) remove subject(含阴影/反射)(2) inpaint 用周围像素续景 (3) 框外像素 pixel-identical
# (4) no hallucinated objects (5) seamless blending。第 3 条最关键 —— image-edit 模型默认会
# "顺手重渲染" 整图导致背景跟原图微移,拿来跟 cutout leg 合成时就露馅。系统级常量(前端不传)。
SPLIT_INPAINT_PROMPT = (
    "Identify the main subject/foreground object indicated by the user-drawn dashed bounding box. "
    "The dashed bounding box is a guide only and must NOT appear in the output.\n\n"
    "Remove the subject completely from the image, including any cast shadows, contact "
    "shadows, and reflections belonging to the subject. "
    "Inpaint the area where the subject was using context from immediately surrounding pixels — "
    "match texture, color, lighting direction, depth, and any repeating patterns from adjacent "
    "regions. The result should look like the subject was never there.\n\n"
    "Do NOT add, hallucinate, or introduce any new objects, decorations, people, or text into "
    "the filled area. Do NOT fill the area with flat color, pure white, or an 'empty' "
    "background — continue the existing scene naturally.\n\n"
    "CRITICAL — all pixels outside the subject region must remain PIXEL-IDENTICAL to the input. "
    "Only the area where the subject and its shadows/reflections were may change; everything "
    "else stays exactly as-is. Do NOT re-render, re-color, sharpen, denoise, brighten, "
    "stylize, retouch, or 'clean up' untouched regions of the image. Preserve all background "
    "details, viewing angle, depth, vanishing lines, lighting, and textures exactly.\n\n"
    "Edges of the filled area must blend seamlessly with the surrounding background. "
    "Output must have identical dimensions to the input — do NOT crop or pad. "
    "The final image must contain only the background with no trace of the removed subject."
)


# LLM 抠图 prompt。覆盖两种 cutout 场景: (a) split 的 cutout leg —— source 上有虚线框指示主体;
# (b) 独立 cutout —— 无框,抠最显眼主体。关键: 提取前景主体 / 虚线框是指示但不能进输出 /
# 背景纯白(LLM 普遍不出 alpha,用纯白替透明,stage 2 rembg 把白底转 alpha)。
CUTOUT_LLM_PROMPT = (
    "Extract the main foreground subject from this image as a clean product cutout.\n\n"
    "If the image contains a user-drawn dashed bounding box, treat it as a hint indicating "
    "which subject to extract — but the dashed bounding box itself must NOT appear in the output. "
    "If no bounding box is present, extract the single most visually prominent foreground subject.\n\n"
    "Output ONLY the extracted subject against a pure white background (#FFFFFF). "
    "Remove all other elements completely: original background, surrounding scenery, shadows, "
    "reflections, hands, props, watermarks, and any user-drawn guide marks.\n\n"
    "Preserve the subject's original colors, texture, proportions, and fine details exactly. "
    "Do NOT crop, rotate, resize, or restyle the subject. "
    "Do NOT add new objects, decorations, lighting effects, or text. "
    "The subject must have crisp clean edges as if professionally masked."
)
