from __future__ import annotations

import base64
import io
import os
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


def _pick_api_base() -> str:
    return os.getenv("MEDIA_OPENAI_BASE_URL", "").rstrip("/")


def openai_client_for_media() -> OpenAI:
    api_key = _pick_api_key()
    base_url = _pick_api_base()
    if not api_key or not base_url:
        raise ValueError("MEDIA_OPENAI_BASE_URL/MEDIA_OPENAI_API_KEY is not configured")
    timeout_raw = os.getenv("MEDIA_OPENAI_TIMEOUT", "180")
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=float(timeout_raw),
    )


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


def _normalize_video_seconds(value: Any) -> str:
    allowed_raw = os.getenv("MEDIA_OPENAI_VIDEO_SECONDS_ALLOWED", "4,8,10,12,15,25")
    allowed: list[int] = []
    for item in allowed_raw.split(","):
        token = item.strip()
        if not token:
            continue
        try:
            allowed.append(int(token))
        except Exception:
            continue
    if not allowed:
        allowed = [10, 15, 25]
    allowed = sorted(set(allowed))

    default_seconds = _read_int_env("MEDIA_OPENAI_VIDEO_SECONDS_DEFAULT", 10)
    try:
        requested = int(value)
    except Exception:
        requested = default_seconds

    if requested in allowed:
        return str(requested)

    nearest = min(allowed, key=lambda item: abs(item - requested))
    return str(nearest)


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


def _as_dict(payload: Any, context: str) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    raise ValueError(f"{context} response is not an object: {payload}")


def _poll_media_task(client: OpenAI, task_id: str, max_attempts: int = 60, interval: int = 2) -> str:
    for _ in range(max_attempts):
        payload = _as_dict(client.get(f"/tasks/{task_id}", cast_to=object), "task status")
        data = payload.get("data") or {}
        status = str(data.get("status") or "").lower()

        if status in {"completed", "success"}:
            result = data.get("result") or {}
            if isinstance(result, dict):
                videos = result.get("videos")
                if isinstance(videos, list) and videos:
                    first = videos[0]
                    if isinstance(first, dict):
                        url = _pick_url(first.get("url") or first.get("urls") or first.get("video_url"))
                        if url:
                            return url
                images = result.get("images")
                if isinstance(images, list) and images:
                    first = images[0]
                    if isinstance(first, dict):
                        url = _pick_url(first.get("url") or first.get("urls")) or _find_first_url(first)
                        if url:
                            return url
            url = _pick_url(result.get("url") or result.get("urls")) if isinstance(result, dict) else None
            if url:
                return url
            fallback = _find_first_url(result) or _find_first_url(data)
            if fallback:
                return fallback
            raise ValueError(f"Task completed but no url found: {payload}")

        if status in {"failed", "error"}:
            msg = data.get("error") or data.get("message") or "Unknown error"
            raise ValueError(f"media task failed: {msg}")

        time.sleep(interval)

    raise TimeoutError(f"Task {task_id} did not complete in time")


def _extract_media_data_item(body: dict[str, Any]) -> dict[str, Any]:
    data = body.get("data")
    if isinstance(data, list) and data:
        item = data[0]
    elif isinstance(data, dict):
        item = data
    else:
        item = None
    if not isinstance(item, dict):
        raise ValueError(f"media response missing data: {body}")
    return item


def _resolve_media_image_item(client: OpenAI, item: dict[str, Any]) -> bytes:
    image_url = _pick_url(item.get("url") or item.get("urls"))
    if not image_url:
        images = item.get("images")
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, dict):
                image_url = _pick_url(first.get("url") or first.get("urls")) or _find_first_url(first)

    if image_url:
        return _resolve_image_bytes(image_url)

    task_id = item.get("task_id") or item.get("id")
    if not task_id:
        raise ValueError(f"media task_id missing: {item}")

    result_url = _poll_media_task(client, str(task_id), max_attempts=120, interval=2)
    if not result_url:
        raise ValueError("media task completed but no url found")
    return _resolve_image_bytes(result_url)


def _generate_image_media(prompt: str, size: str) -> bytes:
    client = openai_client_for_media()
    payload = {
        "model": os.getenv("MEDIA_OPENAI_IMAGE_MODEL", ""),
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    body = _as_dict(client.post("/images/generations", cast_to=object, body=payload), "images/generations")
    item = _extract_media_data_item(body)
    return _resolve_media_image_item(client, item)


def _extract_image_bytes_from_openai_response(response: Any) -> bytes:
    data_items = list(getattr(response, "data", []) or [])
    if not data_items:
        raise ValueError("empty image response")
    image_data = data_items[0]
    b64_json = getattr(image_data, "b64_json", None)
    if isinstance(b64_json, str) and b64_json:
        return base64.b64decode(b64_json)
    image_url = getattr(image_data, "url", None)
    if isinstance(image_url, str) and image_url:
        return _resolve_image_bytes(image_url)
    raise ValueError("empty image response")


def _edit_image_media(source_bytes: bytes, prompt: str, size: str) -> bytes:
    client = openai_client_for_media()
    model = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_MODEL", "")
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


def _poll_media_video_task(client: OpenAI, task_id: str, max_attempts: int = 120, interval: int = 5) -> dict[str, Any]:
    for _ in range(max_attempts):
        payload = _as_dict(client.get(f"/tasks/{task_id}", cast_to=object), "task status")
        data = payload.get("data") or {}
        status = str(data.get("status") or "").lower()

        if status in {"completed", "success"}:
            result_data = data.get("result") or {}
            url, thumb = _extract_video_urls(result_data)
            if not url:
                url = _find_first_url(result_data) or _find_first_url(data)
            return {"status": status, "url": url, "thumbnail_url": thumb, "raw": data}

        if status in {"failed", "error"}:
            msg = data.get("error") or data.get("message") or "Unknown error"
            return {"status": status, "error": msg, "raw": data}

        time.sleep(interval)

    return {"status": "timeout", "error": f"Task {task_id} did not complete", "raw": None}


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


def _generate_video_official(client: OpenAI, payload: dict[str, Any]) -> dict[str, Any]:
    model = payload.get("model") or os.getenv("MEDIA_OPENAI_VIDEO_MODEL", "sora-2-pro")
    prompt = payload.get("prompt") or ""
    seconds = _normalize_video_seconds(payload.get("duration") or payload.get("seconds") or 10)
    size = payload.get("size") or _aspect_ratio_to_video_size(payload.get("aspect_ratio"))
    image_urls = payload.get("image_urls") if isinstance(payload.get("image_urls"), list) else []
    first_url = next((u for u in image_urls if isinstance(u, str) and u.strip()), "")
    require_reference = _read_bool_env("MEDIA_OPENAI_VIDEO_REQUIRE_REFERENCE", True)
    if require_reference and not first_url:
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
        kwargs["input_reference"] = ("input_reference.png", image_bytes, "image/png")

    created = client.videos.create(**kwargs)
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
        if status in {"completed", "succeeded", "success"}:
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
        if status in {"failed", "error", "cancelled", "canceled"}:
            error = getattr(current, "error", None) or raw.get("error") or "video generation failed"
            return {
                "status": status,
                "task_id": str(video_id),
                "error": str(error),
                "raw": raw,
            }
        time.sleep(interval)

    return {"status": "timeout", "task_id": str(video_id), "error": f"Task {video_id} did not complete", "raw": None}


def _generate_video_legacy(client: OpenAI, payload: dict[str, Any]) -> dict[str, Any]:
    body = _as_dict(client.post("/videos/generations", cast_to=object, body=payload), "videos/generations")
    data = body.get("data")
    if isinstance(data, list) and data:
        item = data[0]
    elif isinstance(data, dict):
        item = data
    else:
        raise ValueError(f"Unexpected legacy media response: {body}")

    task_id = item.get("task_id") or item.get("id")
    if not task_id:
        raise ValueError("task_id missing in legacy media response")

    max_attempts, interval = _video_poll_limits(default_attempts=120, default_interval=5)
    polled = _poll_media_video_task(client, task_id, max_attempts=max_attempts, interval=interval)
    polled["task_id"] = task_id
    if polled.get("error") and not polled.get("url"):
        return polled
    if not polled.get("url"):
        polled["error"] = "Provider returned no video url"
    return polled


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
    duration: int = 15,
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
        payload["duration"] = 15

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
