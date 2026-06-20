"""Celery signal handlers for the canvas worker pool.

Imported from `studio.apps.StudioConfig.ready()` so connections are made
exactly once per Python interpreter (including each celery prefork child).
"""
import logging

from celery.signals import worker_process_init

logger = logging.getLogger(__name__)


@worker_process_init.connect
def preload_rembg_session(**_kwargs) -> None:
    """Warm rembg's u2net session on every prefork worker startup.

    Without this, 4 concurrent cutout jobs on worker_canvas_cpu cold-start at
    the same time and each attempts to download + initialize u2net.onnx
    (~170MB) in parallel — N copies of onnxruntime InferenceSession sitting in
    RAM, per-request latency spikes into minutes.

    Done inside worker_process_init (not at module import) so only celery
    worker children pay the cost — web / dev shells stay lightweight. signal
    在 gevent 模式 (worker_canvas) 不触发, 所以非 prefork worker 不会装 onnx。

    Swallows errors: if network is offline or the model file is missing,
    first real cutout job will retry via rembg's lazy path rather than
    crash-looping the worker.
    """
    try:
        from rembg import new_session
        new_session()
        logger.info("rembg: u2net session warmed on worker init")
    except Exception:  # pragma: no cover — init should never take down worker
        logger.warning("rembg: preload failed; first cutout job will cold-load", exc_info=True)
