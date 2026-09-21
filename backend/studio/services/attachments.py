"""Persist user-uploaded canvas attachments → CDN URL (Canvex 独立版).

Used by "Send to chat" on the ImageEditBar when the selected image has no
public http(s) URL yet (locally-uploaded into Excalidraw, not pinned via
chat / generated). Browser sends the file as multipart; we land it in a
Canvex DataAsset (same lifecycle as generated images, so scene-cascade
cleanup applies) and return the absolute CDN URL the agent / image
provider can fetch.

从上游 apps/canvas/services/attachments.py port: library.Asset → DataAsset,
剥 organization/user(单工作区)。
"""
import io
import os
from typing import TYPE_CHECKING

from PIL import Image, UnidentifiedImageError

from .agent.tools.common import (
    absolute_media_url,
    get_or_create_canvas_scene_folder,
    persist_bytes_to_asset,
)

if TYPE_CHECKING:
    from studio.models import Scene

# 单张导入图的体积上限。**这是唯一一道了** —— 前端那道 10 MB 的预筛已经删掉
# (见 frontend/src/lib/upload-limits.ts 里那段墓碑注释), 所以超限现在只有这一个出口,
# 而且它会明确告诉用户超了多少。
#
# 默认给到 200 MB: 手机照片 3-12 MB、45MP 相机直出 25-40 MB、美工从 PSD 导的 PNG
# 上百兆都常见, 原来那个 20 MB 对这个项目的用户(电商卖家 / 美工)是真的会撞到的。
#
# **没有做成无上限**, 理由不是防攻击(这是个本地自托管工具, 没有别人能访问), 而是
# 手滑: 把一个几 G 的视频拖进画布时, 一句"太大了"比把内存吃干净好。要真的不限,
# 把 CANVAS_MAX_ATTACHMENT_MB 设成一个够大的数。
MAX_ATTACHMENT_BYTES = int(os.getenv("CANVAS_MAX_ATTACHMENT_MB", "200")) * 1024 * 1024


def persist_canvas_attachment(
    scene: "Scene", image_bytes: bytes, original_filename: str = ""
) -> dict:
    """Save bytes as a DataAsset and return {url, width, height}.

    Width / height come from PIL's image-header read — cheap (no full
    decode) and necessary because the frontend chip + the agent's
    SystemMessage both reference dimensions.

    On-disk / DB filename uses a fresh UUID (persist_bytes_to_asset) to avoid
    the DataAsset (folder, filename) unique collision; the original name is
    kept in DataAsset.alt_text for human inspection in admin / library UI.
    """
    if len(image_bytes) > MAX_ATTACHMENT_BYTES:
        msg = f"attachment too large ({len(image_bytes)} > {MAX_ATTACHMENT_BYTES})"
        raise ValueError(msg)

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
            # Default to png if PIL didn't recognize a format (rare).
            ext = (img.format or "png").lower()
            if ext == "jpeg":
                ext = "jpg"
    except (UnidentifiedImageError, OSError) as exc:
        # PIL raises UnidentifiedImageError (subclass of OSError) for
        # non-image bytes (text file renamed .png, corrupted upload).
        # Re-raise as ValueError so the view surfaces it as 400, not 500.
        raise ValueError(f"unrecognized image format: {exc}") from exc

    folder = get_or_create_canvas_scene_folder(scene)
    asset = persist_bytes_to_asset(
        folder=folder,
        image_bytes=image_bytes,
        display_filename=original_filename or f"canvas-attachment.{ext}",
        ext=ext,
    )
    return {
        "url": absolute_media_url(asset.file.url),
        "width": width,
        "height": height,
    }
