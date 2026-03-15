from __future__ import annotations

import io
import logging
import os
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
    _read_media_timeout_seconds,
    _resolve_image_bytes,
    _resolve_media_compat_url,
    _to_dict_compatible,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)
_IMAGE_INLINE_KEYS = ("b64_json", "image_base64", "base64", "result")

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


def _post_compat_image_request(raw_endpoint: str, payload: dict[str, Any]) -> bytes:
    endpoint = _resolve_media_compat_url(raw_endpoint)
    if not endpoint:
        raise RuntimeError("compat image endpoint is not configured")
    response = requests.post(
        endpoint,
        headers=_media_auth_headers("application/json"),
        json=payload,
        timeout=_read_media_timeout_seconds(),
    )
    if response.status_code >= 400:
        body = (response.text or "").strip()
        snippet = f"{body[:1200]}..." if len(body) > 1200 else body
        raise RuntimeError(
            f"compat image endpoint returned {response.status_code}: {snippet or 'empty response body'}"
        )
    try:
        data = response.json()
    except Exception as exc:
        raise RuntimeError(f"compat image endpoint returned invalid json: {exc}") from exc
    return _extract_image_bytes_from_generation_response(data)


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


def _generate_image_media(prompt: str, size: str) -> bytes:
    """Generate an image via the Responses API image_generation tool."""
    image_model = os.getenv("MEDIA_IMAGE_MODEL", "").strip()
    compat_endpoint = os.getenv("MEDIA_IMAGE_COMPAT_ENDPOINT", "").strip()

    if compat_endpoint:
        payload: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
        }
        if image_model:
            payload["model"] = image_model
        if size:
            payload["size"] = size
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
        payload: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
            "image": _image_bytes_to_data_url(normalized_source),
            "model": image_model,
        }
        if size:
            payload["size"] = size
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
