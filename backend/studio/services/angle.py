"""Angle job: image camera-angle rerender via fal.ai Qwen-Image-Edit-2511-LoRA.

从 meired apps/canvas/services/angle.py port (Canvex 独立版):
- 剥 organization / user(单工作区)→ create 不再 set,签名去掉,save_canvas_source_image
  不再传 user。
- 外部基建 import 改写:apps.common.http_retry → studio.services.http_retry。
- billing.reserve 调用保留(stub 空操作),改 import 到 .billing。

两层职责:
- `create_angle_job(...)` — POST /scenes/<id>/angle/ 走这里, 把相对 /media URL
  过一遍 absolute_media_url + is_public_http_url (外部 provider 要能 GET 到,
  同时挡掉私网 IP), 落 QUEUED 行.
- `run_angle_job(job)` — Celery worker 跑的 executor, 和 image.py/video.py 模式
  一致: job_lifecycle 管 status 翻转 + error 持久化, IO 在 `_submit` +
  `_download_result_images`.

**Provider 选型**: fal.run (sync endpoint), 单次 POST 阻塞 15-30s. 不用 queue API +
polling 是因为 LoRA 推理够短, sync 体感更简单 (错误模型比 "提交 task_id → 轮询
status → 拉结果" 三段少一跳). 若 timeout, 换成 queue.fal.run 再说.

**鉴权**: fal 用 `Authorization: Key <key>`, 不是 Bearer.
"""
import logging
from typing import Iterable

import requests
from django.conf import settings
from django.core.files.storage import default_storage
from django.db import transaction
from rest_framework.exceptions import ValidationError

from studio.services.http_retry import make_retry_session

from ..models import AngleJob, AngleResult, ImageProvider
from . import save_canvas_source_image
from .image_channels import channel_for_model_id, default_channel
from .image_client import ImageChannel
from .agent.tools.common import (
    DOWNLOAD_TIMEOUT,
    absolute_media_url,
    assert_source_url_reachable,
    is_public_http_url,
    job_lifecycle,
    our_media_relpath,
    persist_canvas_image_results,
    source_to_inline_uri,
)
from .billing import reserve as reserve_canvas_credit

# Module-level Session: fal.ai 偶尔抖, retry transient 5xx/429. lazy 创建复用 TCP.
_session = make_retry_session()

logger = logging.getLogger(__name__)


def resolve_angle_channel(job: AngleJob) -> ImageChannel:
    """这次 angle 调用用哪套配置。四级降级, 跟生图路径同一套顺序:

    1. job 行上选的通道 (用户在 Angle tab 里挑的)
    2. 库里第一条启用的 angle 通道 —— 「后端默认」的实际含义
    3. `CANVAS_ANGLE_FAL_*` env —— 0010 迁移只在库里没有 angle 供应商时导一次,
       导完用户可以把它删掉; 删干净了还想用 env 就得靠这条
    4. 都没有 → 抛, 由 job_lifecycle 落成 FAILED

    复用 ImageChannel 而不是给 angle 单开一个 dataclass: 这里只用得上它的 base_url /
    api_key / model / timeout / label 五个字段, 为剩下的十几个用不上的字段再造一个平行
    类型, 换来的只是"字段更少"。请求体的差异在 `_submit` 里, 不在配置形状里。
    """
    channel = channel_for_model_id(job.image_model_id, ImageProvider.Kind.ANGLE)
    if channel is None:
        channel = default_channel(ImageProvider.Kind.ANGLE)
    if channel is not None:
        return channel

    api_key = (settings.CANVAS_ANGLE_FAL_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError(
            "还没有配置 Angle 供应商 —— 在生图设置里加一个 Angle 通道, "
            "或设置 CANVAS_ANGLE_FAL_API_KEY"
        )
    return ImageChannel(
        base_url=(settings.CANVAS_ANGLE_FAL_BASE_URL or "https://fal.run").rstrip("/"),
        api_key=api_key,
        model=settings.CANVAS_ANGLE_FAL_MODEL,
        label="Angle (env)",
        timeout=settings.CANVAS_ANGLE_FAL_TIMEOUT,
    )


# ---------------------------------------------------------------------------
# Create (enqueue) path
# ---------------------------------------------------------------------------

def create_angle_job(*, scene, validated, image_file=None) -> AngleJob:
    """Validated payload (+ optional uploaded file) → QUEUED AngleJob.

    SSRF filter applies whether the URL came from `image_url` or a freshly
    saved upload. 400 on rejection — Angle has no prompt-only fallback.

    Reserve 在 Canvex 是 no-op(免费);保留调用对齐 meired 契约。
    """
    if image_file is not None:
        relative = save_canvas_source_image(image_file)
        # default_storage.url() prepends MEDIA_URL (`/media/...`); without it
        # absolute_media_url's urljoin lands on PUBLIC_MEDIA_BASE without the
        # prefix nginx serves storage from, and provider GET 404s.
        absolute = absolute_media_url(default_storage.url(relative))
    else:
        absolute = absolute_media_url(validated["image_url"].strip())

    # Our-own media is inlined from storage at submit (works even when the public
    # URL isn't reachable — e.g. localhost dev with no tunnel), so only block
    # non-public EXTERNAL URLs (SSRF). External public URLs still pass straight
    # to the provider.
    if our_media_relpath(absolute) is None and not is_public_http_url(absolute):
        logger.warning(
            "create_angle_job: rejected non-public URL for scene %s: %s",
            scene.id, absolute,
        )
        raise ValidationError(
            {"image_url": ["image_url must resolve to a public http(s) URL."]}
        )

    with transaction.atomic():
        job = AngleJob.objects.create(
            scene=scene,
            source_image_url=absolute,
            horizontal_angle=validated["horizontal_angle"],
            vertical_angle=validated["vertical_angle"],
            zoom=validated["zoom"],
            additional_prompt=validated["additional_prompt"].strip(),
            num_images=validated["num_images"],
            image_model=validated["image_model"],
            status=AngleJob.Status.QUEUED,
        )
        reserve_canvas_credit(job)
    return job


# ---------------------------------------------------------------------------
# Run (Celery) path
# ---------------------------------------------------------------------------

def run_angle_job(job: AngleJob) -> list[AngleResult]:
    """Execute `job` end-to-end: POST fal.run → download images → persist.

    Raises on failure after marking job FAILED + persisting error, so the
    Celery task can react. Canvex billing rollback 是 no-op。
    """
    with job_lifecycle(job):
        response = _submit(job, resolve_angle_channel(job))
        # 立刻落 seed —— 和 video.py 存 task_id 同理: 若后续 download/persist 抛错,
        # job_lifecycle 走 FAILED 分支只会存 status/error/updated_at, seed 会丢.
        seed = response.get("seed")
        if isinstance(seed, int):
            job.seed = seed
            job.save(update_fields=["seed", "updated_at"])
        image_bytes_list = _download_result_images(response)
        results = _persist_results(job, image_bytes_list)
    return results


# ---------------------------------------------------------------------------
# Submit + response parsing
# ---------------------------------------------------------------------------

def _submit(job: AngleJob, channel: ImageChannel) -> dict:
    # fal 把模型名放在 URL 路径里 (而不是请求体的 model 字段) —— 这正是 angle 不能
    # 套用生图那套 ImageClient 的原因之一。
    endpoint = f"{channel.base_url.rstrip('/')}/{channel.model}"

    # 我们自己的 media 读盘内联成 base64 data URI(免公网 URL / 隧道);外部公网 URL
    # 原样传 + 可达性预检(防 fal 拿不到源时静默 rerender 无关图)。fal 接受 data URI。
    source = source_to_inline_uri(job.source_image_url)
    if source.startswith(("http://", "https://")):
        assert_source_url_reachable(source)

    body: dict = {
        "image_urls": [source],
        "horizontal_angle": job.horizontal_angle,
        "vertical_angle": job.vertical_angle,
        "zoom": job.zoom,
        "num_images": job.num_images,
    }
    if job.additional_prompt:
        body["additional_prompt"] = job.additional_prompt

    logger.info(
        "angle submit: job=%s channel=%s endpoint=%s h=%.1f v=%.1f z=%.1f n=%d",
        job.id, channel.label, endpoint, job.horizontal_angle, job.vertical_angle,
        job.zoom, job.num_images,
    )
    resp = _session.post(
        endpoint,
        headers={
            # fal 用 `Key`, 不是生图那边的 `Bearer` —— 另一个不能共用 ImageClient 的点。
            "Authorization": f"Key {channel.api_key}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=channel.timeout,
    )
    try:
        data = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"angle submit returned non-JSON: {exc}") from exc
    if resp.status_code >= 400:
        # fal 错误格式通常 {"detail": "..."} 或 {"message": "..."}; 两个都兜
        detail = data.get("detail") or data.get("message") or str(data)
        raise RuntimeError(f"angle submit HTTP {resp.status_code}: {detail}")
    if not isinstance(data, dict):
        raise RuntimeError(f"angle submit unexpected payload: {type(data).__name__}")
    return data


def _download_result_images(response: dict) -> list[bytes]:
    images = response.get("images") or []
    if not images:
        raise RuntimeError(f"angle response has no images: keys={list(response.keys())}")
    out: list[bytes] = []
    for item in images:
        url = item.get("url") if isinstance(item, dict) else None
        if not url:
            raise RuntimeError(f"angle image entry missing 'url': {item!r}")
        r = _session.get(url, timeout=DOWNLOAD_TIMEOUT)
        r.raise_for_status()
        out.append(r.content)
    return out


def _persist_results(
    job: AngleJob, image_bytes_list: Iterable[bytes],
) -> list[AngleResult]:
    return persist_canvas_image_results(
        job, image_bytes_list,
        result_model=AngleResult,
        filename_prefix="canvas-angle",
    )
