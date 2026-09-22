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
import math
from typing import TYPE_CHECKING

from django.conf import settings
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
#
# 数字本身在 config/settings.py 的 "Upload guards" 那一段 (CANVAS_MAX_ATTACHMENT_BYTES,
# 由 CANVAS_MAX_ATTACHMENT_MB 调)。放那边而不是在这里 os.getenv: 上传相关的另外两个旋钮
# (DATA_UPLOAD / FILE_UPLOAD_MAX_MEMORY_SIZE) 就在那一段, 三个数摆在一起才看得出有没有打架;
# 而且那边的 _as_int 会把 `CANVAS_MAX_ATTACHMENT_MB=` (留空) 这种写法兜住 —— 裸 int("") 会在
# import 期抛 ValueError, 把 web 和三个 worker 一起拖死。
MAX_ATTACHMENT_BYTES = getattr(settings, "CANVAS_MAX_ATTACHMENT_BYTES", 200 * 1024 * 1024)


def _mb(num_bytes: int) -> str:
    """按 MB 显示, 小数位向上取整 —— 只超出几个字节时, 四舍五入会印成自相矛盾的
    "200 MB (limit 200 MB)"。"""
    return f"{math.ceil(num_bytes / (1024 * 1024) * 10) / 10:.1f}".removesuffix(".0")


def attachment_too_large_message(size_bytes: int) -> str:
    """超限时给用户看的那一句。视图(按 Content-Length 预检)和下面的兜底检查共用一份,
    免得两处文案各写各的。按 MB 说 —— 前端 toast 直接显示它, 而原来印的是两串裸字节数,
    用户得自己除一遍才知道超了多少。"""
    return (
        f"attachment too large: {_mb(size_bytes)} MB "
        f"(limit {_mb(MAX_ATTACHMENT_BYTES)} MB, raise CANVAS_MAX_ATTACHMENT_MB)"
    )


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
        raise ValueError(attachment_too_large_message(len(image_bytes)))

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
            # Default to png if PIL didn't recognize a format (rare).
            ext = (img.format or "png").lower()
            if ext == "jpeg":
                ext = "jpg"
    except Image.DecompressionBombError as exc:
        # 注意 DecompressionBombError 直接继承 Exception, **不是** OSError, 所以下面那条
        # except 抓不到它 —— 漏出去就是 500。原来 20 MB 的上限顺带让它几乎不可能发生
        # (PIL 默认 89.5 MP, 超过 2 倍才抛), 上限抬到 200 MB 之后, 美工从 PSD 导的大图
        # (比如 15000×12000 = 180 MP) 就真的会撞上, 必须在这里翻译成 400。
        # 想让这类图能进来, 得有意识地调 PIL 的 Image.MAX_IMAGE_PIXELS —— 那是另一件事:
        # 后面的抠图 / 压平是会真解码的, 放开之前要先想清楚内存。
        raise ValueError(f"image has too many pixels to decode safely: {exc}") from exc
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
