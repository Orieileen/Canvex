from __future__ import annotations

import base64
import io
import logging
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import urlparse, urlunparse

import requests
from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import IntegrityError
from django.utils import timezone
from langchain_core.tools import tool
from openai import OpenAI
from PIL import Image

from .models import DataAsset, DataFolder, ExcalidrawScene

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
logger = logging.getLogger(__name__)


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
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", "180")
    params: dict[str, Any] = {
        "api_key": api_key,
        "base_url": base_url,
        "timeout": float(timeout_raw),
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


def _video_poll_limits(default_attempts: int = 120, default_interval: int = 5) -> tuple[int, int]:
    interval = max(1, _read_int_env("MEDIA_OPENAI_VIDEO_POLL_INTERVAL", default_interval))
    attempts = max(1, _read_int_env("MEDIA_OPENAI_VIDEO_POLL_MAX_ATTEMPTS", default_attempts))
    timeout_seconds = _read_int_env("MEDIA_OPENAI_VIDEO_TIMEOUT_SECONDS", 1800)
    if timeout_seconds > 0:
        min_attempts = (timeout_seconds + interval - 1) // interval
        attempts = max(attempts, max(1, min_attempts))
    return attempts, interval


def _normalize_video_seconds(value: Any, allowed_override: list[int] | None = None) -> str:
    allowed_raw = os.getenv("MEDIA_OPENAI_VIDEO_SECONDS_ALLOWED", "4,8,12")
    allowed: list[int] = []
    if allowed_override is not None:
        for item in allowed_override:
            try:
                allowed.append(int(item))
            except Exception:
                continue
    else:
        for item in allowed_raw.split(","):
            token = item.strip()
            if not token:
                continue
            try:
                allowed.append(int(token))
            except Exception:
                continue
    if not allowed:
        allowed = [4, 8, 12]
    allowed = sorted(set(allowed))

    default_seconds = _read_int_env("MEDIA_OPENAI_VIDEO_SECONDS_DEFAULT", 12)
    try:
        requested = int(value)
    except Exception:
        requested = default_seconds

    if requested in allowed:
        return str(requested)

    nearest = min(allowed, key=lambda item: abs(item - requested))
    return str(nearest)


def _extract_supported_video_seconds_from_error(exc: Exception) -> list[int]:
    text = str(exc or "")
    marker = "supported values"
    idx = text.lower().find(marker)
    if idx < 0:
        return []
    scope = text[idx:]
    values = [int(token) for token in re.findall(r"\b\d+\b", scope)]
    if not values:
        return []
    # Keep practical video durations only; filters out accidental non-duration integers.
    return sorted({item for item in values if 1 <= item <= 300})


def _resolve_image_bytes(url: str) -> bytes:
    parsed = urlparse(url)
    candidates: list[str] = [url]
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        internal_base = (
            os.getenv("INTERNAL_MEDIA_BASE")
            or os.getenv("BACKEND_INTERNAL_BASE_URL")
            or "http://backend:8000"
        ).rstrip("/")
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


_IMAGE_B64_KEYS = ("b64_json", "b64", "base64", "image_base64")


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


def _generate_image_media(prompt: str, size: str) -> bytes:
    client = openai_client_for_media()
    model = os.getenv("MEDIA_OPENAI_IMAGE_MODEL", "").strip()
    response_format = os.getenv("MEDIA_OPENAI_IMAGE_RESPONSE_FORMAT", "b64_json").strip().lower() or "b64_json"

    kwargs: dict[str, Any] = {
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    if model:
        kwargs["model"] = model
    if response_format in {"b64_json", "url"}:
        kwargs["response_format"] = response_format

    try:
        response = client.images.generate(**kwargs)
    except Exception as exc:
        if "response_format" in str(exc).lower() and "response_format" in kwargs:
            kwargs.pop("response_format", None)
            response = client.images.generate(**kwargs)
        else:
            raise
    return _extract_image_bytes_from_openai_response(response)


def _images_generations_compat_endpoint(base_url: str) -> str:
    root = (base_url or "").strip().rstrip("/")
    if not root:
        root = OPENAI_DEFAULT_BASE_URL
    if root.endswith("/images/generations"):
        return root
    if root.endswith("/v1"):
        return f"{root}/images/generations"
    return f"{root}/v1/images/generations"


def _post_images_generations_compat(
    *,
    json_payload: dict[str, Any] | None = None,
    form_payload: dict[str, Any] | None = None,
    file_payload: dict[str, Any] | None = None,
) -> bytes:
    api_key = _pick_api_key()
    base_url = _pick_api_base() or OPENAI_DEFAULT_BASE_URL
    if not api_key:
        raise ValueError("MEDIA_OPENAI_API_KEY is not configured")
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", "180")
    endpoint = _images_generations_compat_endpoint(base_url)

    headers = {"Authorization": f"Bearer {api_key}"}
    kwargs: dict[str, Any] = {
        "headers": headers,
        "timeout": float(timeout_raw),
    }
    if json_payload is not None:
        headers["Content-Type"] = "application/json"
        kwargs["json"] = json_payload
    else:
        kwargs["data"] = form_payload or {}
        if file_payload:
            kwargs["files"] = file_payload

    try:
        response = requests.post(endpoint, **kwargs)
    except Exception as exc:
        raise RuntimeError(f"compat /images/generations request failed: {exc}") from exc

    if response.status_code >= 400:
        body = (response.text or "").strip()
        snippet = f"{body[:1200]}..." if len(body) > 1200 else body
        raise RuntimeError(
            f"compat /images/generations returned {response.status_code}: {snippet or 'empty response body'}"
        )

    try:
        data = response.json()
    except Exception as exc:
        raise RuntimeError(f"compat /images/generations returned invalid json: {exc}") from exc

    return _extract_image_bytes_from_openai_response(data)


def _videos_generations_compat_endpoint(base_url: str) -> str:
    root = (base_url or "").strip().rstrip("/")
    if not root:
        root = OPENAI_DEFAULT_BASE_URL
    if root.endswith("/videos/generations"):
        return root
    if root.endswith("/v1"):
        return f"{root}/videos/generations"
    return f"{root}/v1/videos/generations"


def _dedupe_text_values(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        token = str(value or "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        ordered.append(token)
    return ordered


def _videos_compat_status_endpoints(base_url: str, video_id: str) -> list[str]:
    root = (base_url or "").strip().rstrip("/")
    if not root:
        root = OPENAI_DEFAULT_BASE_URL
    if root.endswith("/videos/generations"):
        endpoints = [f"{root}/{video_id}", f"{root.rsplit('/generations', 1)[0]}/{video_id}"]
    elif root.endswith("/v1"):
        endpoints = [f"{root}/videos/{video_id}", f"{root}/videos/generations/{video_id}"]
    else:
        endpoints = [f"{root}/v1/videos/{video_id}", f"{root}/v1/videos/generations/{video_id}"]
    return _dedupe_text_values(endpoints)


def _videos_compat_content_endpoints(base_url: str, video_id: str) -> list[str]:
    endpoints: list[str] = []
    for endpoint in _videos_compat_status_endpoints(base_url, video_id):
        endpoints.append(f"{endpoint}/content")
        endpoints.append(f"{endpoint}/download")
    return _dedupe_text_values(endpoints)


def _extract_video_task_id(result_data: Any) -> str | None:
    if isinstance(result_data, (list, tuple)):
        for item in result_data:
            nested = _extract_video_task_id(item)
            if nested:
                return nested
        return None
    if not isinstance(result_data, dict):
        return None
    for key in ("id", "task_id", "job_id", "video_id"):
        value = result_data.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    for nested_key in ("data", "result", "video", "task", "job"):
        nested = _extract_video_task_id(result_data.get(nested_key))
        if nested:
            return nested
    return None


def _extract_video_status(result_data: Any) -> str:
    if isinstance(result_data, (list, tuple)):
        for item in result_data:
            nested = _extract_video_status(item)
            if nested:
                return nested
        return ""
    if not isinstance(result_data, dict):
        return ""
    for key in ("status", "state", "phase"):
        value = result_data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    for nested_key in ("data", "result", "video", "task", "job"):
        nested = _extract_video_status(result_data.get(nested_key))
        if nested:
            return nested
    return ""


def _extract_video_error_text(result_data: Any) -> str:
    if isinstance(result_data, (list, tuple)):
        for item in result_data:
            nested = _extract_video_error_text(item)
            if nested:
                return nested
        return ""
    if not isinstance(result_data, dict):
        return ""
    error = result_data.get("error")
    if isinstance(error, dict):
        detail = error.get("message") or error.get("error") or error.get("detail")
        if detail is not None and str(detail).strip():
            return str(detail).strip()
    elif error is not None and str(error).strip():
        return str(error).strip()

    for key in ("message", "detail"):
        value = result_data.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()

    for nested_key in ("data", "result", "video", "task", "job"):
        nested = _extract_video_error_text(result_data.get(nested_key))
        if nested:
            return nested
    return ""


def _read_media_timeout_seconds(default_seconds: float = 180.0) -> float:
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", str(default_seconds))
    try:
        return max(1.0, float(timeout_raw))
    except Exception:
        return default_seconds


def _post_videos_generations_compat(
    *,
    base_url: str,
    request_payload: dict[str, Any],
    input_reference_bytes: bytes | None = None,
    input_reference_url: str | None = None,
) -> dict[str, Any]:
    api_key = _pick_api_key()
    if not api_key:
        raise ValueError("MEDIA_OPENAI_API_KEY is not configured")
    endpoint = _videos_generations_compat_endpoint(base_url)
    timeout_seconds = _read_media_timeout_seconds()

    def _parse_response(response: requests.Response) -> dict[str, Any]:
        if response.status_code >= 400:
            body = (response.text or "").strip()
            snippet = f"{body[:1200]}..." if len(body) > 1200 else body
            raise RuntimeError(
                f"compat /videos/generations returned {response.status_code}: {snippet or 'empty response body'}"
            )
        try:
            data = response.json()
        except Exception as exc:
            raise RuntimeError(f"compat /videos/generations returned invalid json: {exc}") from exc
        return data if isinstance(data, dict) else {"data": data}

    json_payload = dict(request_payload or {})
    if input_reference_bytes:
        # Prefer JSON for compat gateways that do not parse multipart fields.
        json_payload["input_reference"] = _image_bytes_to_data_url(input_reference_bytes)
    elif input_reference_url:
        json_payload["input_reference"] = str(input_reference_url).strip()

    json_headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    json_exc: Exception | None = None
    try:
        json_response = requests.post(endpoint, headers=json_headers, json=json_payload, timeout=timeout_seconds)
        return _parse_response(json_response)
    except Exception as exc:
        json_exc = exc
        if not input_reference_bytes:
            raise RuntimeError(f"compat /videos/generations request failed: {json_exc}") from json_exc

    multipart_headers = {"Authorization": f"Bearer {api_key}"}
    multipart_data = dict(request_payload or {})
    if input_reference_url:
        multipart_data["input_reference_url"] = str(input_reference_url).strip()
    try:
        multipart_response = requests.post(
            endpoint,
            headers=multipart_headers,
            data=multipart_data,
            files={"input_reference": ("input_reference.png", input_reference_bytes, "image/png")},
            timeout=timeout_seconds,
        )
        return _parse_response(multipart_response)
    except Exception as multipart_exc:
        json_message = str(json_exc) if json_exc is not None else "not attempted"
        raise RuntimeError(
            "compat /videos/generations request failed: "
            f"json attempt error={json_message}; multipart attempt error={multipart_exc}"
        ) from multipart_exc


def _looks_like_mp4(blob: bytes) -> bool:
    if len(blob) < 12:
        return False
    return blob[4:8] == b"ftyp"


def _get_video_status_via_compat(base_url: str, video_id: str) -> dict[str, Any]:
    api_key = _pick_api_key()
    if not api_key:
        raise ValueError("MEDIA_OPENAI_API_KEY is not configured")
    timeout_seconds = _read_media_timeout_seconds()
    headers = {"Authorization": f"Bearer {api_key}"}
    errors: list[str] = []

    for endpoint in _videos_compat_status_endpoints(base_url, video_id):
        try:
            response = requests.get(endpoint, headers=headers, timeout=timeout_seconds)
        except Exception as exc:
            errors.append(f"{endpoint}: {exc}")
            continue

        if response.status_code == 404:
            continue
        if response.status_code >= 400:
            body = (response.text or "").strip()
            snippet = f"{body[:300]}..." if len(body) > 300 else body
            errors.append(f"{endpoint}: {response.status_code} {snippet or 'empty body'}")
            continue

        content_type = (response.headers.get("Content-Type") or "").lower()
        if "json" in content_type:
            try:
                data = response.json()
                return data if isinstance(data, dict) else {"data": data}
            except Exception as exc:
                errors.append(f"{endpoint}: invalid json ({exc})")
                continue

        body = response.content or b""
        if body and _looks_like_mp4(body):
            saved_url = _save_video_to_media(body, video_id)
            return {"id": str(video_id), "status": "completed", "video_url": saved_url}

        text = (response.text or "").strip()
        if text.lower().startswith(("http://", "https://")):
            return {"id": str(video_id), "status": "completed", "video_url": text}
        if text.startswith("{") or text.startswith("["):
            try:
                data = response.json()
                return data if isinstance(data, dict) else {"data": data}
            except Exception as exc:
                errors.append(f"{endpoint}: invalid json body ({exc})")
                continue
        errors.append(f"{endpoint}: unsupported response content type ({content_type or 'unknown'})")

    if errors:
        raise RuntimeError("compat video status request failed: " + "; ".join(errors))
    raise RuntimeError("compat video status endpoint not found (all 404)")


def _download_video_url_content(video_url: str, api_key: str, timeout_seconds: float) -> bytes:
    last_error: Exception | None = None
    for headers in (None, {"Authorization": f"Bearer {api_key}"}):
        kwargs: dict[str, Any] = {"timeout": timeout_seconds}
        if headers:
            kwargs["headers"] = headers
        try:
            response = requests.get(video_url, **kwargs)
            response.raise_for_status()
            if response.content:
                return response.content
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError("video download returned empty content")


def _download_video_content_via_compat(base_url: str, video_id: str, status_data: dict[str, Any]) -> bytes:
    api_key = _pick_api_key()
    if not api_key:
        raise ValueError("MEDIA_OPENAI_API_KEY is not configured")
    timeout_seconds = _read_media_timeout_seconds()
    headers = {"Authorization": f"Bearer {api_key}"}

    video_url, _ = _extract_video_urls(status_data)
    if not video_url:
        candidate = _find_first_url(status_data)
        if candidate and ".mp4" in candidate.lower():
            video_url = candidate
    if video_url:
        return _download_video_url_content(video_url, api_key, timeout_seconds)

    errors: list[str] = []
    for endpoint in _videos_compat_content_endpoints(base_url, video_id):
        try:
            response = requests.get(endpoint, headers=headers, timeout=timeout_seconds)
        except Exception as exc:
            errors.append(f"{endpoint}: {exc}")
            continue

        if response.status_code == 404:
            continue
        if response.status_code >= 400:
            body = (response.text or "").strip()
            snippet = f"{body[:300]}..." if len(body) > 300 else body
            errors.append(f"{endpoint}: {response.status_code} {snippet or 'empty body'}")
            continue

        content_type = (response.headers.get("Content-Type") or "").lower()
        body = response.content or b""
        if body and ("json" not in content_type) and (_looks_like_mp4(body) or "video/" in content_type):
            return body

        if "json" in content_type or (response.text or "").strip().startswith(("{", "[")):
            try:
                data = response.json()
            except Exception as exc:
                errors.append(f"{endpoint}: invalid json ({exc})")
                continue
            if not isinstance(data, dict):
                data = {"data": data}
            nested_url, _ = _extract_video_urls(data)
            if nested_url:
                return _download_video_url_content(nested_url, api_key, timeout_seconds)
            errors.append(f"{endpoint}: json response missing video url")
            continue

        errors.append(f"{endpoint}: unsupported response content type ({content_type or 'unknown'})")

    if errors:
        raise RuntimeError("compat video download failed: " + "; ".join(errors))
    raise RuntimeError("compat video download endpoint not found (all 404)")


_VIDEO_SUCCESS_STATUSES = {"completed", "succeeded", "success"}
_VIDEO_FAILED_STATUSES = {"failed", "error", "cancelled", "canceled"}


def _is_video_success_status(status: str) -> bool:
    return str(status or "").strip().lower() in _VIDEO_SUCCESS_STATUSES


def _is_video_failed_status(status: str) -> bool:
    return str(status or "").strip().lower() in _VIDEO_FAILED_STATUSES


def _edit_image_media_via_compat_endpoint(source_bytes: bytes, prompt: str, size: str, model: str) -> bytes:
    response_format = os.getenv("MEDIA_OPENAI_IMAGE_RESPONSE_FORMAT", "b64_json").strip().lower() or "b64_json"
    if response_format not in {"b64_json", "url"}:
        response_format = "b64_json"

    # Try multipart first so third-party gateways can receive file + prompt.
    image_field = "image"
    filename = "image.png"
    mime_type = "image/png"
    form_payload: dict[str, Any] = {
        "prompt": prompt,
        "n": "1",
        "response_format": response_format,
    }
    if model:
        form_payload["model"] = model
    if size:
        form_payload["size"] = size

    try:
        return _post_images_generations_compat(
            form_payload=form_payload,
            file_payload={image_field: (filename, source_bytes, mime_type)},
        )
    except Exception as multipart_exc:
        logger.warning(
            "compat /images/generations multipart edit failed, try json image fallback: %s",
            multipart_exc,
        )

    # Fallback to JSON + data URL image for gateways that do not accept multipart.
    data_url = _image_bytes_to_data_url(source_bytes, mime_type)
    json_fields = ["image", "input_image", "image_base64"]

    json_errors: list[str] = []
    for image_key in json_fields:
        payload: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
            "response_format": response_format,
            image_key: data_url,
        }
        if model:
            payload["model"] = model
        if size:
            payload["size"] = size
        try:
            return _post_images_generations_compat(json_payload=payload)
        except Exception as json_exc:
            json_errors.append(f"{image_key}: {json_exc}")

    message = "; ".join(json_errors) if json_errors else "no json image attempts"
    raise RuntimeError(
        f"compat /images/generations with image failed ({message}). "
        "Text-only fallback is disabled because it ignores source image."
    )


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


def _extract_image_bytes_from_openai_response(response: Any) -> bytes:
    raw_items: Any = None
    if isinstance(response, dict):
        raw_items = response.get("data")
    else:
        raw_items = getattr(response, "data", None)
    if isinstance(raw_items, (list, tuple)):
        data_items = list(raw_items)
    elif raw_items:
        data_items = [raw_items]
    else:
        data_items = []
    if not data_items:
        raise ValueError("empty image response")

    image_data = data_items[0]

    item_dict = _to_dict_compatible(image_data)
    if item_dict:
        inline_bytes = _extract_inline_image_bytes(item_dict)
        if inline_bytes:
            return inline_bytes
        image_url = _pick_url(item_dict.get("url") or item_dict.get("urls"))
        if image_url:
            return _resolve_image_bytes(image_url)

    for key in _IMAGE_B64_KEYS:
        b64_value = getattr(image_data, key, None)
        if isinstance(b64_value, str) and b64_value.strip():
            return _decode_image_base64(b64_value)

    image_url = getattr(image_data, "url", None)
    if isinstance(image_url, str) and image_url.strip():
        return _resolve_image_bytes(image_url)

    raise ValueError("empty image response")


def _is_unsupported_image_edit_model_error(exc: Exception) -> bool:
    text = str(exc or "").lower()
    if not text:
        return False
    if "invalid value" in text and "param" in text and "model" in text:
        return True
    if "model_not_found" in text:
        return True
    if "value must be" in text and "model" in text:
        return True
    return False


def _normalize_image_for_edit(source_bytes: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(source_bytes)) as original:
            image = original.copy()
    except Exception:
        return source_bytes

    if image.mode not in {"RGBA", "LA", "L"}:
        image = image.convert("RGBA")

    output = io.BytesIO()
    try:
        image.save(output, format="PNG")
        return output.getvalue()
    except Exception:
        return source_bytes


def _image_bytes_to_data_url(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_image_bytes_from_responses_output(response: Any) -> bytes:
    raw_output: Any = None
    if isinstance(response, dict):
        raw_output = response.get("output")
    else:
        raw_output = getattr(response, "output", None)

    if not isinstance(raw_output, (list, tuple)):
        raw_output = [raw_output] if raw_output else []

    for item in raw_output:
        item_dict = _to_dict_compatible(item)
        item_type = item_dict.get("type") or getattr(item, "type", None)
        if item_type != "image_generation_call":
            continue
        result = item_dict.get("result") if item_dict else getattr(item, "result", None)
        if isinstance(result, str) and result.strip():
            return _decode_image_base64(result)

    raise ValueError("responses image_generation_call result missing")


def _edit_image_media_via_images(client: OpenAI, source_bytes: bytes, prompt: str, size: str, model: str) -> bytes:
    kwargs: dict[str, Any] = {
        "model": model,
        "image": ("image.png", source_bytes, "image/png"),
        "prompt": prompt,
        "response_format": "b64_json",
    }
    if size:
        kwargs["size"] = size
    response = client.images.edit(**kwargs)
    return _extract_image_bytes_from_openai_response(response)


def _edit_image_media_via_responses(client: OpenAI, source_bytes: bytes, prompt: str, size: str, model: str) -> bytes:
    responses_model = (
        os.getenv("MEDIA_OPENAI_RESPONSES_MODEL", "").strip()
        or os.getenv("EXCALIDRAW_CHAT_MODEL", "").strip()
        or "gpt-4o-mini"
    )
    fidelity = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_INPUT_FIDELITY", "high").strip().lower()
    if fidelity not in {"high", "low"}:
        fidelity = "high"

    tool_config: dict[str, Any] = {
        "type": "image_generation",
        "action": "edit",
        "model": model,
        "output_format": "png",
        "quality": "high",
    }
    if size:
        tool_config["size"] = size
    if model.startswith("gpt-image-1.5"):
        tool_config["input_fidelity"] = fidelity

    response = client.responses.create(
        model=responses_model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": _image_bytes_to_data_url(source_bytes),
                        "detail": "high",
                    },
                ],
            }
        ],
        tools=[tool_config],
        tool_choice={"type": "image_generation"},
    )
    return _extract_image_bytes_from_responses_output(response)


def _edit_image_media(source_bytes: bytes, prompt: str, size: str) -> bytes:
    client = openai_client_for_media()
    configured_model = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_MODEL", "").strip()
    fallback_model = (os.getenv("MEDIA_OPENAI_IMAGE_EDIT_FALLBACK_MODEL") or configured_model).strip()
    model = configured_model or fallback_model
    if not model:
        raise RuntimeError("image edit model is not configured; set MEDIA_OPENAI_IMAGE_EDIT_MODEL")
    compat_model = model
    normalized_source = _normalize_image_for_edit(source_bytes)
    use_responses = model.startswith("gpt-image")

    try:
        if use_responses:
            return _edit_image_media_via_responses(client, normalized_source, prompt, size, model)
        return _edit_image_media_via_images(client, normalized_source, prompt, size, model)
    except Exception as exc:
        last_exc: Exception = exc
        if (
            fallback_model
            and fallback_model != model
            and _is_unsupported_image_edit_model_error(exc)
        ):
            try:
                return _edit_image_media_via_images(client, normalized_source, prompt, size, fallback_model)
            except Exception as fallback_exc:
                last_exc = fallback_exc
                compat_model = fallback_model

        logger.warning(
            "Image edit sdk path failed for model=%s, fallback to compat /images/generations model=%s",
            model,
            compat_model,
        )
        try:
            return _edit_image_media_via_compat_endpoint(normalized_source, prompt, size, compat_model)
        except Exception as compat_exc:
            raise RuntimeError(
                f"image edit provider failed ({model}): {last_exc}. "
                f"compat /images/generations fallback failed ({compat_model}): {compat_exc}"
            ) from compat_exc


def _generate_image_bytes(prompt: str, size: str) -> bytes:
    return _generate_image_media(prompt, size)


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


def _extract_video_urls(result_data: Any) -> tuple[str | None, str | None]:
    video_url = None
    thumbnail_url = None
    if isinstance(result_data, dict):
        videos = result_data.get("videos")
        if isinstance(videos, list) and videos:
            first = videos[0]
            if isinstance(first, dict):
                video_url = _pick_url(first.get("url") or first.get("urls") or first.get("video_url"))
                thumbnail_url = _pick_url(first.get("thumbnail") or first.get("thumbnail_url") or first.get("cover"))
            elif isinstance(first, str):
                video_url = first
        if not video_url:
            video_url = _pick_url(result_data.get("video_url") or result_data.get("url") or result_data.get("urls"))
        if not thumbnail_url:
            thumbnail_url = _pick_url(result_data.get("thumbnail") or result_data.get("thumbnail_url") or result_data.get("cover"))
    return video_url, thumbnail_url


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


def _aspect_ratio_to_video_size(aspect_ratio: str | None) -> str:
    raw = (aspect_ratio or "").strip()
    if "x" in raw and raw.replace("x", "").replace(" ", "").isdigit():
        return raw
    if ":" in raw:
        try:
            left, right = raw.split(":", 1)
            w = float(left.strip())
            h = float(right.strip())
            if w >= h:
                return os.getenv("MEDIA_OPENAI_VIDEO_SIZE_LANDSCAPE", "1280x720")
            return os.getenv("MEDIA_OPENAI_VIDEO_SIZE_PORTRAIT", "720x1280")
        except Exception:
            pass
    return os.getenv("MEDIA_OPENAI_VIDEO_SIZE_LANDSCAPE", "1280x720")


def _parse_video_size(value: Any) -> tuple[int, int] | None:
    raw = str(value or "").strip().lower()
    if "x" not in raw:
        return None
    left, right = raw.split("x", 1)
    try:
        width = int(float(left.strip()))
        height = int(float(right.strip()))
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


def _normalize_video_reference_image(image_bytes: bytes, size: str) -> bytes:
    target = _parse_video_size(size)
    if not target:
        return image_bytes
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = source.copy()
    except Exception:
        return image_bytes

    target_w, target_h = target
    src_w, src_h = image.size
    if src_w <= 0 or src_h <= 0:
        return image_bytes

    # Preserve product geometry: fit inside target and letterbox instead of stretching.
    image_rgba = image if image.mode == "RGBA" else image.convert("RGBA")
    scale = min(target_w / float(src_w), target_h / float(src_h))
    resized_w = max(1, int(round(src_w * scale)))
    resized_h = max(1, int(round(src_h * scale)))
    if (resized_w, resized_h) != image_rgba.size:
        image_rgba = image_rgba.resize((resized_w, resized_h), Image.LANCZOS)

    canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
    paste_x = (target_w - resized_w) // 2
    paste_y = (target_h - resized_h) // 2
    canvas.paste(image_rgba, (paste_x, paste_y), image_rgba)

    output = io.BytesIO()
    try:
        canvas.save(output, format="PNG")
        return output.getvalue()
    except Exception:
        return image_bytes


def _to_video_bytes(blob: Any) -> bytes:
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


def _save_video_to_media(video_bytes: bytes, video_id: str) -> str:
    stamp = timezone.now().strftime("%Y/%m/%d")
    safe_id = str(video_id or uuid.uuid4().hex).replace(":", "_").replace("/", "_")
    path = f"canvex_videos/{stamp}/{safe_id}.mp4"
    saved = default_storage.save(path, ContentFile(video_bytes))
    return _abs_url(default_storage.url(saved)) or ""


def _is_sora2_model(model_name: str | None) -> bool:
    normalized = str(model_name or "").strip().lower()
    return normalized.startswith("sora-2")


def _generate_video_official(
    client: OpenAI, payload: dict[str, Any], require_reference: bool | None = None
) -> dict[str, Any]:
    model = payload.get("model") or os.getenv("MEDIA_OPENAI_VIDEO_MODEL", "sora-2-pro")
    prompt = payload.get("prompt") or ""
    seconds = _normalize_video_seconds(payload.get("duration") or payload.get("seconds") or 12)
    size = payload.get("size") or _aspect_ratio_to_video_size(payload.get("aspect_ratio"))
    image_urls = payload.get("image_urls") if isinstance(payload.get("image_urls"), list) else []
    first_url = next((u for u in image_urls if isinstance(u, str) and u.strip()), "")
    if require_reference is None:
        require_reference = _read_bool_env("MEDIA_OPENAI_VIDEO_REQUIRE_REFERENCE", False)
    if require_reference and not first_url and not _is_sora2_model(model):
        return {
            "status": "failed",
            "error": "video generation requires at least one selected image (input_reference)",
            "raw": None,
        }
    kwargs: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "seconds": seconds,
        "size": size,
    }
    if first_url:
        image_bytes = _resolve_image_bytes(first_url)
        image_bytes = _normalize_video_reference_image(image_bytes, size)
        kwargs["input_reference"] = ("input_reference.png", image_bytes, "image/png")

    def _create_with_seconds_retry(request_kwargs: dict[str, Any]):
        try:
            return client.videos.create(**request_kwargs)
        except Exception as exc:
            supported = _extract_supported_video_seconds_from_error(exc)
            if not supported:
                raise
            adjusted_seconds = _normalize_video_seconds(request_kwargs.get("seconds"), allowed_override=supported)
            if str(adjusted_seconds) == str(request_kwargs.get("seconds")):
                raise
            request_kwargs["seconds"] = adjusted_seconds
            return client.videos.create(**request_kwargs)

    created = _create_with_seconds_retry(kwargs)
    video_id = getattr(created, "id", None)
    if not video_id:
        raw_created = created.to_dict() if hasattr(created, "to_dict") else {}
        video_id = raw_created.get("id") if isinstance(raw_created, dict) else None
    if not video_id:
        raise ValueError(f"official /videos response missing id: {created}")

    max_attempts, interval = _video_poll_limits(default_attempts=120, default_interval=5)
    for _ in range(max_attempts):
        current = client.videos.retrieve(video_id)
        raw = current.to_dict() if hasattr(current, "to_dict") else {}
        status = str(getattr(current, "status", "") or raw.get("status") or "").lower()
        if _is_video_success_status(status):
            url, thumb = _extract_video_urls(raw)
            if not url:
                video_blob = client.videos.download_content(video_id)
                video_bytes = _to_video_bytes(video_blob)
                url = _save_video_to_media(video_bytes, str(video_id))
            return {
                "status": status,
                "task_id": str(video_id),
                "url": url,
                "thumbnail_url": thumb,
                "raw": raw,
            }
        if _is_video_failed_status(status):
            error = getattr(current, "error", None) or raw.get("error") or "video generation failed"
            return {
                "status": status,
                "task_id": str(video_id),
                "error": str(error),
                "raw": raw,
            }
        time.sleep(interval)

    return {"status": "timeout", "task_id": str(video_id), "error": f"Task {video_id} did not complete", "raw": None}


def _generate_video_compat(payload: dict[str, Any], require_reference: bool | None = None) -> dict[str, Any]:
    base_url = _pick_api_base() or OPENAI_DEFAULT_BASE_URL
    model = payload.get("model") or os.getenv("MEDIA_OPENAI_VIDEO_MODEL", "sora-2-pro")
    prompt = payload.get("prompt") or ""
    duration_seconds = int(_normalize_video_seconds(payload.get("duration") or payload.get("seconds") or 12))
    aspect_ratio = str(payload.get("aspect_ratio") or "").strip() or "16:9"
    size = payload.get("size") or _aspect_ratio_to_video_size(aspect_ratio)
    image_urls_raw = payload.get("image_urls") if isinstance(payload.get("image_urls"), list) else []
    image_urls = [str(item).strip() for item in image_urls_raw if isinstance(item, str) and item.strip()]
    first_url = next((u for u in image_urls if isinstance(u, str) and u.strip()), "")

    if require_reference is None:
        require_reference = _read_bool_env("MEDIA_OPENAI_VIDEO_REQUIRE_REFERENCE", False)
    if require_reference and not first_url and not _is_sora2_model(model):
        return {
            "status": "failed",
            "error": "video generation requires at least one selected image (input_reference)",
            "raw": None,
        }

    request_payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "duration": duration_seconds,
        "aspect_ratio": aspect_ratio,
    }
    if image_urls:
        request_payload["image_urls"] = image_urls
    for key in ("watermark", "thumbnail", "private", "storyboard"):
        if payload.get(key) is not None:
            request_payload[key] = bool(payload.get(key))
    for key in ("style", "character_url", "character_timestamps"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            request_payload[key] = value.strip()

    input_reference_bytes: bytes | None = None
    if first_url:
        image_bytes = _resolve_image_bytes(first_url)
        input_reference_bytes = _normalize_video_reference_image(image_bytes, size)

    try:
        created_raw = _post_videos_generations_compat(
            base_url=base_url,
            request_payload=request_payload,
            input_reference_bytes=input_reference_bytes,
            input_reference_url=first_url,
        )
    except Exception as exc:
        supported = _extract_supported_video_seconds_from_error(exc)
        if not supported:
            raise
        adjusted_seconds = int(_normalize_video_seconds(request_payload.get("duration"), allowed_override=supported))
        if adjusted_seconds == int(request_payload.get("duration", 0)):
            raise
        request_payload["duration"] = adjusted_seconds
        created_raw = _post_videos_generations_compat(
            base_url=base_url,
            request_payload=request_payload,
            input_reference_bytes=input_reference_bytes,
            input_reference_url=first_url,
        )

    status = _extract_video_status(created_raw)
    video_id = _extract_video_task_id(created_raw)
    url, thumb = _extract_video_urls(created_raw)
    if not url:
        candidate_url = _find_first_url(created_raw)
        if candidate_url and ".mp4" in candidate_url.lower():
            url = candidate_url

    if _is_video_failed_status(status):
        error = _extract_video_error_text(created_raw) or "video generation failed"
        return {
            "status": status or "failed",
            "task_id": str(video_id or ""),
            "error": error,
            "raw": created_raw,
        }

    if url and (_is_video_success_status(status) or not status):
        return {
            "status": status or "completed",
            "task_id": str(video_id or ""),
            "url": url,
            "thumbnail_url": thumb,
            "raw": created_raw,
        }

    if not video_id:
        raise ValueError(f"compat /videos/generations response missing id/url: {created_raw}")

    max_attempts, interval = _video_poll_limits(default_attempts=120, default_interval=5)
    for _ in range(max_attempts):
        current_raw = _get_video_status_via_compat(base_url, str(video_id))
        status = _extract_video_status(current_raw)
        current_url, current_thumb = _extract_video_urls(current_raw)
        if not current_url:
            candidate_url = _find_first_url(current_raw)
            if candidate_url and ".mp4" in candidate_url.lower():
                current_url = candidate_url
        if current_url and not status:
            return {
                "status": "completed",
                "task_id": str(video_id),
                "url": current_url,
                "thumbnail_url": current_thumb,
                "raw": current_raw,
            }
        if _is_video_success_status(status):
            if not current_url:
                video_bytes = _download_video_content_via_compat(base_url, str(video_id), current_raw)
                current_url = _save_video_to_media(video_bytes, str(video_id))
            return {
                "status": status,
                "task_id": str(video_id),
                "url": current_url,
                "thumbnail_url": current_thumb,
                "raw": current_raw,
            }
        if _is_video_failed_status(status):
            error = _extract_video_error_text(current_raw) or "video generation failed"
            return {
                "status": status,
                "task_id": str(video_id),
                "error": error,
                "raw": current_raw,
            }
        time.sleep(interval)

    return {"status": "timeout", "task_id": str(video_id), "error": f"Task {video_id} did not complete", "raw": None}


def _generate_video_legacy(client: OpenAI, payload: dict[str, Any]) -> dict[str, Any]:
    # Legacy fallback now uses the same official SDK flow, but relaxes reference-image requirements.
    fallback_payload = dict(payload or {})
    legacy_model = os.getenv("MEDIA_OPENAI_VIDEO_LEGACY_MODEL", "").strip()
    if legacy_model:
        fallback_payload["model"] = legacy_model
    return _generate_video_official(client, fallback_payload, require_reference=False)


def _generate_video_media(payload: dict[str, Any]) -> dict[str, Any]:
    client = openai_client_for_media()
    try:
        result = _generate_video_official(client, payload)
        if result.get("error") and not result.get("url"):
            return result
        if result.get("url"):
            return result
    except Exception as exc:
        fallback_reason = str(exc)
        if _read_bool_env("MEDIA_OPENAI_VIDEO_ENABLE_COMPAT_FALLBACK", True):
            try:
                compat_result = _generate_video_compat(payload)
                if compat_result.get("error") and not compat_result.get("url"):
                    return compat_result
                if compat_result.get("url"):
                    return compat_result
            except Exception as compat_exc:
                fallback_reason = f"{fallback_reason}; compat /videos/generations fallback failed: {compat_exc}"
        if _read_bool_env("MEDIA_OPENAI_VIDEO_ENABLE_LEGACY_FALLBACK", False):
            try:
                legacy_result = _generate_video_legacy(client, payload)
                if not legacy_result.get("url") and not legacy_result.get("error"):
                    legacy_result["error"] = fallback_reason
                return legacy_result
            except Exception as legacy_exc:
                raise RuntimeError(f"{fallback_reason}; legacy fallback failed: {legacy_exc}") from legacy_exc
        raise RuntimeError(fallback_reason) from exc
    return {"status": "failed", "error": "video generation failed"}


def _save_asset(image_bytes: bytes, prompt: str, folder_id: str | None) -> DataAsset:
    width = height = None
    try:
        with Image.open(io.BytesIO(image_bytes)) as im:
            width, height = im.size
    except Exception:
        pass

    name = f"excalidraw_ai_{uuid.uuid4().hex}.png"
    folder = DataFolder.objects.filter(id=folder_id).first() if folder_id else None
    return DataAsset.objects.create(
        folder=folder,
        file=ContentFile(image_bytes, name=name),
        filename=name,
        mime_type="image/png",
        size_bytes=len(image_bytes),
        width=width,
        height=height,
        alt_text="",
        tags=["excalidraw", "ai"],
        is_public=False,
    )


def _get_or_create_folder(name: str, parent: DataFolder | None) -> DataFolder | None:
    if not name:
        return None
    try:
        folder, _ = DataFolder.objects.get_or_create(parent=parent, name=name)
        return folder
    except IntegrityError:
        return DataFolder.objects.filter(parent=parent, name=name).first()


def _resolve_excalidraw_asset_folder_id(scene_id: str | None, scene_title: str | None = None) -> str | None:
    root = _get_or_create_folder("drawmind", None)
    project_name = (scene_title or "").strip()
    if not project_name and scene_id:
        scene = ExcalidrawScene.objects.filter(id=scene_id).only("title").first()
        project_name = (scene.title or "").strip() if scene else ""
    if not project_name:
        project_name = "Untitled"
    project_folder = _get_or_create_folder(project_name[:255], root)
    return str(project_folder.id) if project_folder else None


@tool("imagetool")
def imagetool(
    prompt: str,
    size: str = "1024x1024",
    scene_id: str | None = None,
    folder_id: str | None = None,
) -> dict[str, Any]:
    """Generate an image from prompt and save into local Data Library."""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "prompt is required"}

    if not folder_id:
        folder_id = _resolve_excalidraw_asset_folder_id(scene_id)

    try:
        image_bytes = _generate_image_bytes(prompt, size or "1024x1024")
        asset = _save_asset(image_bytes, prompt, folder_id)
    except Exception as exc:
        return {"error": str(exc)}

    return {
        "asset_id": str(asset.id),
        "scene_id": str(scene_id) if scene_id else None,
        "url": _abs_url(getattr(asset.file, "url", None)),
        "width": asset.width,
        "height": asset.height,
        "mime_type": asset.mime_type,
    }


@tool("videotool")
def videotool(
    prompt: str,
    duration: int = 12,
    aspect_ratio: str = "16:9",
    image_urls: list[str] | None = None,
    model: str | None = None,
    watermark: bool | None = None,
    thumbnail: bool | None = None,
    private: bool | None = None,
    style: str | None = None,
    storyboard: bool | None = None,
    character_url: str | None = None,
    character_timestamps: str | None = None,
    scene_id: str | None = None,
) -> dict[str, Any]:
    """Generate a video from prompt and optional source image URLs."""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "prompt is required"}

    if isinstance(image_urls, str):
        image_urls = [image_urls]
    if image_urls is not None and not isinstance(image_urls, list):
        image_urls = None

    payload: dict[str, Any] = {
        "model": model or os.getenv("MEDIA_OPENAI_VIDEO_MODEL", "sora-2-pro"),
        "prompt": prompt,
    }
    try:
        payload["duration"] = int(duration)
    except Exception:
        payload["duration"] = 12

    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    if image_urls:
        payload["image_urls"] = image_urls
    if watermark is not None:
        payload["watermark"] = bool(watermark)
    if thumbnail is not None:
        payload["thumbnail"] = bool(thumbnail)
    if private is not None:
        payload["private"] = bool(private)
    if style:
        payload["style"] = style
    if storyboard is not None:
        payload["storyboard"] = bool(storyboard)
    if character_url:
        payload["character_url"] = character_url
    if character_timestamps:
        payload["character_timestamps"] = character_timestamps

    try:
        result = _generate_video_media(payload)
    except Exception as exc:
        return {"error": str(exc)}

    if result.get("error") and not result.get("url"):
        return {"error": result.get("error"), "scene_id": str(scene_id) if scene_id else None}

    return {
        "task_id": result.get("task_id"),
        "status": result.get("status"),
        "url": result.get("url"),
        "thumbnail_url": result.get("thumbnail_url"),
        "scene_id": str(scene_id) if scene_id else None,
    }
