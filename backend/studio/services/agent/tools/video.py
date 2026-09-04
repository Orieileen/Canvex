"""Video generation / long-poll execution (Canvex 独立版).

One code path: OpenAI-compat HTTP (POST to submit, GET to poll). Does NOT
download the MP4; stores the provider's URL directly on VideoJob.

配置来自库里用户在前端配的 `kind=video` 供应商 (见 resolve_video_channel) —— 原来那一路
`CANVAS_VIDEO_*` env 已经去掉, 老部署的值由迁移 0013 一次性导进库。

解耦自 meired apps/canvas/services/agent/tools/video.py:
- 计费 import 路径改 studio.services.billing(stub no-op,调用全保留)。
- 模型无 organization / user → enqueue 时不再 set,签名去掉 org_id / user_id。
- 跨租户 scope 防护(enqueue_scope_or_friendly_message)不 port:单工作区无跨
  租户面。SSRF 公网 URL 过滤(is_public_http_url)保留。
"""
import logging
import time
from typing import Any
from urllib.parse import quote

import requests
from django.db import transaction
from langchain.tools import ToolRuntime, tool

from studio.models import ImageProvider, VideoJob
from studio.services.billing import reserve_or_friendly_message
from studio.services.http_retry import make_retry_session
from studio.services.image_channels import KIND_SPECS, require_channel, resolve_model_id
from studio.services import channel_health, template_client
from studio.services.image_client import (
    RATIO_PARAM_CHOICES,
    ImageChannel,
    nearest_duration,
    parse_durations,
    resolve_ratio,
    resolve_resolution,
)
from studio.services.listings_utils import DONE_STATUSES, FAILED_STATUSES

from ..context import CanvasAgentContext
from .common import (
    assert_source_url_reachable,
    enqueue_on_commit,
    is_public_http_url,
    job_lifecycle,
    our_media_relpath,
    source_for_channel,
)

logger = logging.getLogger(__name__)

# Module-level Session: 同一个 video provider 的 submit + poll 复用 TCP + 共享
# Retry policy. 第一个 task 跑时 lazy 创建, 后续 task 复用.
_session = make_retry_session()


# canvas video providers occasionally ship "done" as the completion keyword
# (e.g. tu-zi); listings' set doesn't need it, so extend here.
_DONE_STATUSES = DONE_STATUSES | {"done"}
_FAILED_STATUSES = FAILED_STATUSES


def resolve_video_channel(job: VideoJob) -> ImageChannel:
    """这条任务该用哪个视频通道: job 行上选的那条, 没选/已失效就退到库里第一条。

    配置只有库一个来源 —— `CANVAS_VIDEO_*` 那一路 env 已经去掉, 老部署的值由迁移 0013
    一次性导进库。复用 ImageChannel 而不是给视频单开一个 dataclass: 它用得上的正好是
    base_url / api_key / model / timeout + 那套轮询参数, 全是现成字段; 请求体的差异在
    `_submit` 里, 不在配置形状里。
    """
    return require_channel(job.image_model_id, ImageProvider.Kind.VIDEO, noun="视频生成")


def run_video_job(job: VideoJob) -> None:
    """Execute `job` end-to-end: submit → long-poll → persist result URL.

    Raises on failure (after marking job FAILED + persisting error).
    Blocks the caller for up to sum of all poll intervals — Celery worker only.
    """
    with job_lifecycle(job, success_extra_fields=("result_url", "thumbnail_url")):
        # 在 with 里解析通道, 这样"没配供应商"会走 FAILED 分支落到 job.error 上,
        # 而不是变成一个只有日志里能看到的异常 (跟 image.py 的 client 初始化同款)。
        channel = resolve_video_channel(job)

        # 源图变形在**分流之前** —— 同 image.py `_generate_and_persist`。具体变成什么由
        # 通道决定 (见 source_for_channel): 收 base64 的内联成 data URI, 只收公网地址的
        # 先推给供应商换一个它托管的 URL。外部公网图两种情况都原样传。
        #
        # **别再挪回任何一条分支里**: job.image_urls 里存的就是
        # `http://localhost:28000/media/...` —— services/video.py:37 和本文件那个 agent
        # 入口都是拿「提交时会处理」当前提, 才敢把一个外部不可达的地址存进库 (那两行注释
        # 写着 "inlined from storage at submit, no public URL needed")。这个前提对**每条
        # 通道**都必须成立; 之前只有内置分支兑现, 模板分支把 localhost 地址原样发给了
        # 供应商, 表现是供应商回一句"抓不到你的图", 看起来像通道配错了。
        image_urls = [source_for_channel(channel, u) for u in (job.image_urls or [])]
        # data URI 自包含, 无需可达性检查; 只对 http(s) 远程源做 fail-loud 预检。
        # 放在 channel_health.watch **之外**: 源图读不到 / 源站 404 是我们这端或源站的
        # 问题, 不该在通道卡片上给供应商记一个红点 (同 image.py)。
        for url in image_urls:
            if url.startswith(("http://", "https://")):
                assert_source_url_reachable(url)

        # 视频通道没有「测试」按钮 (出片要几分钟, 撑不过一次同步请求 —— 见 KIND_SPECS 的
        # untestable_reason), 所以**真实生成是它唯一的健康信号**。两个分支都在 watch 里,
        # 提交和轮询一起算 —— 用户眼里"生成一条视频"就是一次调用。
        #
        # 中间那行 job.save 也在里面。挪出去要把 watch 拆成两段 (task_id 必须在提交后
        # 立刻落库), 而它失败意味着库都写不动了 —— 那时 record 自己也写不进去, 只会记一
        # 条日志, 不会真在卡片上留下一个假红点。
        with channel_health.watch(channel):
            # 模板通道在这里整条分流出去: 提交、轮询、取结果全在用户填的模板里, 下面那套
            # `_submit` / `_poll_until_done` 的写死形状一条都不适用。
            # 同 image.py: 看 spec.template, 别按 kind 名字判。
            if KIND_SPECS[channel.kind].template:
                job.result_url = _template_video(job, channel, image_urls)
                return

            task_id = _submit(job, channel, image_urls)
            job.task_id = task_id
            job.save(update_fields=["task_id", "updated_at"])

            result = _poll_until_done(task_id, channel)
        job.result_url = result["url"]
        job.thumbnail_url = result.get("thumbnail_url", "")


def _template_video(job: VideoJob, channel: ImageChannel, image_urls: list[str]) -> str:
    """模板通道的整条视频生成 —— 返回结果地址。

    `image_urls` 是**已经按通道变形过**的 (调用方在分流前做, 见 run_video_job): 里面是
    data URI 或供应商能抓到的公网地址, 不会是 `http://localhost:28000/media/...`。别改回
    直接读 job.image_urls —— 模板里写 `{{images}}` 时 template_client 是原样透传的
    (只有 `{{images_base64}}` 才会去下载, 而那条对本机地址同样抓不到)。

    不落字节: 视频跟内置 video 通道一样只存外链 (`job.result_url`)。`task_id` 也不回写
    job 行, 因为那是内置形状的概念 (模板里叫什么、在哪一层, 由用户决定)。

    Session 用 template_client 那个共用的, 理由跟这个模块顶上的 `_session` 一样 ——
    提交 + 轮询是同一台主机的一串请求, 每个 job 新建一个 Session 等于每次都重连一遍。
    """
    # session 不传: video_variables / execute 都默认走 template_client.SHARED_SESSION。
    variables = template_client.video_variables(
        channel, prompt=job.prompt, image_urls=list(image_urls),
        duration=job.duration, aspect_ratio=job.aspect_ratio,
        resolution=job.resolution,
    )
    return template_client.item_to_url(template_client.execute(channel, variables))


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
    image_model_id: str | None = None,
    resolution: str = "",
) -> str:
    """Pure-args helper: create VideoJob + reserve credit + enqueue Celery + return confirmation.

    Reserve 失败 → LLM 友好字符串 (同 enqueue_image_generation; Canvex 免费 stub
    恒返 None, 始终放行)。
    """
    from studio.tasks import canvas_video_job_task

    duration_clamped = max(1, min(60, int(duration)))
    # SSRF 防护: 留我们自己的 media(提交时读盘内联)+ 公网 http(s) URL;LLM tool
    # call 被注入私网 IP 会被丢掉。
    raw_urls = [u for u in (reference_image_urls or []) if isinstance(u, str) and u.strip()]
    urls = [u for u in raw_urls if our_media_relpath(u) is not None or is_public_http_url(u)]
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
            # 不校验取值: 合法档是 per-model 的, 归一在 template_client 那边按
            # allowed_resolutions 做。LLM 写了个这个模型不收的档 → 落到最近的一档。
            resolution=(resolution or "").strip(),
            # 先过 resolve_model_id 再进 FK 列: 前端的选择是粘的 (localStorage), 一个被删掉
            # 的 id 会一直跟着每轮聊天发过来 —— 直接塞进外键的话, 合法 UUID 撞约束抛
            # IntegrityError, 不合法字符串抛 ValidationError, 两种都是把"选择已失效"变成
            # 整轮聊天 500。kind 也要筛: 一个生图模型 id 送到这里必须当作没选。
            image_model_id=resolve_model_id(image_model_id, ImageProvider.Kind.VIDEO),
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
    resolution: str = "",
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
        resolution: Optional quality tier, e.g. "720p" / "1080p" / "4k". Leave
            blank to use the provider default. Tiers the chosen model does not
            support are snapped to its nearest supported one.
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
        resolution=resolution,
        reference_image_urls=reference_image_urls,
        scene_id=ctx.scene_id,
        image_model_id=ctx.video_model_id,
    )


# ---------------------------------------------------------------------------
# Submit + poll internals
# ---------------------------------------------------------------------------

def _submit(job: VideoJob, cfg: ImageChannel, image_urls: list[str]) -> str:
    endpoint = f"{cfg.base_url.rstrip('/')}/videos/generations"

    # 时长和比例先过一遍这个模型**真的收**的那张表 —— 跟模板通道那条路 (见
    # template_client.video_variables) 同一条规则, 也跟 KIND_SPECS[VIDEO] 里放出
    # allowed_ratios / allowed_durations 两个旋钮的承诺对得上。没填就是不限制, 原样发,
    # 所以对存量通道是空操作。
    #
    # **不能只靠工具栏筛**: agent 的 generate_video 自己挑秒数 (`duration: int = 5`),
    # 而画布上那三档还是粘在 localStorage 里的 —— 两条都绕过选择器, 表现是供应商回一句
    # invalid duration, 跟"通道配错了"看起来一模一样。
    body: dict[str, Any] = {
        "model": cfg.model,
        "prompt": job.prompt,
        "duration": nearest_duration(job.duration, parse_durations(cfg.allowed_durations)),
    }
    # 比例跟画质档同一个写法 (显式 if, 不是"填空串") —— 这里是手拼 dict, 没有模板通道
    # request_template.render 那道"空值键整个不下发"的闸, `"aspect_ratio": ""` 会照样
    # POST 出去。
    #
    # 报了 text_only 的模型在有参考图时整个键不发: viduq3-pro / -turbo 的文档写的是
    # 「就不能同时设置 `aspect_ratio`」—— 是禁止, 不是"传了会被忽略"。
    if not (image_urls and cfg.ratio_scope == "text_only"):
        # 键名也跟着通道走 —— 这家一半模型叫 aspect_ratio, 另一半叫 size
        # (见 RATIO_PARAM_CHOICES)。认不出的值退回 aspect_ratio 而不是谁都不填:
        # 下拉框拦得住手填的通道, 拦不住 model.overrides 里的一行 JSON, 而"谁都不填"
        # 的表现是比例旋钮静默失效。同 resolution_param 那一段。
        ratio_key = cfg.ratio_param if cfg.ratio_param in RATIO_PARAM_CHOICES else "aspect_ratio"
        # 空 = 这个模型没有比例参数, 一个键都不发。
        if ratio_key:
            body[ratio_key] = resolve_ratio(cfg.allowed_ratios, job.aspect_ratio or "16:9")[1]
    # 画质档只在通道报了支持哪几档时才发 —— 没配过 allowed_resolutions 的通道保持原样
    # 不多发一个键 (多发的后果是 400, 而这条内置形状是给"配好就在用"的老通道跑的)。
    if job.resolution and cfg.allowed_resolutions:
        body[cfg.resolution_param or "resolution"] = resolve_resolution(
            cfg.allowed_resolutions, job.resolution,
        )[1]
    if image_urls:
        # 内联 + 可达性预检已经在 run_video_job 里做过 (分流之前, 两条通道共用一份)。
        # 这里拿到的就是最终要发的形状: data URI 或真正的公网地址。
        body["image_urls"] = list(image_urls)

    logger.info(
        "video submit: endpoint=%s model=%s duration=%s aspect=%s images=%d",
        endpoint, cfg.model, body["duration"],
        # `.get` 而不是 `[...]`: 这个键现在可能不存在 (text_only), 也可能叫 size ——
        # 而这只是一行日志, 不该有本事把一次已经拼好的提交打成 KeyError。
        body.get("aspect_ratio") or body.get("size") or "-", len(image_urls),
    )
    resp = _session.post(
        endpoint,
        headers=_auth_headers(cfg.api_key),
        json=body,
        timeout=cfg.timeout,
    )
    data = _parse_json_or_raise(resp, "submit")
    task_id = _extract_task_id(data)
    if not task_id:
        raise RuntimeError(f"video submit response missing task id: {data!r}")
    return task_id


def _poll_until_done(task_id: str, cfg: ImageChannel) -> dict[str, Any]:
    """Exponential backoff poll. Raises TimeoutError if not done within the cap."""
    # quote(safe="") 防被劫持的 provider 回一个 "../admin" 把 GET 拐到别处
    base = (cfg.poll_url or cfg.base_url).rstrip("/")
    status_url = f"{base}/videos/{quote(task_id, safe='')}"
    attempts = max(1, cfg.poll_max_attempts)
    initial = max(1, cfg.poll_interval)
    # poll_max_interval ≤ poll_interval (含默认的 0) = 不退避, 固定间隔。
    max_wait = max(initial, cfg.poll_max_interval)

    wait = initial
    for attempt in range(1, attempts + 1):
        time.sleep(wait)
        resp = _session.get(
            status_url,
            headers=_auth_headers(cfg.api_key),
            timeout=cfg.poll_timeout,
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
