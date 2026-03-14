from __future__ import annotations

import io
import uuid
from typing import Any

from django.core.files.base import ContentFile
from django.db import IntegrityError
from PIL import Image

from ..models import DataAsset, DataFolder, ExcalidrawScene


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
