from __future__ import annotations

import io
import logging
import os

from celery import shared_task
from PIL import Image

from .models import ExcalidrawImageEditJob, ExcalidrawImageEditResult, ExcalidrawVideoJob
from .tools import (
    _abs_url,
    _edit_image_media,
    _generate_image_media,
    _generate_video_media,
    _resolve_excalidraw_asset_folder_id,
    _resolve_image_bytes,
    _save_asset,
)

logger = logging.getLogger(__name__)

_VIDEO_SIZE_BY_ASPECT_RATIO = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "720x720",
}


def _read_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


def _video_size_from_aspect_ratio(aspect_ratio: str) -> str:
    raw = str(aspect_ratio or "").strip().replace(" ", "")
    if raw not in _VIDEO_SIZE_BY_ASPECT_RATIO:
        raise ValueError(f"unsupported aspect_ratio: {raw}")
    return _VIDEO_SIZE_BY_ASPECT_RATIO[raw]


def _is_retryable_video_error(message: str | None) -> bool:
    text = str(message or "").lower()
    if not text:
        return False

    # Clearly non-retryable request/auth/model/content errors.
    non_retryable_tokens = (
        "invalid_request",
        "invalid request",
        "invalid_request_error",
        "prompt is required",
        "image_urls is required",
        "requires at least one selected image",
        "authentication",
        "unauthorized",
        "forbidden",
        "permission denied",
        "api key",
        "model not found",
        "unsupported",
        "content_policy",
        "safety",
        "moderation",
        "did not complete",
        "no video url found",
        "completed but no url found",
    )
    if any(token in text for token in non_retryable_tokens):
        return False

    # Upstream capacity / rate limit.
    if ("queue" in text and "full" in text) or ("队列" in text and "满" in text):
        return True
    if "too many requests" in text or "rate limit" in text or "ratelimit" in text:
        return True
    if "throttle" in text or "quota exceeded" in text or "resource exhausted" in text:
        return True
    if (
        "server busy" in text
        or "service busy" in text
        or "system busy" in text
        or "服务繁忙" in text
        or "系统繁忙" in text
    ):
        return True

    # HTTP transient failures.
    transient_http_markers = (
        "status code 408",
        "status code 409",
        "status code 425",
        "status code 429",
        "status code 500",
        "status code 502",
        "status code 503",
        "status code 504",
        "status code 520",
        "status code 521",
        "status code 522",
        "status code 523",
        "status code 524",
        "status code 529",
        "error code: 408",
        "error code: 409",
        "error code: 425",
        "error code: 429",
        "error code: 500",
        "error code: 502",
        "error code: 503",
        "error code: 504",
        "error code: 520",
        "error code: 521",
        "error code: 522",
        "error code: 523",
        "error code: 524",
        "error code: 529",
        '"code":408',
        '"code":409',
        '"code":425',
        '"code":429',
        '"code":500',
        '"code":502',
        '"code":503',
        '"code":504',
        '"code":520',
        '"code":521',
        '"code":522',
        '"code":523',
        '"code":524',
        '"code":529',
    )
    if any(token in text for token in transient_http_markers):
        return True

    # Network / upstream instability.
    transient_network_tokens = (
        "temporary",
        "temporarily unavailable",
        "service unavailable",
        "bad gateway",
        "gateway timeout",
        "upstream",
        "overloaded",
        "internal server error",
        "timeout",
        "timed out",
        "deadline exceeded",
        "connection reset",
        "connection aborted",
        "connection refused",
        "connection error",
        "remote disconnected",
        "econnreset",
        "etimedout",
        "eai_again",
        "network error",
        "socket hang up",
        "read timeout",
        "request timeout",
        "connect timeout",
        "connection timeout",
    )
    if any(token in text for token in transient_network_tokens):
        return True

    # Generic retry hints from providers.
    if (
        "try again later" in text
        or "please retry" in text
        or "please try again" in text
        or "retry this request" in text
        or "请稍后重试" in text
        or "请重试" in text
        or "稍后再试" in text
    ):
        return True

    # Too generic but commonly transient provider response.
    if text in {"video generation failed", "failed to generate video", "generation failed"}:
        return True

    return False


def _normalize_png_bytes(image_bytes: bytes) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = source.copy()
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _persist_video_thumbnail(job: ExcalidrawVideoJob, thumbnail_url: str | None) -> str:
    source_url = str(thumbnail_url or "").strip()
    if not source_url:
        return ""

    try:
        image_bytes = _resolve_image_bytes(source_url)
        normalized_bytes = _normalize_png_bytes(image_bytes)
        folder_id = _resolve_excalidraw_asset_folder_id(
            str(job.scene_id) if job.scene_id else None,
            job.scene.title if getattr(job, "scene", None) else None,
        )
        asset = _save_asset(normalized_bytes, job.prompt or "video thumbnail", folder_id)
        if not asset.is_public:
            asset.is_public = True
            asset.save(update_fields=["is_public", "updated_at"])
        return _abs_url(getattr(asset.file, "url", "")) or ""
    except Exception as exc:
        logger.warning("Persist video thumbnail failed for job %s: %s", job.id, exc)
        return ""


def _schedule_video_retry(job: ExcalidrawVideoJob, attempt: int, reason: str, task) -> bool:
    max_retries = max(0, _read_int_env("VIDEO_RETRY_MAX", 6))
    if attempt >= max_retries:
        return False

    base_delay = max(5, _read_int_env("VIDEO_RETRY_BASE_SECONDS", 20))
    max_delay = max(base_delay, _read_int_env("VIDEO_RETRY_MAX_DELAY_SECONDS", 180))
    delay = min(max_delay, base_delay * (2 ** attempt))
    next_attempt = attempt + 1

    job.status = ExcalidrawVideoJob.Status.QUEUED
    job.error = f"provider busy, auto retry {next_attempt}/{max_retries} in {delay}s: {reason}"
    job.save(update_fields=["status", "error", "updated_at"])

    task.apply_async(args=[str(job.id), next_attempt], queue="excalidraw", countdown=delay)
    logger.warning(
        "Retry video job %s in %ss (%s/%s), reason=%s",
        job.id,
        delay,
        next_attempt,
        max_retries,
        reason,
    )
    return True

def _remove_white_background(image_bytes: bytes) -> bytes:
    # If provider already returned real transparency, keep as-is to avoid quality loss.
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = source.copy()
        if "A" in image.getbands():
            alpha_min, alpha_max = image.getchannel("A").getextrema()
            if alpha_min < alpha_max:
                return image_bytes
    except Exception:
        pass

    try:
        from rembg import remove

        use_alpha_matting = str(os.getenv("CUTOUT_REMBG_ALPHA_MATTING", "1")).strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        kwargs: dict[str, object] = {}
        if use_alpha_matting:
            kwargs = {
                "alpha_matting": True,
                "alpha_matting_foreground_threshold": _read_int_env(
                    "CUTOUT_REMBG_FOREGROUND_THRESHOLD",
                    240,
                ),
                "alpha_matting_background_threshold": _read_int_env(
                    "CUTOUT_REMBG_BACKGROUND_THRESHOLD",
                    10,
                ),
                "alpha_matting_erode_size": _read_int_env("CUTOUT_REMBG_ERODE_SIZE", 6),
            }
        rembg_bytes = remove(image_bytes, **kwargs)
        if rembg_bytes:
            return rembg_bytes
    except Exception as exc:
        logger.warning("Cutout rembg failed; returning original image without legacy fallback: %s", exc)
        return image_bytes

    logger.warning("Cutout rembg returned empty result; returning original image without legacy fallback.")
    return image_bytes


@shared_task(bind=True, name="studio.image_edit_job")
def run_excalidraw_image_edit_job(self, job_id: str):
    job = ExcalidrawImageEditJob.objects.filter(id=job_id).select_related("scene").first()
    if not job:
        return
    if job.status in (ExcalidrawImageEditJob.Status.RUNNING, ExcalidrawImageEditJob.Status.SUCCEEDED):
        return

    job.status = ExcalidrawImageEditJob.Status.RUNNING
    job.error = ""
    job.save(update_fields=["status", "error", "updated_at"])

    try:
        job.source_image.open("rb")
        source_bytes = job.source_image.read()
    except Exception as exc:
        job.status = ExcalidrawImageEditJob.Status.FAILED
        job.error = f"read source image failed: {exc}"
        job.save(update_fields=["status", "error", "updated_at"])
        return

    model = os.getenv("MEDIA_IMAGE_EDIT_MODEL", "")
    requested = max(1, int(job.num_images or 1))
    allow_text_fallback = str(os.getenv("IMAGE_EDIT_ALLOW_TEXT_FALLBACK", "0")).strip().lower() in ("1", "true", "yes", "on")

    def _generate_one_image_bytes() -> bytes:
        try:
            return _edit_image_media(source_bytes, job.prompt, job.size or "")
        except Exception as exc:
            logger.warning("Image edit failed for job %s, provider=%s, error=%s", job.id, model, exc)
            if not allow_text_fallback:
                raise RuntimeError(
                    f"image edit provider failed ({model}): {exc}. "
                    "Text-only fallback is disabled because it ignores source image."
                ) from exc
            size = job.size or ""
            logger.warning("Image edit job %s falls back to text-only generation (IMAGE_EDIT_ALLOW_TEXT_FALLBACK=1)", job.id)
            return _generate_image_media(job.prompt, size)

    image_bytes_list: list[bytes] = []
    errors: list[Exception] = []

    if requested == 1:
        try:
            image_bytes_list.append(_generate_one_image_bytes())
        except Exception as exc:
            errors.append(exc)
    else:
        try:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            with ThreadPoolExecutor(max_workers=min(4, requested)) as executor:
                futures = [executor.submit(_generate_one_image_bytes) for _ in range(requested)]
                for future in as_completed(futures):
                    try:
                        image_bytes_list.append(future.result())
                    except Exception as exc:
                        errors.append(exc)
        except Exception as exc:
            errors.append(exc)

    if len(image_bytes_list) < requested:
        for _ in range(requested - len(image_bytes_list)):
            try:
                image_bytes_list.append(_generate_one_image_bytes())
            except Exception as exc:
                errors.append(exc)
                break

    if not image_bytes_list:
        job.status = ExcalidrawImageEditJob.Status.FAILED
        job.error = f"image edit failed: {errors[-1] if errors else 'no successful responses'}"
        job.save(update_fields=["status", "error", "updated_at"])
        return

    if len(image_bytes_list) > requested:
        image_bytes_list = image_bytes_list[:requested]

    if job.is_cutout:
        logger.info("Cutout job %s applies _remove_white_background on white-background outputs.", job.id)
        image_bytes_list = [_remove_white_background(image_bytes) for image_bytes in image_bytes_list]

    try:
        folder_id = _resolve_excalidraw_asset_folder_id(
            str(job.scene_id) if job.scene_id else None,
            job.scene.title if job.scene_id else None,
        )
        assets = [_save_asset(image_bytes, job.prompt, folder_id) for image_bytes in image_bytes_list]
    except Exception as exc:
        job.status = ExcalidrawImageEditJob.Status.FAILED
        job.error = f"save asset failed: {exc}"
        job.save(update_fields=["status", "error", "updated_at"])
        return

    if assets:
        job.result_asset = assets[0]
    job.status = ExcalidrawImageEditJob.Status.SUCCEEDED
    job.error = ""
    job.save(update_fields=["result_asset", "status", "error", "updated_at"])

    results = [ExcalidrawImageEditResult(job=job, asset=asset, order=index) for index, asset in enumerate(assets)]
    if results:
        ExcalidrawImageEditResult.objects.bulk_create(results)


@shared_task(bind=True, name="studio.video_job")
def run_excalidraw_video_job(self, job_id: str, attempt: int = 0):
    job = ExcalidrawVideoJob.objects.filter(id=job_id).select_related("scene").first()
    if not job:
        return
    if job.status in (ExcalidrawVideoJob.Status.RUNNING, ExcalidrawVideoJob.Status.SUCCEEDED):
        return
    try:
        attempt = max(0, int(attempt))
    except Exception:
        attempt = 0

    job.status = ExcalidrawVideoJob.Status.RUNNING
    job.error = ""
    job.save(update_fields=["status", "error", "updated_at"])

    payload = {
        "prompt": job.prompt,
        "seconds": job.duration or 12,
        "size": _video_size_from_aspect_ratio(job.aspect_ratio or "16:9"),
        "image_urls": job.image_urls or [],
    }

    try:
        result = _generate_video_media(payload)
    except Exception as exc:
        error_text = str(exc)
        if _is_retryable_video_error(error_text):
            if _schedule_video_retry(job, attempt, error_text, run_excalidraw_video_job):
                return
        normalized_error = str(error_text or "").strip() or "video generation failed"
        job.status = ExcalidrawVideoJob.Status.FAILED
        lower = normalized_error.lower()
        if lower.startswith("video generation failed") or normalized_error.startswith("视频生成失败"):
            job.error = normalized_error
        else:
            job.error = f"video generation failed: {normalized_error}"
        job.save(update_fields=["status", "error", "updated_at"])
        return

    result_url = str(result.get("url") or "")
    result_error = str(result.get("error") or "")
    if result_error and not result_url:
        if _is_retryable_video_error(result_error):
            if _schedule_video_retry(job, attempt, result_error, run_excalidraw_video_job):
                return
        job.status = ExcalidrawVideoJob.Status.FAILED
        job.error = result_error
        job.task_id = str(result.get("task_id") or "")
        job.result_url = ""
        job.thumbnail_url = str(result.get("thumbnail_url") or "")
        job.save(update_fields=["status", "task_id", "result_url", "thumbnail_url", "error", "updated_at"])
        return
    if not result_url:
        no_url_error = "video generation completed but no url found"
        if _schedule_video_retry(job, attempt, no_url_error, run_excalidraw_video_job):
            return
        job.status = ExcalidrawVideoJob.Status.FAILED
        job.error = no_url_error
        job.task_id = str(result.get("task_id") or "")
        job.result_url = ""
        job.thumbnail_url = str(result.get("thumbnail_url") or "")
        job.save(update_fields=["status", "task_id", "result_url", "thumbnail_url", "error", "updated_at"])
        return

    job.status = ExcalidrawVideoJob.Status.SUCCEEDED
    job.task_id = str(result.get("task_id") or "")
    job.result_url = result_url
    job.thumbnail_url = _persist_video_thumbnail(job, result.get("thumbnail_url"))
    job.error = ""
    job.save(update_fields=["status", "task_id", "result_url", "thumbnail_url", "error", "updated_at"])
