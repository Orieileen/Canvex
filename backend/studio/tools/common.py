from __future__ import annotations

import base64
import logging
import os
from typing import Any
from urllib.parse import urlparse, urlunparse

import requests
from django.conf import settings
from openai import OpenAI

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
logger = logging.getLogger(__name__)


# 将相对路径转为完整的绝对 URL（拼接 PUBLIC_MEDIA_BASE 等环境变量作为前缀）。
# 输入: url — 相对或绝对路径字符串。
# 调用方: views.ExcalidrawImageEditJobView.get, tasks._persist_video_thumbnail,
#          image.imagetool, video._save_video_to_media
def _abs_url(url: str | None) -> str | None:
    if not url:
        return None
    if url.lower().startswith(("http://", "https://")):
        return url
    base = (
        os.getenv("PUBLIC_MEDIA_BASE")
        or os.getenv("PUBLIC_BASE_URL")
        or os.getenv("VITE_API_URL")
        or os.getenv("APP_BASE_URL")
        or getattr(settings, "PUBLIC_BASE_URL", None)
        or "http://localhost:8000"
    ).rstrip("/")
    return f"{base}{url}" if url.startswith("/") else f"{base}/{url}"


# 读取 MEDIA_OPENAI_API_KEY 环境变量，返回去空格后的 API 密钥字符串。
# 输入: 无（从环境变量读取）。
# 调用方: openai_client_for_media
def _pick_api_key() -> str:
    return os.getenv("MEDIA_OPENAI_API_KEY", "").strip()


# 优先读取 MEDIA_OPENAI_BASE_URL，其次 OPENAI_BASE_URL，返回 API 基础地址。
# 输入: 无（从环境变量读取）。
# 调用方: openai_client_for_media
def _pick_api_base() -> str | None:
    media_base = os.getenv("MEDIA_OPENAI_BASE_URL", "").strip().rstrip("/")
    if media_base:
        return media_base
    chat_base = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")
    return chat_base or None


# 构建用于媒体生成的 OpenAI 客户端实例（含 API 密钥、基础地址、超时配置）。
# 输入: 无（内部调用 _pick_api_key, _pick_api_base, _read_media_timeout_seconds）。
# 调用方: views._analyze_video_shooting_script, image._generate_image_media,
#          image._edit_image_media, video._generate_video_media
def openai_client_for_media() -> OpenAI:
    api_key = _pick_api_key()
    base_url = _pick_api_base() or OPENAI_DEFAULT_BASE_URL
    if not api_key:
        raise ValueError("MEDIA_OPENAI_API_KEY is not configured")
    params: dict[str, Any] = {
        "api_key": api_key,
        "base_url": base_url,
        "timeout": _read_media_timeout_seconds(),
    }
    return OpenAI(**params)


# 从环境变量读取整数值，解析失败时返回默认值。
# 输入: name — 环境变量名, default — 默认整数值。
# 调用方: tasks._schedule_video_retry, tasks._remove_white_background,
#          video._video_poll_limits
def _read_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


# 读取 MEDIA_OPENAI_TIMEOUT 环境变量作为超时秒数（最小 1 秒）。
# 输入: default_seconds — 默认超时秒数。
# 调用方: openai_client_for_media
def _read_media_timeout_seconds(default_seconds: float = 180.0) -> float:
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", str(default_seconds))
    try:
        return max(1.0, float(timeout_raw))
    except Exception:
        return default_seconds


# 根据 URL 下载图片并返回字节内容；localhost 地址会自动尝试内部服务地址回退。
# 输入: url — 图片 URL。
# 调用方: views._build_inline_image_data_url, tasks._persist_video_thumbnail,
#          video._generate_video_media
def _resolve_image_bytes(url: str) -> bytes:
    parsed = urlparse(url)
    candidates: list[str] = [url]
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        internal_base_raw = (
            os.getenv("INTERNAL_MEDIA_BASE")
            or os.getenv("BACKEND_INTERNAL_BASE_URL")
            or ""
        ).strip()
        if not internal_base_raw:
            internal_base_raw = "http://backend:8000"
            logger.warning(
                "Neither INTERNAL_MEDIA_BASE nor BACKEND_INTERNAL_BASE_URL is set; "
                "falling back to %s for resolving localhost image URL %s",
                internal_base_raw,
                url,
            )
        internal_base = internal_base_raw.rstrip("/")
        internal = urlparse(internal_base)
        internal_url = urlunparse(
            (
                internal.scheme or "http",
                internal.netloc or "backend:8000",
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment,
            )
        )
        if internal_url not in candidates:
            candidates.append(internal_url)

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            response = requests.get(candidate, timeout=120)
            response.raise_for_status()
            return response.content
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError("failed to resolve image bytes")


# 解码 base64 图片字符串为字节（支持 data:URI 前缀自动剥离）。
# 输入: raw — base64 编码的图片字符串。
# 调用方: image._extract_image_bytes_from_responses_output
def _decode_image_base64(raw: str) -> bytes:
    token = (raw or "").strip()
    if token.startswith("data:") and "," in token:
        token = token.split(",", 1)[1]
    token = "".join(token.split())
    if not token:
        raise ValueError("empty base64 image payload")
    return base64.b64decode(token)


# 将图片字节编码为 data:URI 字符串（如 data:image/png;base64,...）。
# 输入: image_bytes — 图片字节, mime_type — MIME 类型。
# 调用方: image._edit_image_media
def _image_bytes_to_data_url(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


# 将任意对象转为 dict（依次尝试 dict 判断、to_dict()、model_dump()、__dict__）。
# 输入: value — 任意对象。
# 调用方: image._extract_image_bytes_from_responses_output
def _to_dict_compatible(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        try:
            payload = to_dict()
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            payload = model_dump()
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass
    raw = getattr(value, "__dict__", None)
    if isinstance(raw, dict):
        return raw
    return {}
