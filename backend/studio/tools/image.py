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
    OPENAI_DEFAULT_BASE_URL,
    _IMAGE_B64_KEYS,
    _abs_url,
    _decode_image_base64,
    _extract_inline_image_bytes,
    _image_bytes_to_data_url,
    _pick_api_base,
    _pick_api_key,
    _pick_url,
    _read_media_timeout_seconds,
    _resolve_image_bytes,
    _to_dict_compatible,
    openai_client_for_media,
)

logger = logging.getLogger(__name__)


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
    endpoint = _images_generations_compat_endpoint(base_url)

    headers = {"Authorization": f"Bearer {api_key}"}
    kwargs: dict[str, Any] = {
        "headers": headers,
        "timeout": _read_media_timeout_seconds(),
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

    try:
        response = client.images.generate(**kwargs)
    except Exception as exc:
        if "response_format" in str(exc).lower() and "response_format" in kwargs:
            kwargs.pop("response_format", None)
            response = client.images.generate(**kwargs)
        else:
            raise
    return _extract_image_bytes_from_openai_response(response)


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
