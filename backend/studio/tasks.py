"""Canvas (studio) Celery tasks.

Task 都绑到 queue="canvas" / "canvas_cpu" (见 config/settings.py CELERY_TASK_ROUTES),
由 worker_canvas / worker_canvas_cpu service 消费.

Canvex 独立版:billing 是 no-op stub(studio.services.billing),所以 commit /
rollback / partial_refund 调用全部保留——它们自动空操作,不扣 / 不退任何 credit。
模型已无 organization / user 字段,故不再做 sentry user 绑定或 user_id 读取。
"""
import logging
import time
from typing import Callable, Type

from celery import shared_task
from django.db import models, transaction

from .models import AngleJob, ImageEditJob, VideoJob
from .services import billing as canvas_billing
from .services.agent.tools.image import run_cutout_llm_step, run_image_edit_job
from .services.agent.tools.video import run_video_job
from .services.angle import run_angle_job

# Stage 1 (cutout LLM) 写 job.error 的截断长度, 跟 job_lifecycle (common.py) 一致。
_ERROR_TRUNC = 5000

logger = logging.getLogger(__name__)


def _load_job(model_cls: Type[models.Model], job_id: str, task_name: str):
    """Load job by id. Return job or None if invalid/missing (skipped, no Celery
    retry). 两个 canvas task shell 共用,避免 load 段重复。

    Canvex 模型无 user / organization 字段,因此不做 sentry user 绑定。"""
    try:
        return model_cls.objects.get(id=job_id)
    except (model_cls.DoesNotExist, ValueError):
        logger.warning("%s: invalid job_id, skipping: job=%s", task_name, job_id)
        return None


def _load_or_skip(
    model_cls: Type[models.Model],
    job_id: str,
    runner: Callable[[models.Model], None],
    task_name: str,
    *,
    task_id: str | None = None,
    retry: int | None = None,
) -> None:
    """Common shell for every canvas job task.

    - DoesNotExist: row 被删, 重试无意义.
    - ValueError: job_id 不是合法 UUID, 多半打错.
    两种都静默返回 SUCCESS (不触发 Celery 重试).

    Billing wrapping: runner 抛异常时 rollback, 正常返回时 commit. Canvex 的
    billing 是 no-op stub → 这些调用自动空操作, 保留是为了跟上游代码结构一致、
    将来若接计费只换 billing.py 一个文件。rollback / commit 自身幂等。
    """
    logger.info(
        "%s start: job=%s, task_id=%s, retry=%s",
        task_name, job_id, task_id, retry,
    )
    t0 = time.monotonic()
    job = _load_job(model_cls, job_id, task_name)
    if job is None:
        return
    runner_exc: Exception | None = None
    try:
        runner(job)
    except Exception as exc:
        runner_exc = exc
        # commit/rollback 失败不能掩盖 runner 异常 → 套 try, 自己 logger.exception
        try:
            canvas_billing.rollback(job, reason=f"{task_name}_failed")
        except Exception:
            logger.exception(
                "%s: canvas_billing.rollback failed: job=%s",
                task_name, job_id,
            )

    if runner_exc is None:
        # Partial refund: 声明 num_images=N 但实际只产 < N 张时退差额。Canvex
        # billing no-op → 此调用空操作, 保留以对齐上游结构。仅对有 num_images
        # + results 反向关系的 job 生效 (ImageEditJob / AngleJob).
        expected = getattr(job, "num_images", None)
        if expected and expected > 1 and hasattr(job, "results"):
            actual = job.results.count()
            if actual < expected:
                try:
                    canvas_billing.partial_refund(
                        job, refund_credits=expected - actual, reason="partial_output",
                    )
                    logger.warning(
                        "%s: partial output: job=%s, expected=%d, actual=%d",
                        task_name, job_id, expected, actual,
                    )
                except Exception:
                    logger.exception(
                        "%s: partial_refund failed: job=%s", task_name, job_id,
                    )
        try:
            canvas_billing.commit(job)
        except Exception:
            logger.exception(
                "%s: canvas_billing.commit failed: job=%s", task_name, job_id,
            )

    # Split atomic billing collateral: 在 commit / rollback 都跑完之后, 看 partner
    # 终态决定要不要退已 committed 那 leg。Canvex billing no-op → partial_refund
    # 自动空操作, 但 split_partner FK 仍保留(前端配对显示), 逻辑结构对齐保留。
    if isinstance(job, ImageEditJob) and job.split_partner_id:
        try:
            _check_split_pair_for_refund(job, task_name)
        except Exception:
            logger.exception(
                "%s: split partner refund check failed: job=%s, partner=%s",
                task_name, job_id, job.split_partner_id,
            )

    if runner_exc is not None:
        raise runner_exc
    logger.info(
        "%s done: job=%s, elapsed=%.2fs",
        task_name, job_id, time.monotonic() - t0,
    )


def _check_split_pair_for_refund(job: "ImageEditJob", task_name: str) -> None:
    """End-of-task collateral for split atomic billing.

    本 task 已 commit/rollback, job.status 是终态 (job_lifecycle 在 runner 里写过).
    Look at partner status:
    - self FAILED + partner SUCCEEDED → 退 partner
    - self SUCCEEDED + partner FAILED → 退 self
    - 其他组合 (双成功 / 双失败 / partner 仍 RUNNING) → noop

    Canvex billing no-op → 真正的 partial_refund 是空操作, 此函数保留是为了对齐
    上游结构 + 将来接计费可直接复用。select_for_update 锁 partner row 仍生效。
    """
    with transaction.atomic():
        partner = (
            ImageEditJob.objects.select_for_update()
            .only("id", "status", "split_partner_id")
            .filter(id=job.split_partner_id).first()
        )
        if not partner:
            return
        # 防御: partner 的 split_partner 必须回指 self, 否则 split FK 单边 (db
        # 残缺 / 异常) 误把独立 job 当 partner。create_split_jobs 同 tx 双向 wire。
        if partner.split_partner_id != job.id:
            return

        failed = ImageEditJob.Status.FAILED
        succeeded = ImageEditJob.Status.SUCCEEDED
        if job.status == failed and partner.status == succeeded:
            target = partner
        elif job.status == succeeded and partner.status == failed:
            target = job
        else:
            return  # 双终态相同 / partner 仍 RUNNING / 异常状态: 都不退

        refund = canvas_billing.cost_credits(target)
        if refund <= 0:
            return  # Canvex no-op: cost_credits 恒 0 → 这里恒短路返回
        canvas_billing.partial_refund(
            target, refund_credits=refund, reason="split_partner_failed",
        )
        logger.info(
            "%s: split partner failed → refund check: target_job=%s, trigger_job=%s",
            task_name, target.id, job.id,
        )


def _run_cutout_llm_step_or_skip(
    job_id: str, *, task_id: str | None = None, retry: int | None = None,
) -> None:
    """Stage 1 (LLM 抠主体留白底) 的 task shell. 跟 _load_or_skip 同模式但:
    - 不 commit billing (stage 2 跑完才结算)
    - 不 partial_refund (本 stage 不产 Asset, results 反向关系还是空, 跳过)
    - 不标 SUCCEEDED (status 留 RUNNING 给 stage 2 接力, 避免 stage 1 完到
      stage 2 之间用户看到 SUCCEEDED 但找不到 Asset 的窗口)
    - 失败时: 标 FAILED + rollback (no-op) + split partner 退款检查 + raise
    - 成功时: enqueue stage 2 (canvas_image_edit_cutout_job_task) 接力
    """
    task_name = "canvas.cutout_llm_step"
    logger.info(
        "%s start: job=%s, task_id=%s, retry=%s",
        task_name, job_id, task_id, retry,
    )
    t0 = time.monotonic()
    job = _load_job(ImageEditJob, job_id, task_name)
    if job is None:
        return

    # status 标 RUNNING. stage 2 的 job_lifecycle 会再标一次, 幂等。
    job.status = ImageEditJob.Status.RUNNING
    job.save(update_fields=["status", "updated_at"])

    try:
        run_cutout_llm_step(job)
        # apply_async 留在 try 块内, broker 挂时也走 rollback — 否则 stage 1 成功
        # + 入队失败 = 结果永远出不来, 用户拿不到结果。
        canvas_image_edit_cutout_job_task.apply_async(args=[str(job_id)])
    except Exception as exc:
        job.status = ImageEditJob.Status.FAILED
        job.error = str(exc)[:_ERROR_TRUNC]
        job.save(update_fields=["status", "error", "updated_at"])
        logger.exception("%s failed: job=%s", task_name, job_id)
        try:
            canvas_billing.rollback(job, reason=f"{task_name}_failed")
        except Exception:
            logger.exception(
                "%s: canvas_billing.rollback failed: job=%s", task_name, job_id,
            )
        if job.split_partner_id:
            try:
                _check_split_pair_for_refund(job, task_name)
            except Exception:
                logger.exception(
                    "%s: split partner refund check failed: job=%s, partner=%s",
                    task_name, job_id, job.split_partner_id,
                )
        raise

    # Stage 1 OK + stage 2 已入队. status 留 RUNNING 给 stage 2 接力。
    logger.info(
        "%s done, chained to stage 2: job=%s, elapsed=%.2fs",
        task_name, job_id, time.monotonic() - t0,
    )


@shared_task(bind=True, name="canvas.cutout_llm_step")
def canvas_cutout_llm_step_task(self, job_id: str) -> None:
    """Cutout 2-stage 流水 stage 1: LLM 调 apimart 抠主体留纯白底, 写到
    job.intermediate_image. 完成后链 stage 2 (canvas.image_edit_cutout_job).
    → queue=canvas (gevent worker_canvas, IO-bound). 见 settings.CELERY_TASK_ROUTES."""
    _run_cutout_llm_step_or_skip(
        job_id, task_id=self.request.id, retry=self.request.retries,
    )


@shared_task(bind=True, name="canvas.image_edit_job")
def canvas_image_edit_job_task(self, job_id: str) -> None:
    """非 cutout 的 ImageEditJob (LLM 生成 / 编辑 / split-inpaint) → queue=canvas
    (gevent worker_canvas, IO-bound 高并发). 见 settings.CELERY_TASK_ROUTES."""
    _load_or_skip(
        ImageEditJob, job_id, run_image_edit_job, "canvas.image_edit_job",
        task_id=self.request.id, retry=self.request.retries,
    )


@shared_task(bind=True, name="canvas.image_edit_cutout_job")
def canvas_image_edit_cutout_job_task(self, job_id: str) -> None:
    """is_cutout=True 的 ImageEditJob → queue=canvas_cpu (prefork worker_canvas_cpu,
    CPU-bound). rembg 是阻塞 CPU + onnx 占内存 ~170MB, 不能跑 gevent (会冻 event
    loop + 拖死整个 canvas 队列), 必须独立 prefork worker. 同 pipeline/pipeline_cpu
    拆分模式。runner 跟非 cutout 共用 run_image_edit_job, 分支由 job.is_cutout 控制."""
    _load_or_skip(
        ImageEditJob, job_id, run_image_edit_job, "canvas.image_edit_cutout_job",
        task_id=self.request.id, retry=self.request.retries,
    )


@shared_task(bind=True, name="canvas.video_job")
def canvas_video_job_task(self, job_id: str) -> None:
    """POST /scenes/<id>/video/ 创的 VideoJob 由 worker_canvas 执行 (含长轮询)."""
    _load_or_skip(
        VideoJob, job_id, run_video_job, "canvas.video_job",
        task_id=self.request.id, retry=self.request.retries,
    )


@shared_task(bind=True, name="canvas.angle_job")
def canvas_angle_job_task(self, job_id: str) -> None:
    """POST /scenes/<id>/angle/ 创的 AngleJob 由 worker_canvas 执行 (fal.ai LoRA)."""
    _load_or_skip(
        AngleJob, job_id, run_angle_job, "canvas.angle_job",
        task_id=self.request.id, retry=self.request.retries,
    )
