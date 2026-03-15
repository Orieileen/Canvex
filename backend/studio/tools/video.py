from __future__ import annotations

import io
import json
import os
import time
import uuid
from typing import Any

import requests
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.utils import timezone
from langchain_core.tools import tool
from PIL import Image

from .common import (
    _abs_url,
    _media_auth_headers,
    _read_int_env,
    _read_media_timeout_seconds,
    _resolve_image_bytes,
    _resolve_media_compat_url,
    openai_client_for_media,
)

_VIDEO_ALLOWED_SECONDS = (4, 8, 12)
_VIDEO_DONE_STATUSES = {"completed", "succeeded", "success"}
_VIDEO_FAILED_STATUSES = {"failed", "error", "cancelled", "canceled"}


def _video_poll_limits(default_attempts: int = 120, default_interval: int = 5) -> tuple[int, int]:
    """读取视频轮询配置。

    这个函数负责统一计算轮询 OpenAI 视频任务时使用的最大轮询次数和轮询间隔。
    `default_attempts` 和 `default_interval` 由调用方传入，当前来自 `_wait_for_video()` 的默认值；
    同时函数会再结合环境变量 `MEDIA_VIDEO_POLL_INTERVAL`、
    `MEDIA_VIDEO_POLL_MAX_ATTEMPTS` 和 `MEDIA_VIDEO_TIMEOUT_SECONDS` 做最终计算。
    返回值是 `(attempts, interval)`，供后续轮询接口时直接使用。
    这个函数当前只会被 `_wait_for_video()` 调用。
    """
    interval = max(1, _read_int_env("MEDIA_VIDEO_POLL_INTERVAL", default_interval))
    attempts = max(1, _read_int_env("MEDIA_VIDEO_POLL_MAX_ATTEMPTS", default_attempts))
    timeout_seconds = _read_int_env("MEDIA_VIDEO_TIMEOUT_SECONDS", 1800)
    if timeout_seconds > 0:
        attempts = max(attempts, max(1, (timeout_seconds + interval - 1) // interval))
    return attempts, interval


def _video_seconds(value: Any) -> str:
    """校验并标准化视频时长。

    这个函数负责把外部传入的视频时长转换成 OpenAI Videos API 需要的字符串秒数，并确保值在允许范围内。
    参数 `value` 来自 `_generate_video_media()` 里的 `payload["seconds"]`，
    调用方必须显式传入合法秒数。
    返回值是形如 `"4"`、`"8"`、`"12"` 的字符串，供 `client.videos.create(...)` 直接使用。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    seconds = int(value)
    if seconds not in _VIDEO_ALLOWED_SECONDS:
        raise ValueError(f"video seconds must be one of {list(_VIDEO_ALLOWED_SECONDS)}")
    return str(seconds)


def _parse_video_size(value: Any) -> tuple[int, int]:
    """解析尺寸字符串为宽高整数。

    这个函数负责把 `1280x720` 这种尺寸文本拆成 `(1280, 720)`，方便后续按目标画布处理参考图。
    参数 `value` 来自 `_normalize_video_reference_image()` 传入的 `size`，
    而这个 `size` 又是由 `_generate_video_media()` 根据 payload 算出来的。
    返回值是 `(width, height)` 元组，用于缩放和铺底参考图。
    这个函数当前只会被 `_normalize_video_reference_image()` 调用。
    """
    raw = str(value or "").strip().lower()
    if "x" not in raw:
        raise ValueError(f"invalid video size: {raw}")
    left, right = raw.split("x", 1)
    width = int(float(left.strip()))
    height = int(float(right.strip()))
    if width <= 0 or height <= 0:
        raise ValueError(f"invalid video size: {raw}")
    return width, height


def _normalize_video_reference_image(image_bytes: bytes, size: str) -> bytes:
    """把参考图标准化成与视频尺寸一致的 PNG。

    这个函数负责把外部参考图按视频目标尺寸进行等比缩放并黑边补齐，避免直接把非同尺寸图片传给
    OpenAI 视频接口时产生不可控的拉伸结果。
    参数 `image_bytes` 来自 `_generate_video_media()` 通过 `_resolve_image_bytes()` 下载到的首张参考图；
    参数 `size` 也是 `_generate_video_media()` 根据 payload 计算出来的视频尺寸。
    返回值是处理后的 PNG 二进制，会作为 `client.videos.create(...)` 的 `input_reference` 上传。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    target_width, target_height = _parse_video_size(size)
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = source.copy()

    source_width, source_height = image.size
    if source_width <= 0 or source_height <= 0:
        raise ValueError("reference image has invalid size")

    image_rgba = image if image.mode == "RGBA" else image.convert("RGBA")
    scale = min(target_width / float(source_width), target_height / float(source_height))
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    if (resized_width, resized_height) != image_rgba.size:
        image_rgba = image_rgba.resize((resized_width, resized_height), Image.LANCZOS)

    canvas = Image.new("RGB", (target_width, target_height), (0, 0, 0))
    paste_x = (target_width - resized_width) // 2
    paste_y = (target_height - resized_height) // 2
    canvas.paste(image_rgba, (paste_x, paste_y), image_rgba)

    output = io.BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue()


def _first_image_url(value: Any) -> str | None:
    """从参考图列表里取出第一张图片地址。

    这个函数负责校验 `image_urls` 的基本结构，并明确当前视频流程只消费第一张参考图。
    参数 `value` 来自 `_generate_video_media()` 里的 `payload["image_urls"]`，
    而 payload 又是由 `videotool()`、任务队列或其他上层调用方构造的。
    返回值是第一张图片的 URL；如果没有传图则返回 `None`，供后续决定是否附带 `input_reference`。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("image_urls must be a list of strings")
    if not value:
        return None
    first = value[0]
    if not isinstance(first, str) or not first.strip():
        raise ValueError("image_urls[0] must be a non-empty string")
    return first.strip()


def _to_video_bytes(blob: Any) -> bytes:
    """把 SDK 返回的视频内容对象转换成原始字节。

    这个函数负责兼容 OpenAI Python SDK 可能返回的几种视频内容形态，例如直接的 `bytes`、
    带 `read()` 方法的流对象，或者带 `content` 属性的响应对象。
    参数 `blob` 来自 `_generate_video_media()` 对 `client.videos.download_content(...)` 的调用结果。
    返回值是 MP4 的二进制内容，供后续保存到 Django 存储系统。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    if isinstance(blob, (bytes, bytearray)):
        return bytes(blob)
    if hasattr(blob, "read"):
        data = blob.read()
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
    content = getattr(blob, "content", None)
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)
    raise ValueError("video content is empty")


def _compat_video_scalar(value: Any) -> str:
    return json.dumps(str(value))


def _compat_video_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("id", "task_id", "job_id", "video_id"):
            token = value.get(key)
            if token is not None and str(token).strip():
                return str(token).strip()
    token = str(value or "").strip()
    return token


def _compat_video_status(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("status", "state", "phase"):
            token = value.get(key)
            if token is not None and str(token).strip():
                return str(token).strip().lower()
    return str(value or "").strip().lower()


def _compat_video_error(value: Any) -> str:
    if isinstance(value, dict):
        error = value.get("error")
        if isinstance(error, dict):
            for key in ("message", "detail", "error"):
                token = error.get(key)
                if token is not None and str(token).strip():
                    return str(token).strip()
        elif error is not None and str(error).strip():
            return str(error).strip()
        for key in ("message", "detail"):
            token = value.get(key)
            if token is not None and str(token).strip():
                return str(token).strip()
    return str(value or "").strip()


def _parse_compat_video_json(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        data = response.json()
    except Exception as exc:
        raise RuntimeError(f"compat video {action} returned invalid json: {exc}") from exc
    if response.status_code >= 400:
        detail = _compat_video_error(data)
        raise RuntimeError(
            detail or f"compat video {action} returned {response.status_code}"
        )
    return data if isinstance(data, dict) else {"data": data}


def _save_video_to_media(video_bytes: bytes, video_id: str) -> str:
    """把生成完成的视频落盘到媒体存储并返回访问地址。

    这个函数负责将 MP4 字节写入 Django 的 `default_storage`，并生成一个可对外访问的绝对 URL。
    参数 `video_bytes` 来自 `_generate_video_media()` 下载并解析出的最终视频内容；
    参数 `video_id` 来自 OpenAI 视频任务的 id，用于组成稳定的文件名。
    返回值是保存后的视频 URL，供上层任务、接口或工具结果直接返回给前端。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    stamp = timezone.now().strftime("%Y/%m/%d")
    safe_id = str(video_id or uuid.uuid4().hex).replace(":", "_").replace("/", "_")
    path = f"canvex_videos/{stamp}/{safe_id}.mp4"
    saved = default_storage.save(path, ContentFile(video_bytes))
    return _abs_url(default_storage.url(saved)) or ""


def _wait_for_video(client: Any, video_id: str) -> Any:
    """轮询 OpenAI 视频任务直到结束。

    这个函数负责根据视频任务 id 持续调用 `client.videos.retrieve(...)`，直到任务进入完成或失败状态，
    或者达到超时上限。
    参数 `client` 来自 `_generate_video_media()` 创建的 OpenAI SDK client；
    参数 `video_id` 来自 `client.videos.create(...)` 返回的任务 id。
    返回值是 SDK 返回的视频任务对象，供 `_generate_video_media()` 判断状态并决定下载内容还是返回错误。
    这个函数当前只会被 `_generate_video_media()` 调用。
    """
    max_attempts, interval = _video_poll_limits(default_attempts=120, default_interval=5)
    for _ in range(max_attempts):
        video = client.videos.retrieve(video_id)
        status = str(getattr(video, "status", "") or "").strip().lower()
        if status == "completed":
            return video
        if status in {"failed", "error", "cancelled", "canceled"}:
            return video
        time.sleep(interval)
    raise TimeoutError(f"Task {video_id} did not complete")


def _wait_for_compat_video(raw_endpoint: str, video_id: str) -> dict[str, Any]:
    status_url = _resolve_media_compat_url(raw_endpoint, video_id)
    if not status_url:
        raise RuntimeError("compat video endpoint is not configured")
    max_attempts, interval = _video_poll_limits(default_attempts=120, default_interval=5)
    for _ in range(max_attempts):
        response = requests.get(
            status_url,
            headers=_media_auth_headers(),
            timeout=_read_media_timeout_seconds(),
        )
        data = _parse_compat_video_json(response, "status")
        status = _compat_video_status(data)
        if status in _VIDEO_DONE_STATUSES or status in _VIDEO_FAILED_STATUSES:
            return data
        time.sleep(interval)
    raise TimeoutError(f"Task {video_id} did not complete")


def _download_compat_video_content(raw_endpoint: str, video_id: str) -> bytes:
    content_url = _resolve_media_compat_url(raw_endpoint, video_id, "content")
    if not content_url:
        raise RuntimeError("compat video endpoint is not configured")
    response = requests.get(
        content_url,
        headers=_media_auth_headers(),
        timeout=_read_media_timeout_seconds(),
    )
    if response.status_code >= 400:
        try:
            detail = _compat_video_error(response.json())
        except Exception:
            detail = (response.text or "").strip()
        raise RuntimeError(detail or f"compat video content returned {response.status_code}")

    content_type = (response.headers.get("Content-Type") or "").lower()
    if "json" in content_type:
        data = response.json()
        for key in ("url", "video_url", "download_url"):
            token = data.get(key) if isinstance(data, dict) else None
            if token is not None and str(token).strip():
                download = requests.get(str(token).strip(), timeout=_read_media_timeout_seconds())
                download.raise_for_status()
                if download.content:
                    return download.content
        raise RuntimeError("compat video content response missing downloadable url")

    if response.content:
        return response.content
    raise RuntimeError("compat video content is empty")


def _generate_video_media_via_compat(payload: dict[str, Any], raw_endpoint: str) -> dict[str, Any]:
    endpoint = _resolve_media_compat_url(raw_endpoint)
    if not endpoint:
        raise RuntimeError("compat video endpoint is not configured")

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    size = str(payload.get("size") or "").strip()
    if not size:
        raise ValueError("size is required")

    model = str(payload.get("model") or os.getenv("MEDIA_VIDEO_MODEL", "")).strip()
    seconds = _video_seconds(payload.get("seconds"))
    form_data: dict[str, str] = {
        "model": _compat_video_scalar(model),
        "prompt": _compat_video_scalar(prompt),
        "seconds": _compat_video_scalar(seconds),
        "size": _compat_video_scalar(size),
    }

    files: dict[str, tuple[str, bytes, str]] = {}
    if first_image_url := _first_image_url(payload.get("image_urls")):
        files["image"] = (
            "image.png",
            _normalize_video_reference_image(_resolve_image_bytes(first_image_url), size),
            "image/png",
        )

    response = requests.post(
        endpoint,
        headers=_media_auth_headers(),
        data=form_data,
        files=files or None,
        timeout=_read_media_timeout_seconds(),
    )
    created = _parse_compat_video_json(response, "create")
    video_id = _compat_video_id(created)
    if not video_id:
        raise ValueError("compat video response missing id")

    video = _wait_for_compat_video(raw_endpoint, video_id)
    status = _compat_video_status(video)
    if status in _VIDEO_DONE_STATUSES:
        return {
            "task_id": video_id,
            "status": status,
            "url": _save_video_to_media(_download_compat_video_content(raw_endpoint, video_id), video_id),
        }

    return {
        "task_id": video_id,
        "status": status or "failed",
        "error": _compat_video_error(video) or "video generation failed",
    }


def _generate_video_media(payload: dict[str, Any]) -> dict[str, Any]:
    """执行完整的视频生成主流程。

    这个函数负责把上层传入的 payload 转成 OpenAI Videos API 所需参数，提交视频任务、轮询状态、
    下载完成后的 MP4，并把文件保存到本地媒体存储。
    参数 `payload` 来自 `videotool()`，也可能来自任务队列等其他内部调用方；
    其中会包含 `prompt`、`seconds`、`size`、`image_urls`、`model` 等字段。
    返回值是一个结果字典：成功时包含 `task_id`、`status`、`url`，失败时包含 `task_id`、`status`、`error`。
    这个函数当前会被 `videotool()` 调用，也是整个 `video.py` 的核心入口。
    """
    compat_endpoint = os.getenv("MEDIA_VIDEO_COMPAT_ENDPOINT", "").strip()
    if compat_endpoint:
        return _generate_video_media_via_compat(payload, compat_endpoint)

    client = openai_client_for_media()
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    size = str(payload.get("size") or "").strip()
    if not size:
        raise ValueError("size is required")
    create_kwargs: dict[str, Any] = {
        "model": str(payload.get("model") or os.getenv("MEDIA_VIDEO_MODEL", "")).strip(),
        "prompt": prompt,
        "seconds": _video_seconds(payload.get("seconds")),
        "size": size,
    }

    if first_image_url := _first_image_url(payload.get("image_urls")):
        create_kwargs["input_reference"] = (
            "input_reference.png",
            _normalize_video_reference_image(_resolve_image_bytes(first_image_url), size),
            "image/png",
        )

    created = client.videos.create(**create_kwargs)
    video_id = str(getattr(created, "id", "") or "").strip()
    if not video_id:
        raise ValueError("OpenAI video response missing id")

    video = _wait_for_video(client, video_id)
    status = str(getattr(video, "status", "") or "").strip().lower()
    if status == "completed":
        return {
            "task_id": video_id,
            "status": status,
            "url": _save_video_to_media(_to_video_bytes(client.videos.download_content(video_id, variant="video")), video_id),
        }

    error = getattr(video, "error", None)
    if isinstance(error, dict):
        error = error.get("message") or error.get("detail") or error.get("error")
    return {
        "task_id": video_id,
        "status": status or "failed",
        "error": str(error or "video generation failed"),
    }


@tool("videotool")
def videotool(
    prompt: str,
    seconds: int = 12,
    size: str = "1280x720",
    image_urls: list[str] | None = None,
    model: str | None = None,
    scene_id: str | None = None,
) -> dict[str, Any]:
    """LangChain 工具入口：根据提示词和可选参考图生成视频。

    这个函数负责接收外部工具调用参数，整理成内部 `payload` 后交给 `_generate_video_media()` 执行，
    再把内部结果转换成上层可消费的统一返回结构。
    参数 `prompt`、`seconds`、`size`、`image_urls`、`model`、`scene_id`
    来自工具调用方；当前会被 LangChain tool 机制、图编排逻辑或后台任务入口间接使用。
    返回值是一个字典：成功时返回 `task_id`、`status`、`url`、`scene_id`，
    失败时返回 `error` 和可选的 `scene_id`，供上层接口或任务状态更新逻辑继续处理。
    这个函数会被工具调用方直接使用，并在内部调用 `_generate_video_media()`。
    """
    payload = {
        "prompt": prompt,
        "seconds": seconds,
        "size": size,
        "image_urls": image_urls,
        "model": model,
    }

    try:
        result = _generate_video_media(payload)
    except Exception as exc:
        error = str(exc)
    else:
        if result.get("error") and not result.get("url"):
            error = str(result.get("error"))
        else:
            return {
                "task_id": result.get("task_id"),
                "status": result.get("status"),
                "url": result.get("url"),
                "scene_id": str(scene_id) if scene_id else None,
            }

    return {"error": error, "scene_id": str(scene_id) if scene_id else None}
