"""Video generation / long-poll execution (Canvex 独立版).

One code path: OpenAI-compat HTTP (POST to submit, GET to poll). Does NOT
download the MP4; stores the provider's URL directly on VideoJob.

Config lives in settings.py under CANVAS_VIDEO_*. See .env.example for the
required vars (BASE_URL / API_KEY / MODEL) and the poll knobs.

解耦自 meired apps/canvas/services/agent/tools/video.py:
- 计费 import 路径改 studio.services.billing(stub no-op,调用全保留)。
- 模型无 organization / user → enqueue 时不再 set,签名去掉 org_id / user_id。
- 跨租户 scope 防护(enqueue_scope_or_friendly_message)不 port:单工作区无跨
  租户面。SSRF 公网 URL 过滤(is_public_http_url)保留。
"""
import logging
import time
from typing import Any, NamedTuple
from urllib.parse import quote

import requests
from django.conf import settings
from django.db import transaction
from langchain.tools import ToolRuntime, tool

from studio.models import VideoJob
from studio.services.billing import reserve_or_friendly_message
from studio.services.http_retry import make_retry_session
from studio.services.listings_utils import DONE_STATUSES, FAILED_STATUSES

from ..context import CanvasAgentContext
from .common import (
    assert_source_url_reachable,
    enqueue_on_commit,
    is_public_http_url,
    job_lifecycle,
)

logger = logging.getLogger(__name__)

# Module-level Session: 同一个 video provider 的 submit + poll 复用 TCP + 共享
# Retry policy. 第一个 task 跑时 lazy 创建, 后续 task 复用.
_session = make_retry_session()


# canvas video providers occasionally ship "done" as the completion keyword
# (e.g. tu-zi); listings' set doesn't need it, so extend here.
_DONE_STATUSES = DONE_STATUSES | {"done"}
_FAILED_STATUSES = FAILED_STATUSES


class _Config(NamedTuple):
    base_url: str
    api_key: str
    model: str


def run_video_job(job: VideoJob) -> None:
    """Execute `job` end-to-end: submit → long-poll → persist result URL.

    Raises on failure (after marking job FAILED + persisting error).
    Blocks the caller for up to sum of all poll intervals — Celery worker only.
    """
    with job_lifecycle(job, success_extra_fields=("result_url", "thumbnail_url")):
        # Read settings inside the with block so a missing value goes down the
        # FAILED path (same shape as image.py client init).
        cfg = _require_config()

        # 防 "纯文字兜底": reference image URL 不通时 provider 会静默走纯文生
        # 视频, 跟原图无关. image.py 同款防御 — empty 列表是合法 (无 reference).
        for url in (job.image_urls or []):
            assert_source_url_reachable(url)

        task_id = _submit(job, cfg)
        job.task_id = task_id
        job.save(update_fields=["task_id", "updated_at"])

        result = _poll_until_done(task_id, cfg)
        job.result_url = result["url"]
        job.thumbnail_url = result.get("thumbnail_url", "")


# ---------------------------------------------------------------------------
# Agent tool: chat-driven async generation
# ---------------------------------------------------------------------------


def enqueue_video_generation(
    *,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    reference_image_urls: list[str] | None,
    scene_id: str,
) -> str:
    """Pure-args helper: create VideoJob + reserve credit + enqueue Celery + return confirmation.

    Reserve 失败 → LLM 友好字符串 (同 enqueue_image_generation; Canvex 免费 stub
    恒返 None, 始终放行)。
    """
    from studio.tasks import canvas_video_job_task

    duration_clamped = max(1, min(60, int(duration)))
    # SSRF 防护: 只留公网 http(s) URL; LLM tool call 被注入私网 IP 会被丢掉
    raw_urls = [u for u in (reference_image_urls or []) if isinstance(u, str) and u.strip()]
    urls = [u for u in raw_urls if is_public_http_url(u)]
    rejected = [u for u in raw_urls if u not in urls]
    if rejected:
        logger.warning("enqueue_video_generation: rejected non-public URLs: %s", rejected)

    with transaction.atomic():
        job = VideoJob.objects.create(
            scene_id=scene_id,
            prompt=prompt,
            image_urls=urls,
            duration=duration_clamped,
            aspect_ratio=aspect_ratio or "16:9",
            status=VideoJob.Status.QUEUED,
        )
        reserve_error = reserve_or_friendly_message(job, action_label="video generation")
        if reserve_error:
            # Canvex billing 是 no-op stub:reserve_error 恒为 None,本分支不触发。
            # 保留与 meired 一致的调用形状(将来接计费时 helper 会 set_rollback 回滚 atomic)。
            return reserve_error
    job_id = enqueue_on_commit(job, canvas_video_job_task)
    logger.info("enqueue_video_generation: job %s scene %s", job_id, scene_id)
    return (
        f"Video generation queued (job_id={job_id}, duration={duration_clamped}s, "
        f"aspect_ratio={aspect_ratio}). Typically 1–5 min; it'll appear on the canvas."
    )


@tool
def generate_video(
    prompt: str,
    duration: int = 5,
    aspect_ratio: str = "16:9",
    reference_image_urls: list[str] | None = None,
    runtime: ToolRuntime[CanvasAgentContext] = None,
) -> str:
    """Generate a short video from a text prompt and optional reference images.

    Long-running (minutes). The job runs asynchronously on a background worker
    with exponential-backoff polling; the video URL will appear on the canvas
    when the external model completes.

    Args:
        prompt: Detailed description of the motion / scene.
        duration: Clip length in seconds (1–60).
        aspect_ratio: "16:9" (landscape), "9:16" (portrait), "1:1" (square).
        reference_image_urls: Optional list of http(s) URLs to seed the video
            (first frame / style reference). Must be publicly reachable.

    Returns:
        A short confirmation string naming the enqueued job id.
    """
    if runtime is None or runtime.context is None:
        raise RuntimeError("generate_video requires CanvasAgentContext via ToolRuntime")
    ctx = runtime.context
    return enqueue_video_generation(
        prompt=prompt,
        duration=duration,
        aspect_ratio=aspect_ratio,
        reference_image_urls=reference_image_urls,
        scene_id=ctx.scene_id,
    )


# ---------------------------------------------------------------------------
# Submit + poll internals
# ---------------------------------------------------------------------------

def _submit(job: VideoJob, cfg: _Config) -> str:
    endpoint = f"{cfg.base_url.rstrip('/')}/videos/generations"

    body: dict[str, Any] = {
        "model": cfg.model,
        "prompt": job.prompt,
        "duration": job.duration,
        "aspect_ratio": job.aspect_ratio or "16:9",
    }
    if job.image_urls:
        body["image_urls"] = list(job.image_urls)

    logger.info(
        "video submit: endpoint=%s model=%s duration=%s aspect=%s images=%d",
        endpoint, cfg.model, job.duration, job.aspect_ratio, len(job.image_urls or []),
    )
    resp = _session.post(
        endpoint,
        headers=_auth_headers(cfg.api_key),
        json=body,
        timeout=settings.CANVAS_VIDEO_SUBMIT_TIMEOUT,
    )
    data = _parse_json_or_raise(resp, "submit")
    task_id = _extract_task_id(data)
    if not task_id:
        raise RuntimeError(f"video submit response missing task id: {data!r}")
    return task_id


def _poll_until_done(task_id: str, cfg: _Config) -> dict[str, Any]:
    """Exponential backoff poll. Raises TimeoutError if not done within the cap."""
    # quote(safe="") 防被劫持的 provider 回一个 "../admin" 把 GET 拐到别处
    status_url = f"{cfg.base_url.rstrip('/')}/videos/{quote(task_id, safe='')}"
    attempts = max(1, settings.CANVAS_VIDEO_POLL_MAX_ATTEMPTS)
    initial = max(1, settings.CANVAS_VIDEO_POLL_INITIAL_SECONDS)
    max_wait = max(initial, settings.CANVAS_VIDEO_POLL_MAX_SECONDS)

    wait = initial
    for attempt in range(1, attempts + 1):
        time.sleep(wait)
        resp = _session.get(
            status_url,
            headers=_auth_headers(cfg.api_key),
            timeout=settings.CANVAS_VIDEO_POLL_HTTP_TIMEOUT,
        )
        data = _parse_json_or_raise(resp, "poll")
        status = _extract_status(data)
        logger.info(
            "video poll %s attempt=%d/%d status=%s", task_id, attempt, attempts, status,
        )

        if status in _DONE_STATUSES:
            url = _extract_result_url(data)
            if not url:
                raise RuntimeError(f"video {task_id} completed but no url in response")
            return {
                "status": "succeeded",
                "url": url,
                "thumbnail_url": _extract_thumbnail_url(data),
            }
        if status in _FAILED_STATUSES:
            raise RuntimeError(
                _extract_error(data) or f"video {task_id} ended with status {status!r}"
            )
        # RUNNING / PENDING / … 继续轮询, wait 翻倍但不超过 max
        wait = min(wait * 2, max_wait)

    raise TimeoutError(
        f"video {task_id} did not complete after {attempts} polls "
        f"(last wait={wait}s)"
    )


# ---------------------------------------------------------------------------
# Env + HTTP helpers
# ---------------------------------------------------------------------------

def _require_config() -> _Config:
    """Read and validate settings.CANVAS_VIDEO_*. Raises RuntimeError if any missing."""
    base_url = (settings.CANVAS_VIDEO_BASE_URL or "").strip()
    api_key = (settings.CANVAS_VIDEO_API_KEY or "").strip()
    model = (settings.CANVAS_VIDEO_MODEL or "").strip()
    missing = [
        name for name, val in (
            ("CANVAS_VIDEO_BASE_URL", base_url),
            ("CANVAS_VIDEO_API_KEY", api_key),
            ("CANVAS_VIDEO_MODEL", model),
        ) if not val
    ]
    if missing:
        raise RuntimeError(f"missing env: {', '.join(missing)}")
    return _Config(base_url=base_url, api_key=api_key, model=model)


def _auth_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _parse_json_or_raise(resp: requests.Response, action: str) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"video {action} returned non-JSON: {exc}") from exc
    if resp.status_code >= 400:
        raise RuntimeError(
            _extract_error(data) or f"video {action} returned HTTP {resp.status_code}"
        )
    return data if isinstance(data, dict) else {"data": data}


# ---------------------------------------------------------------------------
# Response shape parsing — tolerant of common provider variants
# ---------------------------------------------------------------------------

def _candidate_dicts(payload: Any) -> list[dict]:
    """Provider 包裹千差万别: 顶层 / {"data": {...}} / {"data": [{...}]} 都要兼容.
    返回顺序按优先级 (顶层优先) 的 dict 列表."""
    out: list[dict] = []
    if isinstance(payload, dict):
        out.append(payload)
        inner = payload.get("data")
        if isinstance(inner, dict):
            out.append(inner)
        elif isinstance(inner, list) and inner and isinstance(inner[0], dict):
            out.append(inner[0])
    return out


def _first_field(payload: Any, keys: tuple[str, ...], *, must_be_http: bool = False) -> str:
    for d in _candidate_dicts(payload):
        for key in keys:
            val = d.get(key)
            if val and isinstance(val, str):
                s = val.strip()
                if must_be_http and not s.startswith(("http://", "https://")):
                    continue
                return s
    return ""


def _extract_task_id(payload: Any) -> str:
    return _first_field(payload, ("id", "task_id", "job_id", "video_id"))


def _extract_status(payload: Any) -> str:
    return _first_field(payload, ("status", "state", "phase")).lower()


def _extract_result_url(payload: Any) -> str:
    return _first_field(
        payload,
        ("url", "video_url", "download_url", "result_url", "output_url"),
        must_be_http=True,
    )


def _extract_thumbnail_url(payload: Any) -> str:
    return _first_field(
        payload,
        ("thumbnail_url", "cover_url", "thumb"),
        must_be_http=True,
    )


def _extract_error(payload: Any) -> str:
    """error 可以是顶层字符串、{error: {message}} 子字典、或 data.fail_reason."""
    if not isinstance(payload, dict):
        return ""
    for d in _candidate_dicts(payload):
        for key in ("error", "message", "fail_reason", "detail"):
            val = d.get(key)
            if isinstance(val, dict):
                for sub in ("message", "detail", "error"):
                    inner = val.get(sub)
                    if inner:
                        return str(inner).strip()
            elif val:
                return str(val).strip()
    return ""
