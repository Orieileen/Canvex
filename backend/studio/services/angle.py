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
  一致: job_lifecycle 管 status 翻转 + error 持久化, IO 在 `_job_source_uri` +
  `submit_angle` + `_download_result_images`.

**Provider 选型**: fal.run (sync endpoint), 单次 POST 阻塞 15-30s. 不用 queue API +
polling 是因为 LoRA 推理够短, sync 体感更简单 (错误模型比 "提交 task_id → 轮询
status → 拉结果" 三段少一跳). 若 timeout, 换成 queue.fal.run 再说.

**鉴权**: fal 用 `Authorization: Key <key>`, 不是 Bearer.
"""
import logging
from typing import Iterable

import requests
from django.core.files.storage import default_storage
from django.db import transaction
from rest_framework.exceptions import ValidationError

from studio.services.http_retry import make_retry_session

from ..models import AngleJob, AngleResult, ImageProvider
from . import save_canvas_source_image
from .image_channels import channel_or_default
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

# 配置面板「测试」按钮专用: **不重试**。worker 里重试是对的 (用户不在场, 多等 7 秒好过
# 一次 FAILED), 但测试是一次同步 HTTP 请求, 浏览器和反代都在等着 —— 带上默认的 total=3
# 会把 ImageProviderTestView 那个 60s 预算悄悄乘成 4 分钟 (4×60s + 1/2/4s 退避), 用户
# 拿到的是一句通用网络错误, 而这个接口存在的全部价值就是把供应商的原始报文放到他眼前。
_probe_session = make_retry_session(total=0)

logger = logging.getLogger(__name__)


def resolve_angle_channel(job: AngleJob) -> ImageChannel:
    """这次 angle 调用用哪套配置。跟生图路径同一套顺序:

    1. job 行上选的通道 (用户在 Angle tab 里挑的)
    2. 库里第一条启用的 angle 通道 —— 排队期间那条被删了才会走到这
    3. 都没有 → 抛, 由 job_lifecycle 落成 FAILED

    配置只有库一个来源: `CANVAS_ANGLE_FAL_*` 那一级连同「后端默认」一起去掉了。老部署的
    env 值由 0010 迁移一次性导进库, 之后就在界面上改。

    复用 ImageChannel 而不是给 angle 单开一个 dataclass: 这里只用得上它的 base_url /
    api_key / model / timeout / label 五个字段, 为剩下的十几个用不上的字段再造一个平行
    类型, 换来的只是"字段更少"。请求体的差异在 `submit_angle` 里, 不在配置形状里。
    """
    channel = channel_or_default(job.image_model_id, ImageProvider.Kind.ANGLE)
    if channel is None:
        raise RuntimeError(
            "还没有配置 Angle 供应商 —— 在左侧栏点「配置供应商」加一个 Angle 通道。"
        )
    return channel


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
        channel = resolve_angle_channel(job)
        # 源图准备留在 try **外面**。它失败(PUBLIC_MEDIA_BASE 配错 / 隧道断了 / 源图
        # 404)是**我们这边**的问题, 套上"这个供应商不行, 换一个"的壳只会把人指向错的
        # 方向 —— 换十个供应商也修不好一个拉不到的源图。生图路径同理: 那边的
        # assert_source_url_reachable 也在 _generate_on_channel 之外。
        source = _job_source_uri(job)
        try:
            response = submit_angle(
                channel,
                image_url=source,
                horizontal_angle=job.horizontal_angle,
                vertical_angle=job.vertical_angle,
                zoom=job.zoom,
                num_images=job.num_images,
                additional_prompt=job.additional_prompt,
                log_ref=str(job.id),
            )
        except Exception as exc:
            # 跟生图路径同一条约定: 这条消息会原样变成 job.error 再变成画布上那行红字,
            # 所以先说清是**哪条**通道挂的、我们没替他换 —— 否则用户只看到一句通用失败,
            # 会以为产品坏了, 而不是"这个供应商不行, 换一个"。原始报文放在后面, 截断
            # 只会吃掉它的尾巴。
            raise RuntimeError(
                f"[{channel.label}] 视角生成失败, 未自动切换其他通道 —— "
                f"可在工具栏换一个再试。供应商返回: {exc}"
            ) from exc
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

def submit_angle(
    channel: ImageChannel,
    *,
    image_url: str,
    horizontal_angle: float,
    vertical_angle: float,
    zoom: float,
    num_images: int = 1,
    additional_prompt: str = "",
    log_ref: str = "",
    session: requests.Session | None = None,
) -> dict:
    """往一条 angle 通道发一次同步请求, 返回 fal 的 JSON。

    单独一个函数是因为**配置面板的「测试」按钮也必须走这条路**: angle 通道的请求形状跟
    生图完全不同 (模型名在 URL 路径里、认证是 `Key`、请求体是相机坐标), 拿生图那套去测
    一条 angle 通道只会得到一个跟配置无关的 404 —— 配得对的人也会被告知"测试失败", 而
    测试按钮正是没有内置预设之后唯一的反馈回路。

    `session` 留给调用方换重试策略 (worker 要重试, 同步的测试按钮不要), 默认走模块级的
    那个带 retry 的。
    """
    # fal 把模型名放在 URL 路径里 (而不是请求体的 model 字段) —— 这正是 angle 不能
    # 套用生图那套 ImageClient 的原因之一。
    endpoint = f"{channel.base_url.rstrip('/')}/{channel.model}"

    body: dict = {
        "image_urls": [image_url],
        "horizontal_angle": horizontal_angle,
        "vertical_angle": vertical_angle,
        "zoom": zoom,
        "num_images": num_images,
    }
    if additional_prompt:
        body["additional_prompt"] = additional_prompt

    logger.info(
        "angle submit: ref=%s channel=%s endpoint=%s h=%.1f v=%.1f z=%.1f n=%d",
        log_ref, channel.label, endpoint, horizontal_angle, vertical_angle,
        zoom, num_images,
    )
    resp = (session or _session).post(
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
    # 形状检查必须在取字段**之前**: 出错时的报文不一定是对象 —— base_url 指错时中间的
    # 网关/反代常回一个裸字符串或数组, 那时 `data.get(...)` 抛的是
    # `AttributeError: 'str' object has no attribute 'get'`, 恰好把供应商的真实报文
    # 换成一句看不懂的话, 而这条路径 (测试按钮 / 画布上那行红字) 正是要看清报文的地方。
    if not isinstance(data, dict):
        raise RuntimeError(
            f"angle submit HTTP {resp.status_code} unexpected payload: {data!r}"[:1000]
        )
    if resp.status_code >= 400:
        # fal 错误格式通常 {"detail": "..."} 或 {"message": "..."}; 两个都兜
        detail = data.get("detail") or data.get("message") or str(data)
        raise RuntimeError(f"angle submit HTTP {resp.status_code}: {detail}")
    return data


def probe_angle_channel(channel: ImageChannel, *, image_url: str) -> int:
    """配置面板「测试」按钮的 angle 版 —— 发一次最小的真实调用, 返回拿到的图片字节数。

    必须存在而不是复用生图那条: angle 的请求形状完全不同 (模型名在 URL 路径里、认证是
    `Key`、请求体是相机坐标)。拿 `_single_generation` 去测一条 angle 通道, POST 的是
    `{base_url}/images/generations` + `Bearer` —— 配得完全正确的通道也必然 404, 而这个
    按钮是没有内置预设之后唯一的反馈回路, 一句假的"测试失败"比没有还糟。

    角度取正面默认值 (h=0 / v=0 / zoom=5, 与 AngleJobCreateSerializer 的 default 一致),
    图用调用方给的探针 —— 这里问的是"端点/密钥/模型名对不对", 不是构图。

    全程走 `_probe_session` (不重试): 这是一次同步 HTTP 请求, 上面 view 给的墙钟预算只
    钳得住单次超时, 重试会把它整倍数放大。
    """
    response = submit_angle(
        channel,
        image_url=image_url,
        horizontal_angle=0.0,
        vertical_angle=0.0,
        zoom=5.0,
        num_images=1,
        log_ref="provider-test",
        session=_probe_session,
    )
    # 真把图拉回来 —— 200 但结果里没有图同样是"配错了", 只看 HTTP 码会漏掉它。
    return len(_download_result_images(response, session=_probe_session)[0])


def _job_source_uri(job: AngleJob) -> str:
    """job 行上的源图 URL → 可以直接下发给 fal 的那个字符串。

    我们自己的 media 读盘内联成 base64 data URI(免公网 URL / 隧道);外部公网 URL
    原样传 + 可达性预检(防 fal 拿不到源时静默 rerender 无关图)。fal 接受 data URI。
    """
    source = source_to_inline_uri(job.source_image_url)
    if source.startswith(("http://", "https://")):
        assert_source_url_reachable(source)
    return source


def _download_result_images(
    response: dict, *, session: requests.Session | None = None,
) -> list[bytes]:
    images = response.get("images") or []
    if not images:
        raise RuntimeError(f"angle response has no images: keys={list(response.keys())}")
    out: list[bytes] = []
    for item in images:
        url = item.get("url") if isinstance(item, dict) else None
        if not url:
            raise RuntimeError(f"angle image entry missing 'url': {item!r}")
        r = (session or _session).get(url, timeout=DOWNLOAD_TIMEOUT)
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
