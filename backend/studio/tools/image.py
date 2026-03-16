from __future__ import annotations

import io
import logging
import os
import time
from typing import Any

import requests
from langchain_core.tools import tool
from PIL import Image

from .assets import _resolve_excalidraw_asset_folder_id, _save_asset
from .common import (
    _abs_url,
    _decode_image_base64,
    _image_bytes_to_data_url,
    _media_auth_headers,
    _read_int_env,
    _read_media_timeout_seconds,
    _resolve_image_bytes,
    _resolve_media_compat_url,
    _to_dict_compatible,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)
_IMAGE_INLINE_KEYS = ("b64_json", "image_base64", "base64", "result")

_IMAGE_DONE_STATUSES = {"completed", "succeeded", "success"}
_IMAGE_FAILED_STATUSES = {"failed", "failure", "error", "cancelled", "canceled"}


# ---------------------------------------------------------------------------
# Responses API helpers
# ---------------------------------------------------------------------------

def _responses_model() -> str:
    model = os.getenv("MEDIA_RESPONSES_MODEL", "").strip()
    if not model:
        raise RuntimeError("MEDIA_RESPONSES_MODEL is not configured")
    return model


def _extract_image_bytes_from_responses_output(response: Any) -> bytes:
    """Extract the first image_generation_call result from a Responses API output."""
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


# ---------------------------------------------------------------------------
# Compat image helpers  (synchronous fallback kept for providers that return
# image data directly in the creation response)
# ---------------------------------------------------------------------------

def _extract_image_bytes_from_generation_response(response: Any) -> bytes:
    raw_items: Any = None
    if isinstance(response, dict):
        raw_items = response.get("data")
    else:
        raw_items = getattr(response, "data", None)

    if isinstance(raw_items, (list, tuple)):
        items = list(raw_items)
    elif raw_items:
        items = [raw_items]
    else:
        items = []

    if not items:
        raise ValueError("empty image response")

    for item in items:
        item_dict = _to_dict_compatible(item)
        for key in _IMAGE_INLINE_KEYS:
            value = item_dict.get(key) if item_dict else getattr(item, key, None)
            if not isinstance(value, str) or not value.strip():
                continue
            token = value.strip()
            if token.startswith(("http://", "https://")):
                return _resolve_image_bytes(token)
            try:
                return _decode_image_base64(token)
            except Exception:
                continue

        image_url = item_dict.get("url") if item_dict else getattr(item, "url", None)
        if isinstance(image_url, str) and image_url.strip():
            return _resolve_image_bytes(image_url.strip())

    raise ValueError("image response missing usable image payload")


# ---------------------------------------------------------------------------
# Compat async polling helpers  (mirrors video.py pattern)
# ---------------------------------------------------------------------------

def _image_poll_limits(
    default_attempts: int = 200,
    default_interval: int = 3,
) -> tuple[int, float]:
    max_attempts = _read_int_env("MEDIA_IMAGE_POLL_MAX_ATTEMPTS", default_attempts)
    interval = _read_int_env("MEDIA_IMAGE_POLL_INTERVAL", default_interval)
    return max(1, max_attempts), max(1, interval)


def _compat_image_id(value: Any) -> str:
    """Extract task / job id from compat creation response."""
    if isinstance(value, dict):
        # Handle wrapped: {"code": 200, "data": [{"task_id": "..."}]}
        data = value.get("data")
        if isinstance(data, list) and data:
            value = data[0] if isinstance(data[0], dict) else value
        if isinstance(value, dict):
            for key in ("id", "task_id", "job_id", "image_id"):
                token = value.get(key)
                if token is not None and str(token).strip():
                    return str(token).strip()
    return str(value or "").strip()


def _compat_image_status(value: Any) -> str:
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, dict) and "status" in data:
            value = data
        for key in ("status", "state", "phase"):
            token = value.get(key)
            if token is not None and str(token).strip():
                return str(token).strip().lower()
    return str(value or "").strip().lower()


def _compat_image_error(value: Any) -> str:
    if isinstance(value, dict):
        data = value.get("data")
        if isinstance(data, dict):
            fail_reason = data.get("fail_reason")
            if fail_reason is not None and str(fail_reason).strip():
                return str(fail_reason).strip()

        error = value.get("error")
        if isinstance(error, dict):
            for key in ("message", "detail", "error"):
                token = error.get(key)
                if token is not None and str(token).strip():
                    return str(token).strip()
        elif error is not None and str(error).strip():
            return str(error).strip()
        for key in ("message", "detail", "fail_reason"):
            token = value.get(key)
            if token is not None and str(token).strip():
                return str(token).strip()
    return str(value or "").strip()


def _extract_compat_image_url(value: Any) -> str:
    """Extract image download URL from poll response data."""
    if not isinstance(value, dict):
        return ""
    data = value.get("data")
    if isinstance(data, dict):
        # Direct URL keys
        for key in ("url", "image_url", "download_url", "result_url"):
            token = data.get(key)
            if token and isinstance(token, str) and token.startswith("http"):
                return token.strip()
        # Nested: data.result.images[].url[] (apimart format)
        result = data.get("result")
        if isinstance(result, dict):
            images = result.get("images")
            if isinstance(images, list) and images:
                first = images[0]
                if isinstance(first, dict):
                    url_val = first.get("url")
                    if isinstance(url_val, list) and url_val:
                        for u in url_val:
                            if isinstance(u, str) and u.startswith("http"):
                                return u.strip()
                    elif isinstance(url_val, str) and url_val.startswith("http"):
                        return url_val.strip()
        # Flat image_urls list
        image_urls = data.get("image_urls")
        if isinstance(image_urls, list):
            for u in image_urls:
                if isinstance(u, str) and u.startswith("http"):
                    return u.strip()
    return ""


def _parse_compat_image_json(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        data = response.json()
    except Exception as exc:
        raise RuntimeError(f"compat image {action} returned invalid json: {exc}") from exc
    if response.status_code >= 400:
        detail = _compat_image_error(data)
        raise RuntimeError(
            detail or f"compat image {action} returned {response.status_code}"
        )
    return data if isinstance(data, dict) else {"data": data}


def _wait_for_compat_image(raw_endpoint: str, task_id: str) -> dict[str, Any]:
    poll_endpoint = os.getenv("MEDIA_IMAGE_COMPAT_POLL_ENDPOINT", "").strip() or raw_endpoint
    status_url = _resolve_media_compat_url(poll_endpoint, task_id)
    if not status_url:
        raise RuntimeError("compat image endpoint is not configured")
    max_attempts, interval = _image_poll_limits()
    for attempt in range(max_attempts):
        response = requests.get(
            status_url,
            headers=_media_auth_headers(),
            timeout=_read_media_timeout_seconds(),
        )
        data = _parse_compat_image_json(response, "status")
        status = _compat_image_status(data)
        logger.info(
            "compat image poll [%d/%d]: status=%s",
            attempt + 1, max_attempts, status,
        )
        if status in _IMAGE_DONE_STATUSES or status in _IMAGE_FAILED_STATUSES:
            return data
        time.sleep(interval)
    raise TimeoutError(f"Image task {task_id} did not complete")


# ---------------------------------------------------------------------------
# Compat image request  (supports both sync and async providers)
# ---------------------------------------------------------------------------

def _post_compat_image_request(raw_endpoint: str, payload: dict[str, Any]) -> bytes:
    endpoint = _resolve_media_compat_url(raw_endpoint)
    if not endpoint:
        raise RuntimeError("compat image endpoint is not configured")

    logger.info(
        "compat image create: endpoint=%s, model=%s, has_image=%s",
        endpoint,
        payload.get("model", ""),
        any(k in payload for k in ("image_urls", "image")),
    )
    response = requests.post(
        endpoint,
        headers=_media_auth_headers("application/json"),
        json=payload,
        timeout=_read_media_timeout_seconds(),
    )
    logger.info(
        "compat image response: status=%s, body=%s",
        response.status_code, (response.text or "")[:500],
    )

    created = _parse_compat_image_json(response, "create")

    # --- Try sync extraction first (provider returns image data directly) ---
    try:
        return _extract_image_bytes_from_generation_response(created)
    except (ValueError, KeyError):
        pass  # Not a sync response, fall through to async polling

    # --- Async: extract task_id → poll → download ---
    task_id = _compat_image_id(created)
    if not task_id:
        raise ValueError("compat image response missing task id and image data")

    logger.info("compat image async: task_id=%s, starting poll", task_id)
    result = _wait_for_compat_image(raw_endpoint, task_id)
    status = _compat_image_status(result)

    if status in _IMAGE_DONE_STATUSES:
        image_url = _extract_compat_image_url(result)
        if image_url:
            logger.info("compat image done: downloading from %s", image_url[:200])
            return _resolve_image_bytes(image_url)
        # Try extracting inline image data from final poll response
        try:
            return _extract_image_bytes_from_generation_response(result)
        except (ValueError, KeyError):
            pass
        raise RuntimeError("image task completed but no image URL or data found")

    error_msg = _compat_image_error(result) or "image generation failed"
    raise RuntimeError(f"image generation failed: {error_msg}")


# ---------------------------------------------------------------------------
# Image normalization for edit
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Public generation / edit entry points
# ---------------------------------------------------------------------------

def _generate_image_media(prompt: str, size: str) -> bytes:
    """Generate an image via the Responses API image_generation tool."""
    image_model = os.getenv("MEDIA_IMAGE_MODEL", "").strip()
    compat_endpoint = os.getenv("MEDIA_IMAGE_COMPAT_ENDPOINT", "").strip()

    if compat_endpoint:
        size_field = os.getenv("MEDIA_IMAGE_COMPAT_SIZE_FIELD", "size").strip() or "size"

        payload: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
        }
        if image_model:
            payload["model"] = image_model
        if size:
            payload[size_field] = size
        return _post_compat_image_request(compat_endpoint, payload)

    client = openai_client_for_media()

    tool_config: dict[str, Any] = {
        "type": "image_generation",
        "output_format": "png",
        "quality": "high",
    }
    if image_model:
        tool_config["model"] = image_model
    if size:
        tool_config["size"] = size

    response = client.responses.create(
        model=_responses_model(),
        input=prompt,
        tools=[tool_config],
        tool_choice={"type": "image_generation"},
    )
    return _extract_image_bytes_from_responses_output(response)


def _edit_image_media(source_bytes: bytes, prompt: str, size: str) -> bytes:
    """Edit an image via the Responses API image_generation tool with action='edit'."""
    image_model = os.getenv("MEDIA_IMAGE_EDIT_MODEL", "").strip()
    if not image_model:
        raise RuntimeError("image edit model is not configured; set MEDIA_IMAGE_EDIT_MODEL")

    normalized_source = _normalize_image_for_edit(source_bytes)
    compat_endpoint = os.getenv("MEDIA_IMAGE_EDIT_COMPAT_ENDPOINT", "").strip()

    if compat_endpoint:
        image_field = os.getenv("MEDIA_IMAGE_EDIT_COMPAT_IMAGE_FIELD", "image_urls").strip() or "image_urls"
        size_field = os.getenv("MEDIA_IMAGE_EDIT_COMPAT_SIZE_FIELD", "size").strip() or "size"

        data_url = _image_bytes_to_data_url(normalized_source)
        payload: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
            "model": image_model,
            image_field: [data_url] if "urls" in image_field else data_url,
        }
        if size:
            payload[size_field] = size
        return _post_compat_image_request(compat_endpoint, payload)

    client = openai_client_for_media()

    fidelity = os.getenv("MEDIA_IMAGE_EDIT_INPUT_FIDELITY", "high").strip().lower()
    if fidelity not in {"high", "low"}:
        fidelity = "high"

    tool_config: dict[str, Any] = {
        "type": "image_generation",
        "action": "edit",
        "model": image_model,
        "output_format": "png",
        "quality": "high",
    }
    if size:
        tool_config["size"] = size
    if image_model.startswith("gpt-image-1.5"):
        tool_config["input_fidelity"] = fidelity

    response = client.responses.create(
        model=_responses_model(),
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": _image_bytes_to_data_url(normalized_source),
                        "detail": "high",
                    },
                ],
            }
        ],
        tools=[tool_config],
        tool_choice={"type": "image_generation"},
    )
    return _extract_image_bytes_from_responses_output(response)


# ---------------------------------------------------------------------------
# LangChain tool
# ---------------------------------------------------------------------------

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
        image_bytes = _generate_image_media(prompt, size or "1024x1024")
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
