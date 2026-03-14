from __future__ import annotations

import io
import logging
import os
from typing import Any

from langchain_core.tools import tool
from PIL import Image

from .assets import _resolve_excalidraw_asset_folder_id, _save_asset
from .common import (
    _abs_url,
    _decode_image_base64,
    _image_bytes_to_data_url,
    _to_dict_compatible,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)

_DEFAULT_RESPONSES_MODEL = "gpt-4o-mini"


def _responses_model() -> str:
    return (
        os.getenv("MEDIA_OPENAI_RESPONSES_MODEL", "").strip()
        or os.getenv("EXCALIDRAW_CHAT_MODEL", "").strip()
        or _DEFAULT_RESPONSES_MODEL
    )


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
    client = openai_client_for_media()
    image_model = os.getenv("MEDIA_OPENAI_IMAGE_MODEL", "").strip()

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
    client = openai_client_for_media()
    image_model = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_MODEL", "").strip()
    if not image_model:
        raise RuntimeError("image edit model is not configured; set MEDIA_OPENAI_IMAGE_EDIT_MODEL")

    normalized_source = _normalize_image_for_edit(source_bytes)

    fidelity = os.getenv("MEDIA_OPENAI_IMAGE_EDIT_INPUT_FIDELITY", "high").strip().lower()
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
