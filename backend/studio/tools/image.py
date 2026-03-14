from __future__ import annotations

import io
import logging
import os
from typing import Any

from langchain_core.tools import tool
from PIL import Image

from .assets import _resolve_excalidraw_asset_folder_id, _save_asset
from .common import (
    _IMAGE_B64_KEYS,
    _abs_url,
    _decode_image_base64,
    _extract_inline_image_bytes,
    _image_bytes_to_data_url,
    _pick_url,
    _resolve_image_bytes,
    _to_dict_compatible,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)


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

    response = client.images.generate(**kwargs)
    return _extract_image_bytes_from_openai_response(response)


def _edit_image_media_via_images(client, source_bytes: bytes, prompt: str, size: str, model: str) -> bytes:
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


def _edit_image_media_via_responses(client, source_bytes: bytes, prompt: str, size: str, model: str) -> bytes:
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
    model = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_MODEL", "").strip()
    if not model:
        raise RuntimeError("image edit model is not configured; set MEDIA_OPENAI_IMAGE_EDIT_MODEL")

    normalized_source = _normalize_image_for_edit(source_bytes)

    if model.startswith("gpt-image"):
        return _edit_image_media_via_responses(client, normalized_source, prompt, size, model)
    return _edit_image_media_via_images(client, normalized_source, prompt, size, model)


def _generate_image_bytes(prompt: str, size: str) -> bytes:
    return _generate_image_media(prompt, size)


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
