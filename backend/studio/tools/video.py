from __future__ import annotations

import io
import logging
import os
import re
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
    OPENAI_DEFAULT_BASE_URL,
    _abs_url,
    _find_first_url,
    _image_bytes_to_data_url,
    _pick_api_base,
    _pick_api_key,
    _pick_url,
    _read_bool_env,
    _read_int_env,
    _read_media_timeout_seconds,
    _resolve_image_bytes,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)

_VIDEO_SUCCESS_STATUSES = {"completed", "succeeded", "success"}
_VIDEO_FAILED_STATUSES = {"failed", "error", "cancelled", "canceled"}


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


def _is_video_success_status(status: str) -> bool:
    return str(status or "").strip().lower() in _VIDEO_SUCCESS_STATUSES


def _is_video_failed_status(status: str) -> bool:
    return str(status or "").strip().lower() in _VIDEO_FAILED_STATUSES


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


def _looks_like_mp4(blob: bytes) -> bool:
    if len(blob) < 12:
        return False
    return blob[4:8] == b"ftyp"


def _is_sora2_model(model_name: str | None) -> bool:
    normalized = str(model_name or "").strip().lower()
    return normalized.startswith("sora-2")


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


def _generate_video_official(
    client, payload: dict[str, Any], require_reference: bool | None = None
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


def _generate_video_legacy(client, payload: dict[str, Any]) -> dict[str, Any]:
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
        logger.warning("videotool received image_urls as a string instead of list; wrapping automatically")
        image_urls = [image_urls]
    if image_urls is not None and not isinstance(image_urls, list):
        logger.warning("videotool received image_urls as %s; ignoring", type(image_urls).__name__)
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
