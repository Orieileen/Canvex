"""Image generation / edit / cutout execution (Canvex 独立版).

`run_image_edit_job(job)` runs a single ImageEditJob end-to-end. Shared
between two trigger paths:

- **Explicit API POST** `/scenes/<id>/image-edit/` → Celery task pulls the
  job and calls run_image_edit_job.
- **Chat agent tool** creates a job then invokes run_image_edit_job
  synchronously so the LLM can return the URL to the user immediately.

Branches on `job.is_cutout`:
- False (default) → LLM image generation via ImageClient (worker_canvas, gevent)
- True            → 2-stage pipeline:
    * Stage 1: `run_cutout_llm_step` 调 LLM 抠主体留纯白底 → 存 intermediate_image
      (worker_canvas, gevent — IO-bound HTTP wait)
    * Stage 2: `_cutout_and_persist` 读 intermediate_image, rembg 把白转 alpha
      (worker_canvas_cpu, prefork — CPU-bound onnx 推理)

解耦自 meired apps/canvas/services/agent/tools/image.py:
- 计费 import 路径改 studio.services.billing(stub no-op,调用全保留)。
- 模型无 organization / user → enqueue 时不再 set,签名去掉 org_id / user_id。
- 跨租户 scope 防护(enqueue_scope_or_friendly_message)不 port:单工作区无跨
  租户面。
"""
import logging
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import gcd
from typing import Iterable

import requests
from django.db import transaction
from langchain.tools import ToolRuntime, tool

from studio.constants import CUTOUT_LLM_PROMPT
from studio.models import ImageEditJob, ImageEditResult
from studio.services.billing import reserve_or_friendly_message
from studio.services.image_channels import channel_for_model_id
from studio.services.image_client import ImageChannel, build_image_client, channel_from_env
from studio.services.listings_utils import handle_poll_if_needed

from ..context import CanvasAgentContext
from .common import (
    assert_source_url_reachable,
    bytes_to_django_file,
    enqueue_on_commit,
    extract_images_from_response,
    is_gevent_patched,
    job_lifecycle,
    persist_canvas_image_results,
    source_to_inline_uri,
)

logger = logging.getLogger(__name__)

_PRIMARY_PREFIX = "CANVAS_IMAGE_PRIMARY"
_FALLBACK_PREFIX = "CANVAS_IMAGE_FALLBACK"

# Tool refusal protocol: tool returns a string starting with REFUSED_PREFIX
# when it actively blocks a call (no source / wrong shape / SKILL bypass).
# Frontend (CanvasWorkspacePage tool_result handler) detects this prefix to
# surface the refusal text as the placeholder tombstone reason instead of the
# generic "job id missing". Keep this string aligned with that handler.
REFUSED_PREFIX = "Refused:"

# Pack-bypass guard heuristic data (module-level so re.compile / tuple
# allocation don't repeat per call).
# Keyword list is high-specificity only — earlier drafts had 'main shot' /
# 'infographic' / 'side angle' / '多张' / 'set of' which substring-matched
# legitimate variant requests. Bias toward false-negative (1 wasted turn) over
# false-positive (1 lost credit + user confusion).
_PACK_KEYWORDS = (
    "套图", "上架图", "套主图",
    "listing pack", "image set", "image pack", "product listing",
    "amazon listing", "amazon 主图",
)
# Chinese count pattern: 任意数字 + 可选空格 + 张 — covers '7张' (no space),
# '5 张', '15 张'. Earlier literal-list approach hardcoded 7-10 only.
_PACK_ZHANG_PATTERN = re.compile(r"\d+\s*张")


def run_image_edit_job(job: ImageEditJob) -> list[ImageEditResult]:
    """Execute `job` in place. Creates DataAsset + ImageEditResult rows.

    Raises on failure (after marking job FAILED + persisting error) so callers
    (Celery task / stage-4 billing wrapper) can roll back.
    """
    with job_lifecycle(job):
        if job.is_cutout:
            results = _cutout_and_persist(job)
        else:
            results = _generate_and_persist(job)
    return results


# ---------------------------------------------------------------------------
# LLM path
# ---------------------------------------------------------------------------

def _canvas_size_to_ratio(size: str) -> str:
    """`WxH` 像素 → `W:H` 比例 (gcd 化简). apimart-style poll provider 用比例 size,
    canvas 用像素 size. 已是比例 ("1:1") / 无法解析时原样返."""
    if "x" not in size:
        return size
    try:
        w, h = (int(s) for s in size.lower().split("x", 1))
    except ValueError:
        return size
    g = gcd(w, h) or 1
    return f"{w // g}:{h // g}"


# 火山 doubao-seedream-4.5 合法尺寸: 只收分辨率关键字 (2K/4K) 或像素 WxH (总像素
# ∈ [3686400, 16777216], 宽高比 ∈ [1/16, 16]). 不收比例串 "1:1" / "auto", 且 canvas
# 默认的 "1024x1024" 低于 4.5 的总像素下限会被拒. 这里把 canvas 的比例映射到官方
# 推荐像素值 (来自接口文档的推荐表), 9:21 由 21:9 互换得到. 未命中 / "auto" 落到
# 裸 "2K"/"4K" 关键字 (官方 "方式1", 由模型按 prompt / 源图比例定尺寸).
_VOLC_PIXELS: dict[str, dict[str, str]] = {
    "2K": {
        "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304",
        "3:2": "2496x1664", "2:3": "1664x2496", "16:9": "2848x1600",
        "9:16": "1600x2848", "21:9": "3136x1344", "9:21": "1344x3136",
    },
    "4K": {
        "1:1": "4096x4096", "4:3": "4704x3520", "3:4": "3520x4704",
        "3:2": "4992x3328", "2:3": "3328x4992", "16:9": "5504x3040",
        "9:16": "3040x5504", "21:9": "6240x2656", "9:21": "2656x6240",
    },
}


def _volc_size(size: str, resolution: str) -> str:
    """Canvas size (比例 "1:1" / 像素 "1024x1024" / "auto") → 火山合法 size 串.

    先归一到比例 (像素经 gcd 化简), 再按 resolution 档位查推荐像素表; "auto" / 未知
    比例返回裸 "2K"/"4K" 关键字 (官方接受, 模型自定尺寸)."""
    tier = "4K" if (resolution or "").upper() == "4K" else "2K"
    return _VOLC_PIXELS[tier].get(_canvas_size_to_ratio(size), tier)


def _single_generation(
    channel: ImageChannel, *, prompt: str, image_urls: list[str], size: str, resolution: str = "",
) -> bytes:
    """单次 provider 调用, n=1 固定, 返单张 image bytes.

    poll_enabled (apimart 异步) 走 handle_poll_if_needed 桥接 task_id → bytes;
    其他 (tu-zi / 火山 同步) 走 extract_images_from_response 取 data[0].
    任何错误冒泡到调用方 (_generate 的 fan-out 会 catch + 计入失败数).

    size 适配按 channel.size_mode: "pixel" → 火山合法像素 (_volc_size); 否则沿用旧
    行为 —— 异步 poll provider (apimart) 把像素归一成比例串喂过去.
    """
    client = build_image_client(channel)
    if channel.size_mode.lower() == "pixel":
        size = _volc_size(size, resolution)
        resolution = ""  # 档位已折进 size 的像素值; resolution 是 apimart 字段, 火山读 size, 不重复下发
    elif channel.poll_enabled:
        size = _canvas_size_to_ratio(size)

    response = client.generate(
        prompt=prompt, image_urls=image_urls, size=size, n=1, resolution=resolution,
    )
    if not channel.poll_enabled:
        return extract_images_from_response(response)[0]

    return handle_poll_if_needed(
        response=response, poll_enabled=True,
        api_key=client.api_key,
        poll_url=channel.poll_url or client.base_url,
        max_attempts=channel.poll_max_attempts,
        interval=channel.poll_interval,
        req_timeout=channel.poll_timeout,
    )


def _generate(
    channel: ImageChannel, *, prompt: str, image_urls: list[str], size: str, n: int, resolution: str = "",
) -> list[bytes]:
    """Provider 生成 n 张图. 不论 sync (tu-zi) 还是 async poll (apimart), 底层
    `client.generate(n=1)` 始终, 多张通过 fan-out (N 个并发 1-shot) 实现.

    设计权衡:
    - 老路径: sync provider 一次 POST n=N, 期望 response.data 长度 N. 实测不可靠
      (gpt-image-2 / doubao-seedance 等模型 n>1 是否真返 N 不确定), 而且 apimart
      协议硬限制 n=1.
    - 新路径: 1 call = 1 image 通用契约, provider 无关. n=4 用 ThreadPoolExecutor
      并发 4 个调用, 时长 ≈ 单次延迟. tu-zi 抖到经常宕机时 fallback 也能凑齐 N 张.

    部分失败: 拿到的成功部分返回, 上游 _load_or_skip 的 partial_refund 退 (N-actual)
    credit. 全失败抛 → task FAILED → rollback 全部 credit.
    """
    if n == 1:
        return [_single_generation(
            channel, prompt=prompt, image_urls=image_urls, size=size, resolution=resolution,
        )]

    # 兜底: serializer 允许 1/2/4 但万一上层放开 num_images, 不让 thread 数无界涨
    results: list[bytes] = []
    with ThreadPoolExecutor(max_workers=min(n, 8)) as pool:
        futures = [
            pool.submit(
                _single_generation, channel,
                prompt=prompt, image_urls=image_urls, size=size, resolution=resolution,
            )
            for _ in range(n)
        ]
        for f in as_completed(futures):
            try:
                results.append(f.result())
            except Exception:
                logger.exception("image_gen fan-out: single call failed: channel=%s", channel.label)
    if not results:
        raise RuntimeError(f"image_gen fan-out: all {n} parallel calls failed: channel={channel.label}")
    return results


# 每个 provider 试 _RETRY_ATTEMPTS 次, 之间隔 _RETRY_BACKOFF_SECONDS. 给 provider
# 短暂 transient (image fetch 抖动 / channel rotate) 一个机会, 再 escalate 到 fallback.
# 真业务错误最多浪费 2 次 quota + 3s 等待 — 比 task FAILED + 用户重 click 链路短.
# (HTTP 5xx/429 已被 image_client 的 make_retry_session 在更底层 cover, 这里覆盖
# 4xx 业务码 + RuntimeError 异步任务失败 等 transient 模式.)
_RETRY_ATTEMPTS = 2
_RETRY_BACKOFF_SECONDS = (0, 3)


def _call_with_retries(
    channel: ImageChannel, *, prompt: str, image_urls: list[str], size: str, n: int, resolution: str = "",
) -> list[bytes]:
    """Wrap _generate with attempt-level retry. ValueError/TypeError 不重试 (编码 bug).
    HTTP 4xx (除 408/425/429) 不 retry —— schema/quota/auth 类错误重发同 payload 永远
    同样失败, 浪费 quota + sleep, 直接 fall through 到 fallback provider 更省."""
    last_exc: Exception | None = None
    for attempt in range(_RETRY_ATTEMPTS):
        if _RETRY_BACKOFF_SECONDS[attempt]:
            time.sleep(_RETRY_BACKOFF_SECONDS[attempt])
        try:
            return _generate(
                channel, prompt=prompt, image_urls=image_urls, size=size, n=n, resolution=resolution,
            )
        except (ValueError, TypeError):
            raise
        except requests.HTTPError as exc:
            # 只命中 provider 生成接口的 HTTPError; 源图内联下载失败是
            # SourceImageDownloadError (非 HTTPError 子类), 落到下面 except Exception 的
            # transient 分支重试, 不会被当成"确定性 4xx"直接放弃。
            status = exc.response.status_code if exc.response is not None else None
            if status is not None and 400 <= status < 500 and status not in (408, 425, 429):
                logger.warning(
                    "image_gen attempt %d/%d hit %d (deterministic 4xx): channel=%s err=%s",
                    attempt + 1, _RETRY_ATTEMPTS, status, channel.label, exc,
                )
                raise
            last_exc = exc
            logger.warning(
                "image_gen attempt %d/%d failed: channel=%s err=%s",
                attempt + 1, _RETRY_ATTEMPTS, channel.label, exc,
            )
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "image_gen attempt %d/%d failed: channel=%s err=%s",
                attempt + 1, _RETRY_ATTEMPTS, channel.label, exc,
            )
    assert last_exc is not None  # _RETRY_ATTEMPTS >= 1 保证至少 1 次 except 命中
    raise last_exc


def _generate_with_fallback(
    *, prompt: str, image_urls: list[str], size: str, n: int, resolution: str = "",
    channel: ImageChannel | None = None,
) -> list[bytes]:
    """生成 n 张图, 带重试, 必要时切备用通道.

    `channel` 是用户在前端**显式选中**的通道 (工具栏的模型选择器 / agent 的 model 参数)。
    给了就只用它, **失败不回退** —— 换供应商会换出完全不同的画风, 而用户并不知道发生了
    什么; 明确告诉他"这个通道失败了"才是对的。

    没给 (老路径 / 库里还没配) 才走 env: primary (with retries) 抛 → 切 fallback。同
    task 内 try/except, credit_event 保 PENDING 不被 _load_or_skip rollback (Stage 4
    commit/rollback 终态不可逆, 跨 task 重试会撞 InvalidUsageEventState; 同 task 内
    fallback 安全)。

    Fallback 配置可选: CANVAS_IMAGE_FALLBACK_MODEL 未设时不切换, primary 错误冒泡
    → _load_or_skip rollback 退 credit. 这让 dev 环境无 fallback 配也行得通.
    """
    if channel is not None:
        try:
            return _call_with_retries(
                channel, prompt=prompt, image_urls=image_urls, size=size, n=n, resolution=resolution,
            )
        except Exception as exc:
            # 显式选择不回退, 所以这里就是终点 —— 这条消息会原样变成 job.error, 再原样
            # 变成画布上那行红字。所以它必须自己说清楚两件事: 挂的是**哪个**通道, 以及
            # 我们**没有**替他换一个。否则用户看到的只是一句通用失败, 会以为产品坏了,
            # 而不是"这个供应商不行, 换一个模型再试"。
            #
            # 顺序是刻意的: job.error 会被截到 5000 字, 而供应商可能吐一整页 HTML。
            # 把"哪个通道 + 该怎么办"放在原始报文**之前**, 截断就只可能吃掉报文尾巴,
            # 永远吃不掉那句能让用户行动的话。
            raise RuntimeError(
                f"[{channel.label}] 生成失败, 已选定该模型故未自动切换其他通道 —— "
                f"可在工具栏换一个再试。供应商返回: {exc}"
            ) from exc
    try:
        return _call_with_retries(
            channel_from_env(_PRIMARY_PREFIX),
            prompt=prompt, image_urls=image_urls, size=size, n=n, resolution=resolution,
        )
    except Exception:
        if not os.getenv(f"{_FALLBACK_PREFIX}_MODEL"):
            raise
        logger.exception(
            "canvas image_gen: primary failed after retries, trying fallback: channel=%s",
            _FALLBACK_PREFIX,
        )
        return _call_with_retries(
            channel_from_env(_FALLBACK_PREFIX),
            prompt=prompt, image_urls=image_urls, size=size, n=n, resolution=resolution,
        )


def _generate_and_persist(job: ImageEditJob) -> list[ImageEditResult]:
    # source_images entries: storage path ("library/.../foo.jpg") for multipart
    # upload, OR absolute URL ("https://.../foo.jpg") for agent chat attachment.
    # 空 = text-to-image。本地 / our-media 源读盘内联成 data URI(见
    # source_to_inline_uri),只有外部公网 URL 才原样走 URL。
    image_urls: list[str] = []
    if job.source_images:
        image_urls = [source_to_inline_uri(p) for p in job.source_images]
    elif job.source_image:
        image_urls = [source_to_inline_uri(job.source_image)]

    # data URI 自包含,无需可达性检查;只对 http(s) 远程源做 fail-loud 预检
    # (provider 拿不到 source URL 会静默退化成纯文生图)。data URI / 空 都跳过。
    for url in image_urls:
        if url.startswith(("http://", "https://")):
            assert_source_url_reachable(url)

    image_bytes_list = _generate_with_fallback(
        prompt=job.prompt,
        image_urls=image_urls,
        size=job.size or "1024x1024",
        n=job.num_images,
        resolution=job.resolution or "",
        # 用户选的通道(工具栏选择器 / agent 参数)。None = 没选 → 回退 env primary→fallback。
        channel=channel_for_model_id(job.image_model_id),
    )
    return _persist_results(job, image_bytes_list)


# ---------------------------------------------------------------------------
# rembg cutout path
# ---------------------------------------------------------------------------

def _rembg_remove(source_bytes: bytes) -> bytes:
    """Isolate the heavy import so web process never loads onnxruntime on boot.

    `rembg.remove` triggers a lazy onnx model download on first call
    (`~/.u2net/u2net.onnx`, ~170MB). docker worker_canvas caches to the
    container's home; Dockerfile pre-bakes the model to cut cold-start.

    Footgun guard: rembg 是阻塞 CPU, 在 gevent 单进程下会冻死整个 event loop
    + 100 greenlet. 配错组合 (CANVAS_REMBG_ENABLED=true + worker_canvas 跑
    gevent) 时让第一个 job 就显式炸, 避免静默假死。
    """
    if is_gevent_patched():
        raise RuntimeError(
            "rembg cannot run under gevent pool — blocking CPU freezes the event loop. "
            "Either set CANVAS_REMBG_ENABLED=false, or switch worker_canvas back to prefork "
            "(docker-compose: -c 4 -Ofair --max-tasks-per-child=200, drop -P gevent)."
        )
    from rembg import remove  # noqa: PLC0415 — intentional lazy import
    return remove(source_bytes)


_ALPHA_BINARIZE_THRESHOLD = 128


def _binarize_alpha(image_bytes: bytes, threshold: int = _ALPHA_BINARIZE_THRESHOLD) -> bytes:
    """rembg 灰边修复: u2net 在主体边缘吐 soft mask (alpha 0-255 过渡值) → 看着
    是灰色 halo. 二值化 alpha: > threshold 留 255, ≤ threshold 转 0, 一刀切。
    RGB 通道完全不动 — 主体内的白像素 (alpha=255) 安全保留, 不会被误删。
    代价: 边缘锯齿 (没了 anti-alias). 1024×1024 cutout 视觉可接受;
    再要平滑可换 rembg(alpha_matting=True) 但慢 2-3 倍。"""
    from io import BytesIO  # noqa: PLC0415 — lazy 避免 web 进程顶层加载 PIL
    from PIL import Image  # noqa: PLC0415

    img = Image.open(BytesIO(image_bytes))
    if img.mode != "RGBA":
        # rembg 偶发返 RGB (主体识别失败) → 没 alpha 可二值化, 原样返
        return image_bytes
    r, g, b, a = img.split()
    a = a.point(lambda p: 255 if p > threshold else 0)
    img = Image.merge("RGBA", (r, g, b, a))
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _cutout_and_persist(job: ImageEditJob) -> list[ImageEditResult]:
    """Stage 2: 读 LLM 已抠好的纯白底图 (intermediate_image), 用 rembg 把白转
    alpha 拿真透明 PNG. 单图算法 — multi 同 stage 1 一致拒掉。

    Fallback 顺序: intermediate_image (stage 1 LLM 产物) > source_image (没经
    过 stage 1, e.g. 测试 / 直接派发 stage 2 / stage 1 字段 race condition).
    fallback 让本函数能脱离 stage 1 单独跑, 也兜底 race 不让 job 卡死。

    成功后清理 intermediate_image (LLM 中间产物 stage 2 完就没用了), 否则
    qiniu/local 盘逐月累积. 失败时保留方便 inspect/手动重试 stage 2。
    """
    if job.source_images:
        # View 层已拦住, 这里作为 service 级最终防线 —— 抠图是单图算法, 多图
        # 无合成或遴选语义, 静默挑第一张会让用户以为配置被接受了.
        raise RuntimeError("cutout mode cannot combine multiple images")

    rembg_input = job.intermediate_image or job.source_image
    if not rembg_input:
        raise RuntimeError("cutout job requires intermediate_image or source_image")

    with rembg_input.open("rb") as f:
        source_bytes = f.read()
    output_bytes = _rembg_remove(source_bytes)
    output_bytes = _binarize_alpha(output_bytes)  # 灰边修复
    results = _persist_results(job, [output_bytes])

    # 成功路径才清理 — 失败时保留 intermediate 让运维能 inspect / 重跑 stage 2
    if job.intermediate_image:
        try:
            job.intermediate_image.delete(save=True)
        except Exception:
            # 删除失败不影响主流程, log 让 Sentry 抓到后续手动清理
            logger.exception(
                "cutout: intermediate_image cleanup failed: job=%s, path=%s",
                job.id, job.intermediate_image.name,
            )
    return results


def run_cutout_llm_step(job: ImageEditJob) -> None:
    """Stage 1 of 2-stage cutout pipeline.

    调 LLM (CUTOUT_LLM_PROMPT, 要求纯白背景) 抠出主体, bytes 写到
    job.intermediate_image. Stage 2 (`_cutout_and_persist`, 跑在 worker_canvas_cpu
    prefork) 接力把白底转 alpha.

    本函数跑在 worker_canvas (gevent) — LLM HTTP 调用是 IO-bound, gevent 单进程
    撑 100 并发不冻其他任务.

    Raises 由外层 `_run_cutout_llm_step_or_skip` (tasks.py) 接住做 billing
    rollback + status 标 FAILED + split partner 退款检查。
    """
    if job.source_images:
        raise RuntimeError("cutout mode cannot combine multiple images")
    if not job.source_image:
        raise RuntimeError("cutout job requires source_image")

    source_url = source_to_inline_uri(job.source_image)
    if source_url.startswith(("http://", "https://")):
        assert_source_url_reachable(source_url)

    # 框选标注在 plan B 下不烧进源图, 而是变成 job.prompt 拼在 CUTOUT_LLM_PROMPT 后:
    #   - cutout 按钮: job.prompt = 框选 marquee prompt(区域坐标 + 文字编辑, 自带表述)
    #   - split cutout leg: job.prompt = subjectRegionClause(主体区域坐标, 自带表述)
    # 两者都自带表述, 直接拼接即可; 无标注(空)就纯抠最显眼主体。
    extra = (job.prompt or "").strip()
    cutout_prompt = f"{CUTOUT_LLM_PROMPT}\n\n{extra}" if extra else CUTOUT_LLM_PROMPT

    image_bytes_list = _generate_with_fallback(
        prompt=cutout_prompt,
        image_urls=[source_url],
        size=job.size or "1024x1024",
        n=1,  # cutout 永远 1 张, num_images 上层 serializer 已 enforce
        resolution=job.resolution or "",
        channel=channel_for_model_id(job.image_model_id),
    )
    if not image_bytes_list:
        raise RuntimeError("cutout LLM stage returned no images")

    # 保存 LLM 输出到 intermediate_image, stage 2 从这里读
    saved_name = f"{uuid.uuid4().hex}.png"
    job.intermediate_image.save(
        saved_name, bytes_to_django_file(image_bytes_list[0], saved_name), save=False,
    )
    job.save(update_fields=["intermediate_image", "updated_at"])
    logger.info(
        "cutout LLM stage done: job=%s, intermediate=%s, bytes=%d",
        job.id, job.intermediate_image.name, len(image_bytes_list[0]),
    )


# ---------------------------------------------------------------------------
# Agent tool: chat-driven async generation
# ---------------------------------------------------------------------------

def enqueue_image_generation(
    *,
    prompt: str,
    size: str,
    n: int,
    scene_id: str,
    image_urls: list[str] | None = None,
    image_model_id: str | None = None,
) -> str:
    """Pure-args helper: create ImageEditJob + reserve credit + enqueue Celery + return confirmation.

    Split from the @tool wrapper so tests can call it without ToolRuntime injection.
    Reserve 失败 → reserve_or_friendly_message 返 LLM 友好字符串 (Canvex 免费 stub
    恒返 None, 所以始终放行; 保留调用为将来接计费留口).

    `image_urls` (when provided) goes into `source_images` so the worker
    sends them to the provider as `image_urls=[...]` for image-to-image
    edit / variation. Empty → text-to-image (provider gets prompt only).
    """
    # Lazy import: tasks → image.py → tools 循环依赖避开
    from studio.tasks import canvas_image_edit_job_task

    num = max(1, min(4, int(n)))
    # Defensive: agent might pass garbage. Filter to public http(s) URLs;
    # `_generate_and_persist` will additionally `assert_source_url_reachable`.
    clean_urls = [
        u for u in (image_urls or [])
        if isinstance(u, str) and (u.startswith("http://") or u.startswith("https://"))
    ]
    with transaction.atomic():
        job = ImageEditJob.objects.create(
            scene_id=scene_id,
            prompt=prompt,
            size=size or "1024x1024",
            num_images=num,
            is_cutout=False,
            source_image=None,
            source_images=clean_urls,  # absolute URLs from chat attachments
            status=ImageEditJob.Status.QUEUED,
            # 这条路是异步的 —— worker 之后才捞这行, 所以选择必须落在行上。
            image_model_id=image_model_id or None,
        )
        reserve_error = reserve_or_friendly_message(job, action_label="image generation")
        if reserve_error:
            # Canvex billing 是 no-op stub:reserve_error 恒为 None,本分支不触发。
            # 保留与 meired 一致的调用形状(将来接计费时 helper 会 set_rollback 回滚 atomic)。
            return reserve_error
    job_id = enqueue_on_commit(job, canvas_image_edit_job_task)
    logger.info(
        "enqueue_image_generation: job %s scene %s n_refs %d",
        job_id, scene_id, len(clean_urls),
    )
    return (
        f"Image generation queued (job_id={job_id}, n={num}). "
        f"The image will appear on the canvas shortly."
    )


@tool
def generate_image(
    prompt: str,
    size: str = "1024x1024",
    n: int = 1,
    image_urls: list[str] | None = None,
    label: str | None = None,
    slot_index: int | None = None,
    runtime: ToolRuntime[CanvasAgentContext] = None,
) -> str:
    """Generate one or more images. Two distinct modes — pick the right one:

    1. **Text-to-image** (no `image_urls`): pure generation from prompt
       describing a NEW image from scratch. Use when the user wants
       something they haven't shown you.

    2. **Image-to-image** (with `image_urls`): edit / transform / restyle /
       re-angle existing images. **You MUST use this mode whenever the
       user has attached images for this turn via "Send to chat" — the
       attachment URLs appear in the `[Canvas attachments for this turn]`
       system message. Passing them as `image_urls` is the ONLY way the
       result will be based on the user's actual image. Describing the
       image in `prompt` instead does text-to-image and generates an
       unrelated picture — that is almost always the wrong behavior.**

    The job runs asynchronously; the image will appear on the user's
    canvas when generation completes (typically 15–30 seconds).

    Args:
        prompt: For text-to-image: full description of the new image.
            For image-to-image with `image_urls`: the EDIT instruction
            (e.g. "in oil painting style", "from a top-down angle",
            "with the background removed") — NOT a re-description of
            the input image (the model already sees it).
        size: aspect ratio string. Common values: "1:1" (square),
            "3:2" / "16:9" (landscape), "2:3" / "9:16" (portrait), "auto"
            (match source). Canvas provider is ratio-native; legacy pixel
            strings like "1024x1024" still work via internal coercion but
            ratios are canonical.
        n: How many images to generate (1, 2, or 4).
        image_urls: Reference image URLs for image-to-image mode. When
            the user attaches images via "Send to chat", pass those URLs
            here verbatim — do NOT modify or omit them.
        label: Optional permanent caption to display ABOVE the resulting
            image on canvas (e.g. "1-主图-纯白背景"). Survives after the
            image arrives. Used by multi-image pack skills to give each
            slot a stable title; omit for ad-hoc generations.
        slot_index: Optional 0-based index used by multi-image pack skills
            to lay slots out HORIZONTALLY in a row (slot_index=0 .. N-1).
            When set, the placeholder is positioned at base_x + slot_index ×
            (width + gap) on a shared row. Omit for default vertical chat-
            column stacking. **Setting `slot_index` implies the call is part
            of a coordinated img2img pack** — the tool refuses if no source
            image is available (neither via `image_urls` nor via this turn's
            "Send to chat" attachment), since a pack without a shared source
            produces N unrelated outputs.

    Returns:
        A short confirmation string naming the enqueued job id.
    """
    if runtime is None or runtime.context is None:
        raise RuntimeError("generate_image requires CanvasAgentContext via ToolRuntime")
    ctx = runtime.context
    # Fallback: agent often forgets to thread the attachment URLs (gpt-4o-mini
    # in particular hallucinates a "started" confirmation without actually
    # calling the tool correctly). If user attached images this turn and the
    # agent didn't pass any, inject them automatically — matches user intent
    # ("they ran Send-to-chat to make these images influence generation").
    if not image_urls and ctx.attachment_urls:
        image_urls = list(ctx.attachment_urls)
        logger.info(
            "generate_image: auto-injected %d attachment URLs (agent omitted) scene %s",
            len(image_urls), ctx.scene_id,
        )
    # Multi-image pack guard: `slot_index`-bearing calls belong to a coordinated
    # pack (e.g. amazon-listing-pack-sop). The whole point is N angles of ONE
    # product sharing an img2img source. If the source is missing (neither
    # agent-passed nor user-attached this turn), every angle becomes text-to-
    # image from a generic "this product" prompt → N unrelated random products,
    # which the user reads as "牛头不对马嘴". Refuse at the tool layer as
    # defense-in-depth: SKILL.md preflight catches 95%, this catches the cases
    # where the agent ignores it (gpt-4o-mini occasionally does).
    if slot_index is not None and not image_urls:
        logger.warning(
            "generate_image: refusing pack slot_index=%d (label=%r) — no source image"
            " (image_urls empty, ctx.attachment_urls empty) scene %s",
            slot_index, label, ctx.scene_id,
        )
        return (
            f"{REFUSED_PREFIX} multi-image pack call requires a source image. "
            "The user must select a product image on canvas and click "
            "'Send to chat' to attach it for reference, then re-send. Reply to "
            "the user with this instruction in their language and do NOT retry "
            "until they attach."
        )
    # Pack-call must be n=1: each slot is one shot. n>1 with slot_index makes
    # the frontend stack N placeholders all at the same slot x (same column),
    # since the agent only passes one slot_index per call. If agent confused
    # `n=4 variants` with `n=4 angles`, refuse + tell it to dispatch separate
    # calls per angle with distinct slot_index values.
    if slot_index is not None and n != 1:
        logger.warning(
            "generate_image: refusing pack slot_index=%d with n=%d (must be n=1)"
            " label=%r scene %s",
            slot_index, n, label, ctx.scene_id,
        )
        return (
            f"{REFUSED_PREFIX} pack call (slot_index set) must be n=1 — each "
            "angle of a multi-image set is a separate generate_image call with "
            "its own slot_index. Dispatch N parallel calls (slot_index=0..N-1, "
            "each n=1) instead of one call with n>1. Reply to the user in their "
            "language if needed."
        )
    # SKILL-bypass guard: gpt-4o-mini occasionally tries to fake a pack by
    # calling generate_image ONCE with n=4 and a paragraph prompt asking for "a
    # set of 7 images" / "套图". One call with one prompt produces N variants of
    # the SAME composition, not N coordinated angles — the user gets 4 random
    # listings instead of the 7-angle pack. Detect via _PACK_KEYWORDS (high-
    # specificity tokens) + _PACK_ZHANG_PATTERN (digit + 张); both module-level
    # so we don't recompile per call. FP cost = 1 lost turn; FN cost = wasted
    # credits + user "牛头不对马嘴". Bias toward FN: only refuse on clear hits.
    if slot_index is None and n >= 2:
        prompt_lower = prompt.lower()
        # Short-circuit: keyword check first (cheap substring scans), regex
        # only if no keyword matched. Both paths refuse identically; ordering
        # just saves the regex scan when a keyword wins.
        keyword_hit = any(k in prompt_lower for k in _PACK_KEYWORDS)
        zhang_hit = bool(_PACK_ZHANG_PATTERN.search(prompt_lower)) if not keyword_hit else False
        if keyword_hit or zhang_hit:
            logger.warning(
                "generate_image: refusing SKILL-bypass — n=%d, no slot_index, "
                "matched keyword=%s zhang_pattern=%s; scene %s; prompt[:120]=%r",
                n, keyword_hit, zhang_hit, ctx.scene_id, prompt[:120],
            )
            return (
                f"{REFUSED_PREFIX} this looks like a multi-image listing pack "
                "request (prompt contains 套图/listing/digit+张 vocabulary + "
                "n≥2). One call with one prompt cannot produce a coordinated "
                "multi-angle set. Load the appropriate SKILL first via "
                "`read_file(file_path=\"/skills/amazon-listing-pack-sop/SKILL.md\")`, "
                "then dispatch the SKILL's prescribed parallel calls (each with "
                "its own slot_index and a focused single-angle prompt). Reply to "
                "the user in their language explaining the workflow change; do "
                "NOT retry this same call shape."
            )
    return enqueue_image_generation(
        prompt=prompt, size=size, n=n, image_urls=image_urls,
        scene_id=ctx.scene_id,
        # 用户在工具栏选的模型, 每轮从前端透传进来 (和 attachment_urls 同一条路)。
        image_model_id=ctx.image_model_id,
    )


def _persist_results(
    job: ImageEditJob, image_bytes_list: Iterable[bytes],
) -> list[ImageEditResult]:
    """LLM / cutout 两条路径共用: 把 bytes 落 DataAsset + ImageEditResult 行."""
    return persist_canvas_image_results(
        job, image_bytes_list,
        result_model=ImageEditResult,
        filename_prefix="canvas-edit",
    )
