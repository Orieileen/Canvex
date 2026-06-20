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

from ..models import AngleJob, AngleResult
from . import save_canvas_source_image
from .agent.tools.common import (
    DOWNLOAD_TIMEOUT,
    absolute_media_url,
    assert_source_url_reachable,
    is_public_http_url,
    job_lifecycle,
    persist_canvas_image_results,
)
from .billing import reserve as reserve_canvas_credit

# Module-level Session: fal.ai 偶尔抖, retry transient 5xx/429. lazy 创建复用 TCP.
_session = make_retry_session()

logger = logging.getLogger(__name__)


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

    if not is_public_http_url(absolute):
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
        api_key = (settings.CANVAS_ANGLE_FAL_API_KEY or "").strip()
        if not api_key:
            raise RuntimeError("missing env: CANVAS_ANGLE_FAL_API_KEY")

        # 防 "纯文字兜底": source URL 不通时 fal 会静默 rerender 无关图.
        assert_source_url_reachable(job.source_image_url)

        response = _submit(job, api_key)
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

def _submit(job: AngleJob, api_key: str) -> dict:
    base = (settings.CANVAS_ANGLE_FAL_BASE_URL or "https://fal.run").rstrip("/")
    model = settings.CANVAS_ANGLE_FAL_MODEL
    endpoint = f"{base}/{model}"

    body: dict = {
        "image_urls": [job.source_image_url],
        "horizontal_angle": job.horizontal_angle,
        "vertical_angle": job.vertical_angle,
        "zoom": job.zoom,
        "num_images": job.num_images,
    }
    if job.additional_prompt:
        body["additional_prompt"] = job.additional_prompt

    logger.info(
        "angle submit: job=%s endpoint=%s h=%.1f v=%.1f z=%.1f n=%d",
        job.id, endpoint, job.horizontal_angle, job.vertical_angle, job.zoom,
        job.num_images,
    )
    resp = _session.post(
        endpoint,
        headers={
            "Authorization": f"Key {api_key}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=settings.CANVAS_ANGLE_FAL_TIMEOUT,
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
