"""视频拍摄脚本生成逻辑，从 views.py 中抽离。"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from typing import Any

from PIL import Image

from .tools import _resolve_image_bytes, openai_client_for_media

logger = logging.getLogger(__name__)

_DURATION_HINT_RE = re.compile(r"(?P<value>\d{1,3})\s*(?:s|sec|secs|second|seconds|秒)", re.IGNORECASE)


def _read_positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
        if value > 0:
            return value
    except Exception:
        pass
    return default


def _read_video_default_seconds() -> int:
    raw = os.getenv("MEDIA_OPENAI_VIDEO_SECONDS_DEFAULT", "12")
    try:
        value = int(str(raw).strip())
    except Exception:
        value = 12
    return max(1, min(300, value))


def _extract_duration_seconds_from_text(text: str) -> int | None:
    if not text:
        return None
    match = _DURATION_HINT_RE.search(text)
    if not match:
        return None
    try:
        value = int(match.group("value"))
    except Exception:
        return None
    if value <= 0:
        return None
    return min(300, value)


def resolve_video_duration_seconds(payload: Any, prompt: str) -> tuple[int, str]:
    raw_duration = None
    if payload is not None and hasattr(payload, "get"):
        try:
            raw_duration = payload.get("duration")
        except Exception:
            raw_duration = None
    if raw_duration is not None and str(raw_duration).strip() != "":
        try:
            value = int(str(raw_duration).strip())
            if value > 0:
                return min(300, value), "request"
        except Exception:
            pass

    prompt_duration = _extract_duration_seconds_from_text(prompt)
    if prompt_duration:
        return prompt_duration, "prompt"

    return _read_video_default_seconds(), "default"


def _build_inline_image_data_url(image_url: str) -> str | None:
    try:
        image_bytes = _resolve_image_bytes(image_url)
        with Image.open(io.BytesIO(image_bytes)) as original:
            image = original.copy()
    except Exception:
        return None

    max_side = _read_positive_int_env("MEDIA_OPENAI_SCRIPT_IMAGE_MAX_SIDE", 1280)
    width, height = image.size
    if max(width, height) > max_side:
        scale = max_side / float(max(width, height))
        resized_width = max(1, int(round(width * scale)))
        resized_height = max(1, int(round(height * scale)))
        resampling = getattr(Image, "Resampling", Image)
        image = image.resize((resized_width, resized_height), resampling.LANCZOS)

    has_alpha = "A" in image.getbands()
    output = io.BytesIO()
    if has_alpha:
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        image.save(output, format="PNG", optimize=True)
        mime_type = "image/png"
    else:
        if image.mode != "RGB":
            image = image.convert("RGB")
        quality = _read_positive_int_env("MEDIA_OPENAI_SCRIPT_IMAGE_JPEG_QUALITY", 85)
        quality = max(40, min(95, quality))
        image.save(output, format="JPEG", optimize=True, quality=quality)
        mime_type = "image/jpeg"

    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _flatten_llm_content(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        return json.dumps(raw, ensure_ascii=False)
    if isinstance(raw, list):
        pieces = []
        for item in raw:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("value") or ""
                if not text and isinstance(item.get("content"), str):
                    text = item["content"]
                if text:
                    pieces.append(str(text))
        return "".join(pieces)
    try:
        return json.dumps(raw, ensure_ascii=False)
    except TypeError:
        return str(raw)


def _request_video_shooting_script(client: Any, model_name: str, system_prompt: str, user_text: str, image_ref: str) -> str:
    response = client.chat.completions.create(
        model=model_name,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_ref}},
                ],
            },
        ],
    )
    return _flatten_llm_content(response.choices[0].message.content).strip()


def analyze_video_shooting_script(image_url: str, prompt: str, duration_seconds: int, duration_source: str = "request") -> str:
    if not image_url or not isinstance(image_url, str):
        return ""
    if not image_url.lower().startswith(("http://", "https://")):
        return ""

    duration_seconds = max(1, min(300, int(duration_seconds or _read_video_default_seconds())))
    duration_source_text = {
        "request": "用户参数指定",
        "prompt": "用户文本指定",
        "default": "系统默认配置",
    }.get(duration_source, "用户参数指定")

    system_prompt = (
        "你是资深产品视频导演与分镜师。"
        "任务：基于给定单张产品图，生成可直接用于视频生成模型的拍摄脚本。"
        "目标：画面高级、稳定、可执行，突出产品材质、结构与卖点。"
        "硬性约束："
        "1) 严格保留原图主体，不改变品牌识别、外形比例、关键颜色与纹理；"
        "2) 若原图已有清晰背景，严格保持产品背景图语义一致，允许轻微景深与透视变化；"
        "若原图背景缺失、纯色或抠图状态，可补充与产品用途一致的写实背景，但不得喧宾夺主或引入无关主体；"
        "3) 光影必须与原图一致并做自然适配：保持主光方向、色温与强弱关系，阴影接触关系真实，不得出现漂浮、穿帮或不合理反射；"
        "4) 禁止添加文字、Logo、水印、字幕、UI、新物体或无关场景元素；"
        "5) 禁止夸张跳切和不连贯运动，镜头运动要平滑、真实可实现。"
        "时间轴规则："
        "1) 必须覆盖从 0 秒到总时长结束的完整区间，不能有缺口或重叠；"
        "2) 必须按时间段写分镜，每段使用\u201c起始秒~结束秒\u201d；"
        "3) 示例：若总时长为 8 秒，可写 0~3 秒、4~6 秒、7~8 秒；"
        "4) 每个时间段都要写清镜头语言：景别、机位/运动、主体表现与卖点、背景处理、光影适配要点。"
        "输出要求："
        "1) 仅输出脚本正文，不要标题、解释、前后缀、Markdown；"
        "2) 以 3-6 个时间段镜头输出，每个镜头单独一行；"
        "3) 每行固定格式：[镜头N][起始~结束秒][景别][机位/运动][主体表现][背景处理(保留/新增写实背景)][光影适配]；"
        "4) 若用户给出时长、节奏、风格、构图、运动方向等要求，必须优先遵循；"
        "5) 在最后追加一行\u201c全局限制：...\u201d总结不加新元素、不加文字、背景处理策略、光影真实适配等限制。"
    )
    user_text = (
        "请分析这张图片并生成拍摄脚本。"
        f"\n目标总时长：{duration_seconds} 秒。"
        f"\n时长来源：{duration_source_text}。"
        f"\n请按 {duration_seconds} 秒的总时长进行时间段分镜，时间段必须连续覆盖 0~{duration_seconds} 秒。"
    )
    if prompt:
        user_text = f"{user_text}\n用户需求：{prompt}"

    model_name = os.getenv("MEDIA_OPENAI_SCRIPT_MODEL", "gpt-4.1-mini")
    try:
        client = openai_client_for_media()
        inline_image_url = _build_inline_image_data_url(image_url)
        image_ref = inline_image_url or image_url
        content = _request_video_shooting_script(client, model_name, system_prompt, user_text, image_ref)

        if not content and inline_image_url:
            content = _request_video_shooting_script(client, model_name, system_prompt, user_text, image_url)

        return content[:1500].strip()
    except Exception as exc:
        logger.warning("MEDIA_OPENAI video script analysis failed: %s", exc, exc_info=True)
        return ""
