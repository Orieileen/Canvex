"""按用户填的请求模板真发一次调用。模板引擎的运行时另一半。

`request_template.render` 把模板变成一个**具体的请求** (一串 URL、一个 headers 字典、
一个 body 字典); 这里负责把它发出去、必要时轮询、并从回包里取出结果。

## 它把三处写死的东西变成了声明

**注意: 那三处都还在跑, 一处都没迁移** —— 用户选的是新老并存 (内置通道和模板通道各走
各的), 而迁移意味着把现有配置重写成模板。这里说的是"同样的事, 模板用声明表达", 不是
"那些代码删了"。别照着这段去清理它们中的任何一处。

    image_client.py      端点写死 /images/generations, 请求体的键写死, Bearer 写死
    listings_utils.py    轮询路径写死 /tasks/{id}, Bearer 写死, 状态字段在
                         ("status","state","phase") 里靠猜
    angle.py             fal 不一样 (模型在 URL、认证是 Key), 于是整个又抄了一份

轮询那块尤其能说明问题: 路径、认证前缀、状态字段叫什么, 现在**全是猜的** —— 猜中了
是运气, 猜不中的表现是"任务一直查不到状态然后超时"。模板化之后这三样都是用户填的,
猜的部分归零。

## 错误一律带上供应商的原始报文

这条是这个代码库反复付过学费的: 把 provider 的 4xx 换成我们自己的一句话, 用户就没有
任何线索去改配置。所有 HTTP 错误都把状态码 + 响应体(截断)原样带出来。
"""
import base64
import logging
import time
from typing import Any

import requests

# ImageChannel / _url_to_data_uri 从 image_client 拿而不是 image_channels: 后者只是
# 把它再导出一次, 而 image_client 是叶子 (只依赖 http_retry + listings_utils), 所以这里
# **没有循环**。之前这两个 import 一个绕道、一个写成函数内延迟导入并注着"避免循环
# import" —— 那条注释是错的, 而它的代价是有人照着又抄了一份比例换算。
from studio.services.http_retry import make_retry_session
from studio.services.image_client import ImageChannel, _url_to_data_uri, size_to_ratio, size_to_wh
from studio.services.listings_utils import _extract_image_bytes_from_item, resolve_image_bytes
from studio.services.request_template import TemplateError, extract, placeholders, render

logger = logging.getLogger(__name__)

# 报错里带多少响应体。够看清供应商说了什么, 又不至于把一整个 base64 图塞进日志/DB。
_BODY_TRUNC = 800

# 模板通道共用的 Session (带重试)。**模块级而不是每次生成新建一个**: 新建的那个 TCP 池
# 永远是冷的 —— 每张图重连一次 TLS, 而 fan-out 出 4 张就是 4 套池子; 而且它到 GC 之前
# 都不会释放连接。内置通道那边的 build_image_client 是同一个理由 (lru_cache 一个
# ImageClient = 一个 Session), video.py 也早就有一个模块级 `_session`。
#
# 跨线程共享是安全的, 也跟内置路径一致: `_generate` 的 n>1 fan-out 本来就让多个线程共用
# 一个 lru_cache 出来的 ImageClient.session。
#
# 探针**不用它** —— 那条要的是不重试 (见 image.probe_image_channel / build_probe_client),
# 所以调用方可以自带 session。
SHARED_SESSION = make_retry_session()


class TemplateRequestError(RuntimeError):
    """模板通道调用失败。message 会一路显示到画布上那行红字, 所以必须带供应商原文。"""


def _request(
    session: requests.Session, spec: dict, variables: dict, *, timeout: int, what: str,
) -> Any:
    """渲染 spec (url/method/headers/body) 并发一次, 返回解析好的 JSON。"""
    url = render(spec.get("url", ""), variables)
    if not isinstance(url, str) or not url.strip():
        raise TemplateRequestError(f"{what}: 模板里没有 `url`, 或者渲染出来是空的")
    method = str(spec.get("method") or "POST").upper()
    headers = render(spec.get("headers") or {}, variables)
    body = render(spec.get("body"), variables) if spec.get("body") is not None else None

    logger.info("template %s: %s %s", what, method, url)
    try:
        resp = session.request(
            method, url, headers=headers,
            json=body if method not in ("GET", "HEAD") else None,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise TemplateRequestError(f"{what} 请求发不出去: {exc}") from exc

    if not resp.ok:
        # provider 的 4xx/5xx 正文里通常写着到底哪个字段不对 —— 那是用户唯一能拿来改
        # 模板的线索, 绝不能吞。
        logger.error("template %s %d %s: body=%.500s", what, resp.status_code, url, resp.text)
        raise TemplateRequestError(
            f"{what} HTTP {resp.status_code}: {resp.text[:_BODY_TRUNC]}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise TemplateRequestError(
            f"{what} 返回的不是 JSON (HTTP {resp.status_code}): {resp.text[:_BODY_TRUNC]}"
        ) from exc


def execute(
    channel: ImageChannel, variables: dict[str, Any],
    *, session: requests.Session | None = None,
) -> Any:
    """跑完一次模板调用, 返回 `result_path` 指到的那一项。

    同步就是一次 POST; 模板里有 `poll` 段就先取 `task_id_path`, 再按 poll 段反复查,
    直到状态落进 `done` 或 `failed`。

    模板**从 channel 上取**, 不再单独传一遍: 它跟 base_url / api_key / 超时 / 轮询参数
    一样是"这条通道怎么调用"的一部分, `channel_for_model` 已经把它压进来了。两个调用方
    此前传的都恰好是 `channel.request_template`, 那个参数只是给"传错一个"留了余地。
    (这里原来写着不能挂在 channel 上、因为 ImageChannel 必须可哈希 —— 那句话在
    request_template 用 `compare=False` 落进 ImageChannel 时就已经不成立了。)
    """
    tpl = channel.request_template or {}
    if not tpl:
        raise TemplateRequestError("这条通道还没有配请求模板")
    session = session or SHARED_SESSION

    payload = _request(session, tpl, variables, timeout=channel.timeout, what="提交")

    poll = tpl.get("poll")
    if not poll:
        return _pick(payload, tpl.get("result_path", ""), "提交")

    task_id = _pick(payload, tpl.get("task_id_path", ""), "提交", noun="task_id")
    if not isinstance(task_id, (str, int)) or str(task_id).strip() == "":
        raise TemplateRequestError(
            f"提交成功了, 但按 `task_id_path` 取到的不是一个可用的任务 id: {task_id!r}"
        )
    return _poll(session, channel, poll, {**variables, "task_id": str(task_id)})


def _poll(
    session: requests.Session, channel: ImageChannel, poll: dict, variables: dict,
) -> Any:
    """按 poll 段反复查, 直到 done / failed / 查够次数。"""
    done = {str(v).lower() for v in (poll.get("done") or [])}
    failed = {str(v).lower() for v in (poll.get("failed") or [])}
    if not done:
        raise TemplateRequestError("模板的 poll 段里没写 `done` —— 我们无法知道什么算完成了")

    interval = max(1, channel.poll_interval or 5)
    attempts = max(1, channel.poll_max_attempts or 60)
    req_timeout = max(1, channel.poll_timeout or 30)
    # 退避跟内置 video 通道 (`video._poll_until_done`) 同一条式子, 而不是固定间隔:
    # poll_max_interval ≤ poll_interval (含默认的 0) = 不退避。少了它, custom_video 那组
    # 默认值 (20 秒 × 9 次) 只等 160 秒, 而视频要跑 1-5 分钟 —— 一条配得完全正确的通道会
    # 稳定报"轮询了 9 次还没完成"; 内置 video 用同一组数退避到 180 秒, 总墙钟是它的六倍。
    max_wait = max(interval, channel.poll_max_interval)
    wait = interval
    last_status = ""

    for attempt in range(attempts):
        if attempt:
            time.sleep(wait)
            wait = min(wait * 2, max_wait)
        payload = _request(
            # 轮询默认 **GET** (提交那一次才默认 POST): 状态端点几乎都是 GET, 而模板里
            # 漏写 `method` 时发一个 POST 换回来的 405 跟"模板哪里写错了"毫无关系。
            session, {"method": "GET", **poll, "body": None}, variables,
            timeout=req_timeout, what=f"轮询 {attempt + 1}/{attempts}",
        )
        status = str(_pick(payload, poll.get("status_path", ""), "轮询", noun="status") or "").lower()
        last_status = status
        logger.info("template poll: attempt=%d/%d status=%s", attempt + 1, attempts, status)
        if status in done:
            return _pick(payload, poll.get("result_path", ""), "轮询")
        if status in failed:
            raise TemplateRequestError(
                f"供应商报告任务失败 (status={status}): "
                f"{str(payload)[:_BODY_TRUNC]}"
            )
    raise TemplateRequestError(
        f"轮询了 {attempts} 次 (间隔 {interval}s 起, 退避到 {max_wait}s) 任务还没完成, "
        f"最后看到的状态是 `{last_status or '(取不到)'}`。要么把 poll_max_attempts / "
        f"poll_interval / poll_max_interval 调大, 要么检查模板里的 `status_path` 和 "
        f"`done` 写对了没有。"
    )


def _pick(payload: Any, path: str, what: str, *, noun: str = "结果") -> Any:
    """按路径取值, 把 TemplateError 翻译成带上下文的 TemplateRequestError。"""
    try:
        return extract(payload, path)
    except TemplateError as exc:
        raise TemplateRequestError(f"{what}: 取{noun}时 —— {exc}") from exc


# ── 结果 → 我们要的东西 ────────────────────────────────────────────────────

def item_to_bytes(item: Any) -> bytes:
    """`result_path` 指到的那一项 → 图片字节。

    字典交给 `listings_utils._extract_image_bytes_from_item` —— 那套 b64/url 嗅探本来
    就在跑, 没有必要因为换了配置方式就重写一遍。**刻意不让用户填"这里是 url 还是
    base64"**: 少一个要理解的字段, 而这一处的自动判断是可靠的。

    额外接一种字典接不了的形状: `result_path` 直接指到一个字符串 (比如
    `data[0].url`)。那时它要么是个 http(s) 地址, 要么是 data URI / 裸 base64。
    """
    if isinstance(item, str):
        token = item.strip()
        if not token:
            raise TemplateRequestError("按 `result_path` 取到的是个空字符串")
        # http(s) 和 data: 两种都交给现成的 resolve_image_bytes —— 它本来就同时认这两种,
        # 而且比手写的 split 更严 (会校验 data URI 头里确实写着 base64)。
        if token.startswith(("http://", "https://", "data:")):
            return resolve_image_bytes(token)
        try:
            # validate=True 是必需的而不是防御性的: 默认的 validate=False 会**先把不在
            # base64 字母表里的字符统统丢掉**再验填充, 于是供应商回的一句英文错误消息只要
            # 过滤后长度整除 4 就能"解码成功", 我们把一堆垃圾字节当成图存进素材库。
            return base64.b64decode("".join(token.split()), validate=True)
        except Exception as exc:
            raise TemplateRequestError(
                f"按 `result_path` 取到一个字符串, 但它既不是 http(s) 地址也不是 base64: "
                f"{item[:120]!r}"
            ) from exc
    data = _extract_image_bytes_from_item(item)
    if data is None:
        keys = sorted(item) if isinstance(item, dict) else type(item).__name__
        if isinstance(item, dict) and ({"task_id", "id"} & set(item)) and "status" in item:
            # 这一项长得像"任务已提交"而不是"图在这" —— 十有八九是把一个异步供应商配成
            # 了同步模板。直说, 比让他去调 result_path 有用得多。
            raise TemplateRequestError(
                f"供应商回的是一个任务 (有 {keys}), 不是图 —— 这家是**异步**的, "
                f"模板里要加 `task_id_path` 和 `poll` 段。起点模板里的"
                f"「OpenAI 兼容 · 异步 (提交 + 轮询)」就是这个形状。"
            )
        raise TemplateRequestError(
            f"按 `result_path` 取到的这一项里找不到图片 (b64_json / url 之类)。"
            f"它有: {keys}。把 `result_path` 指到真正含图的那一层。"
        )
    return data


def item_to_url(item: Any) -> str:
    """`result_path` 指到的那一项 → 视频地址。视频不落字节, 库里存的就是外链。"""
    if isinstance(item, str) and item.strip():
        return item.strip()
    if isinstance(item, dict):
        for key in ("url", "video_url", "download_url", "result_url"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        raise TemplateRequestError(
            f"按 `result_path` 取到的这一项里找不到视频地址。它有: {sorted(item)}。"
            f"**把 `result_path` 再往下指一层**就行 —— 哪个键放地址是位置问题, "
            f"模板里说得清, 不用我们猜。"
        )
    raise TemplateRequestError(f"按 `result_path` 取到的不是地址也不是对象: {type(item).__name__}")


# ── 变量表 ────────────────────────────────────────────────────────────────

# 写了这两个变量之一, 才值得为它去下载外部图。
_INLINE_VARS = frozenset({"image_base64", "images_base64"})


def _inlined(image_urls: list[str], session: requests.Session | None) -> list[str]:
    """外部 http(s) 图 → data URI。已经是 data URI 的原样返回 (画布上的图在进通道之前
    就被 `source_to_inline_uri` 内联过了, 所以常见情况这里是个直通)。"""
    return [_url_to_data_uri(u, session or SHARED_SESSION) for u in image_urls]


def _base_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str],
    session: requests.Session | None,
) -> dict[str, Any]:
    """生图和视频共用的那几项 —— 连接三件套、提示词、源图的四种形式。

    **下载策略只写在这一处**: 它是这个文件里最微妙的一段 (什么时候值得为一个占位符去
    发 N 个真实请求), 抄成两份就是两份要同步的策略。

    "模板里写了哪些占位符"由这里自己算, 不让调用方传 —— 两个调用方此前传的都恰好是
    `placeholders(channel.request_template)`, 而 channel 就在手上。

    只写了标量 `{{image_base64}}` 时**只下第一张**: 数组形式没被引用, 剩下那些下了也
    没人读, 而每一张都是一次真实的 HTTP 往返。
    """
    wanted = placeholders(channel.request_template)
    if _INLINE_VARS & wanted:
        needed = image_urls if "images_base64" in wanted else image_urls[:1]
        b64 = _inlined(needed, session)
    else:
        b64 = []
    return {
        "base_url": channel.base_url, "api_key": channel.api_key, "model": channel.model,
        "prompt": prompt,
        # 标量取第一张 —— 没有源图时是空串, 于是那个键自动消失(文生图)。
        "image": image_urls[0] if image_urls else "",
        "images": list(image_urls),
        "image_base64": b64[0] if b64 else "",
        "images_base64": b64,
    }


def image_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str], size: str,
    n: int = 1, resolution: str = "", session: requests.Session | None = None,
) -> dict[str, Any]:
    """喂给 custom_image 模板的变量表。

    尺寸给四种形式是刻意的 —— 各家要的不一样 (兔子要像素 `1024x1024`, apimart 要比例
    `1:1`, 有的要分开的 width / height), 而模板表达不了换算。所以换算在这边做完, 把现成
    的形式都摆出来让用户挑写哪个。
    """
    width, height = size_to_wh(size)
    return {
        **_base_variables(channel, prompt=prompt, image_urls=image_urls, session=session),
        "n": n, "resolution": resolution,
        "size": size, "aspect_ratio": size_to_ratio(size), "width": width, "height": height,
    }


def video_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str],
    duration: int, aspect_ratio: str, session: requests.Session | None = None,
) -> dict[str, Any]:
    """喂给 custom_video 模板的变量表。公共部分见 `_base_variables`。"""
    return {
        **_base_variables(channel, prompt=prompt, image_urls=image_urls, session=session),
        "duration": duration, "aspect_ratio": aspect_ratio,
    }


# 可用占位符的**唯一真相**: 从两个 builder 的实际返回值推出来, 不再另手抄一份清单。
# `image_channels.KIND_SPECS` 拿它做存盘校验和界面上的提示 —— 手抄的那份漏一个名字,
# 表现是"模板里写了这个占位符、存盘通过、渲染成空、那个键整个消失", 没有任何报错。
# 这跟同一个文件里 `_TUNABLE_FIELDS` 从 dataclass 派生是同一个道理。
# `task_id` 单独并上: 它是提交之后才注入的 (见 `_poll`), 不在 builder 的返回值里。
_BLANK_CHANNEL = ImageChannel(base_url="", api_key="", model="")
IMAGE_VARS = frozenset(
    image_variables(_BLANK_CHANNEL, prompt="", image_urls=[], size="")
) | {"task_id"}
VIDEO_VARS = frozenset(
    video_variables(_BLANK_CHANNEL, prompt="", image_urls=[], duration=0, aspect_ratio="")
) | {"task_id"}
