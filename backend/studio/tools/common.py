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

_IMAGE_B64_KEYS = ("b64_json", "b64", "base64", "image_base64")


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


def _pick_api_key() -> str:
    return os.getenv("MEDIA_OPENAI_API_KEY", "").strip()


def _pick_api_base() -> str | None:
    media_base = os.getenv("MEDIA_OPENAI_BASE_URL", "").strip().rstrip("/")
    if media_base:
        return media_base
    chat_base = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")
    return chat_base or None


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


def _read_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


def _read_bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _read_media_timeout_seconds(default_seconds: float = 180.0) -> float:
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", str(default_seconds))
    try:
        return max(1.0, float(timeout_raw))
    except Exception:
        return default_seconds


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


def _decode_image_base64(raw: str) -> bytes:
    token = (raw or "").strip()
    if token.startswith("data:") and "," in token:
        token = token.split(",", 1)[1]
    token = "".join(token.split())
    if not token:
        raise ValueError("empty base64 image payload")
    return base64.b64decode(token)


def _extract_inline_image_bytes(item: dict[str, Any]) -> bytes | None:
    decode_error: Exception | None = None

    def _try_value(value: Any) -> bytes | None:
        nonlocal decode_error
        if isinstance(value, str) and value.strip():
            try:
                return _decode_image_base64(value)
            except Exception as exc:
                decode_error = exc
        return None

    for key in _IMAGE_B64_KEYS:
        content = _try_value(item.get(key))
        if content:
            return content

    images = item.get("images")
    if isinstance(images, list):
        for image in images:
            if not isinstance(image, dict):
                continue
            for key in _IMAGE_B64_KEYS:
                content = _try_value(image.get(key))
                if content:
                    return content

    if decode_error:
        raise ValueError(f"invalid inline base64 image data: {decode_error}")
    return None


def _image_bytes_to_data_url(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _pick_url(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item:
                return item
    if isinstance(value, dict):
        return _pick_url(value.get("url") or value.get("urls"))
    return None


def _find_first_url(obj: Any) -> str | None:
    """Best-effort scan for the first http(s) URL in nested data."""
    if obj is None:
        return None
    if isinstance(obj, str):
        return obj if obj.strip().lower().startswith(("http://", "https://")) else None
    if isinstance(obj, dict):
        for v in obj.values():
            url = _find_first_url(v)
            if url:
                return url
    if isinstance(obj, (list, tuple)):
        for item in obj:
            url = _find_first_url(item)
            if url:
                return url
    return None


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
