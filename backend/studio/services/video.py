"""Video-job creation service.

从 meired apps/canvas/services/video.py port (Canvex 独立版):
- 剥 organization / user(单工作区)→ create 不再 set,签名去掉,save_canvas_source_image
  不再传 user。
- billing.reserve 调用保留(stub 空操作),只改 import 路径到 .billing(studio.services.billing)。
"""
import logging

from django.core.files.storage import default_storage
from django.db import transaction
from rest_framework.exceptions import ValidationError

from ..models import VideoJob
from . import save_canvas_source_image
from .agent.tools.common import absolute_media_url, is_public_http_url, our_media_relpath
from .billing import reserve as reserve_canvas_credit

logger = logging.getLogger(__name__)


def create_video_job(*, scene, validated, image_file=None):
    """Validated payload (+ optional uploaded file) → QUEUED VideoJob + reserve credit.

    image_urls 可能是相对 `/media/...`, 这里统一成绝对地址存进行里。**这个地址不是给
    供应商的** —— 源图在提交那一刻由 `source_for_channel` 变成这条通道收得下的形状
    (内联 / 上传), 见 run_video_job。`is_public_http_url` 在这儿的职责是 SSRF 过滤:
    挡掉指向私网的**外部** URL, 我们自己的 media 由 `our_media_relpath` 那半边放行。
    跟 agent tool `enqueue_video_generation` 对称.

    Reserve 在 Canvex 是 no-op(免费);保留调用对齐 meired 契约。
    """
    prompt = validated["prompt"].strip()
    raw_urls = [u for u in validated["image_urls"] if u.strip()]
    if image_file is not None:
        # `default_storage.url(...)` adds the MEDIA_URL prefix that nginx serves
        # storage at; without it provider gets a URL minus `/media/` and 404s.
        raw_urls.append(default_storage.url(save_canvas_source_image(image_file)))
    absolute_urls = [absolute_media_url(u) for u in raw_urls]
    # Keep our-own media (inlined from storage at submit, no public URL needed)
    # plus genuinely-public external URLs; drop only non-public external (SSRF).
    image_urls = [u for u in absolute_urls if our_media_relpath(u) is not None or is_public_http_url(u)]
    rejected = [u for u in absolute_urls if u not in image_urls]
    if rejected:
        logger.warning(
            "create_video_job: rejected non-public URLs for scene %s: %s",
            scene.id, rejected,
        )
    aspect_ratio = validated["aspect_ratio"].strip() or "16:9"

    if not prompt and not image_urls:
        raise ValidationError(
            {"prompt": ["prompt is required when no image is provided."]}
        )

    with transaction.atomic():
        job = VideoJob.objects.create(
            scene=scene,
            # Empty prompt with reference images: provider infers motion from imagery.
            prompt=prompt or "(script inferred from reference images)",
            image_urls=image_urls,
            duration=validated["duration"],
            aspect_ratio=aspect_ratio,
            resolution=(validated.get("resolution") or "").strip(),
            # Video tab 选的通道。异步路径 —— 请求早就返回了, worker 之后才捞这行去长轮询,
            # 所以选择必须落在行上而不是留在请求里。None = 没选 → 退到库里第一条 video 通道。
            image_model=validated.get("image_model"),
            status=VideoJob.Status.QUEUED,
        )
        reserve_canvas_credit(job)
    return job
