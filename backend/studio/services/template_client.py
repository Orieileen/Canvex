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
import re
import time
from typing import Any

import requests

# ImageChannel / _url_to_data_uri 从 image_client 拿而不是 image_channels: 后者只是
# 把它再导出一次, 而 image_client 是叶子 (只依赖 http_retry + listings_utils), 所以这里
# **没有循环**。之前这两个 import 一个绕道、一个写成函数内延迟导入并注着"避免循环
# import" —— 那条注释是错的, 而它的代价是有人照着又抄了一份比例换算。
from studio.services.http_retry import make_retry_session
from studio.services.image_client import (
    BODY_TRUNC,
    RESOLUTION_PARAM_CHOICES,
    ImageChannel,
    _url_to_data_uri,
    nearest_duration,
    parse_durations,
    ratio_to_pixels,
    resolve_ratio,
    resolve_resolution,
    size_to_ratio,
)
from studio.services.listings_utils import (
    _extract_image_bytes_from_item,
    budget_exhausted_message,
    resolve_image_bytes,
)
from studio.services.request_template import TemplateError, extract, placeholders, render

logger = logging.getLogger(__name__)

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
            f"{what} HTTP {resp.status_code}: {resp.text[:BODY_TRUNC]}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise TemplateRequestError(
            f"{what} 返回的不是 JSON (HTTP {resp.status_code}): {resp.text[:BODY_TRUNC]}"
        ) from exc


def execute(
    channel: ImageChannel, variables: dict[str, Any],
    *, session: requests.Session | None = None, deadline: float | None = None,
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
        return _result(payload, tpl.get("result_path", ""), "提交")

    task_id = _pick(payload, tpl.get("task_id_path", ""), "提交", noun="task_id")
    if not isinstance(task_id, (str, int)) or str(task_id).strip() == "":
        raise TemplateRequestError(
            f"提交成功了, 但按 `task_id_path` 取到的不是一个可用的任务 id: {task_id!r}"
        )
    return _poll(session, channel, poll, {**variables, "task_id": str(task_id)}, deadline=deadline)


def _poll(
    session: requests.Session, channel: ImageChannel, poll: dict, variables: dict,
    *, deadline: float | None = None,
) -> Any:
    """按 poll 段反复查, 直到 done / failed / 查够次数 / 撞上 deadline。

    `deadline` 是一个 `time.monotonic()` 时间点, **只有同步调用方会给** ——「测试」按钮
    必须在一次 HTTP 请求里返回, 而轮多少次是用户配的。给的是真实墙钟而不是一个换算出来
    的次数: 次数换算必须假设"每轮都耗尽超时", 而实际每轮通常一秒就回来, 于是 600 秒的
    预算只用掉 96 秒就宣布失败 —— 一条配得完全正确、只是慢一点的异步通道会被判死刑,
    正是这个按钮要消灭的那种假信号。

    worker 里不传: 那边没人在等, `poll_max_attempts` 就是它的上限。
    """
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
        # 睡完再判: 这样"还剩 2 秒"时不会再发一个必然来不及的请求。
        if deadline is not None and time.monotonic() >= deadline:
            # 话跟内置轮询那条**共用一份** (见 listings_utils.budget_exhausted_message):
            # 抄两份的下场是其中一份哪天被改成一句会被 channel_diagnosis 误认的话。
            raise TemplateRequestError(budget_exhausted_message(attempt, last_status))
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
            return _result(payload, poll.get("result_path", ""), "轮询")
        if status in failed:
            raise TemplateRequestError(
                f"供应商报告任务失败 (status={status}): "
                f"{str(payload)[:BODY_TRUNC]}"
            )
    raise TemplateRequestError(
        f"轮询了 {attempts} 次 (间隔 {interval}s 起, 退避到 {max_wait}s) 任务还没完成, "
        f"最后看到的状态是 `{last_status or '(取不到)'}`。要么把 poll_max_attempts / "
        f"poll_interval / poll_max_interval 调大, 要么检查模板里的 `status_path` 和 "
        f"`done` 写对了没有。"
    )


def _result(payload: Any, path: str, what: str) -> Any:
    """回包 → 结果那一项。`result_path` 留空时**跑一次自动认**, 而不是把整个回包交出去。

    留空是合法配置而不是漏填: 有些家结果的位置**每次都不一样** —— Gemini 的
    `generateContent` 会先回一段文字再回图, 于是图在 `parts[0]` 还是 `parts[1]` 取决于
    这一次它想不想说话。写死任一个都会间歇性失败。

    用的是向导里那套 `find_result_paths` (按值的形状认: http 地址 / data URI / base64),
    所以它和"跑一次自动认结果"是同一段逻辑, 不是第二份。

    填了路径就照填的走 —— 自动认只在**没得选**的时候兜底, 不去覆盖用户的明确指定。
    """
    if path.strip():
        return _pick(payload, path, what)
    hits = find_result_paths(payload)
    if not hits:
        raise TemplateRequestError(
            f"{what}: 回包里没找到任何像图/视频的东西 (模板没写 `result_path`, "
            f"所以是自动找的)。回包: {str(payload)[:BODY_TRUNC]}"
        )
    return _pick(payload, hits[0][0], what)


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

    **先过一遍 `allowed_ratios`**: 画布上那十个比例是固定的, 而各家各模型收的不一样。
    没填就是不限制 (原样), 填了就把选中的映射到最近的一个 —— 这条兜底管的是工具栏拦不住
    的那几种情况: agent 自己挑的尺寸, 以及"换了模型之后旧选择失效"。

    `width` / `height` 用 `ratio_to_pixels` 而不是 `size_to_wh`: 画布**只发比例串**, 而
    后者对比例串是"解析不了" —— 于是这两个占位符一直渲染成空、键整个消失, 一家要
    width+height 的供应商配得再对也拿不到尺寸, 且没有任何报错。
    """
    # `size` 发的是**这家要的那个值**, `aspect_ratio` 永远是比例。两者可能不同 ——
    # OpenAI 的 3:2 要发 `1536x1024`。没配映射时两者相同, 跟以前一模一样。
    picked, sent = resolve_ratio(channel.allowed_ratios, size)
    width, height = ratio_to_pixels(sent)
    return {
        **_base_variables(channel, prompt=prompt, image_urls=image_urls, session=session),
        "n": n, "resolution": resolve_resolution(channel.allowed_resolutions, resolution)[1],
        "size": sent, "aspect_ratio": size_to_ratio(picked),
        "width": width, "height": height,
    }


def video_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str],
    duration: int, aspect_ratio: str, resolution: str = "",
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """喂给 custom_video 模板的变量表。公共部分见 `_base_variables`。

    比例同样过一遍 `allowed_ratios` —— 视频模型的可用比例往往比生图还窄 (常见只有
    16:9 / 9:16 / 1:1)。

    `size` / `aspect_ratio` 的分工同 `image_variables`: 前者是要发的值, 后者永远是比例。

    **画质档两个占位符只填一个**: 同一件事在 apimart 有两个键名 (37 个模型叫
    `resolution`, 可灵那 4 个叫 `mode`), 而模板是每条通道一份、模型有 41 个。所以两个都
    摆出来, 由 `channel.resolution_param` 决定填哪个, 另一个渲染成空 → 那个键整个消失。
    """
    picked, sent = resolve_ratio(channel.allowed_ratios, aspect_ratio)
    # 时长同样过一遍。选择器已经按 allowed_durations 列过一次, 这里管它拦不住的:
    # agent 自己挑的秒数, 以及"换了模型之后 localStorage 里那个旧选择失效"。
    secs = nearest_duration(duration, parse_durations(channel.allowed_durations))
    tier = resolve_resolution(channel.allowed_resolutions, resolution)[1]
    # 认不出的键名退回 `resolution` 而不是谁都不填: 下拉框拦得住手填的通道, 拦不住
    # model.overrides 里的一行 JSON —— 而"谁都不填"的表现是画质旋钮静默失效。
    param = channel.resolution_param if channel.resolution_param in RESOLUTION_PARAM_CHOICES else "resolution"
    return {
        **_base_variables(channel, prompt=prompt, image_urls=image_urls, session=session),
        # 跟生图那张表同一个分工: `aspect_ratio` 永远是比例, `size` 是**这家要的那个值**
        # (`allowed_ratios` 里 `=` 右半边)。没配映射时两者相同。视频这边以前只有前者,
        # 于是那半个字段在视频通道上是个静默的空操作。
        "duration": secs, "aspect_ratio": picked, "size": sent,
        **{name: (tier if name == param else "") for name in RESOLUTION_PARAM_CHOICES},
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


# ─────────────────── 响应那一半: 跑一次, 自己找 ───────────────────
#
# `result_path` 是模板里唯一不可能让人写出来的东西 —— `data.result.images[0].url[0]`
# 这种路径, 写这个功能的人自己也是发一次请求看回包才知道的。所以不问用户, 直接跑一次
# 然后在回包里找"哪个位置长得像图"。

# 长度够、只含 base64 字母表 —— 一段图片的 base64 一定满足, 而一句英文报错不会。
_LOOKS_B64 = re.compile(r"^[A-Za-z0-9+/\s]{200,}={0,2}$")
# 回包里没有图, 但有这些键 = 这是一张"任务受理单", 不是结果。
_TASK_HINTS = frozenset({"task_id", "taskid", "job_id", "id", "request_id"})


def find_result_paths(node: Any, trail: str = "") -> list[tuple[str, str]]:
    """遍历回包, 返回所有"看起来是图/视频"的位置 → `[(路径, 说明)]`。

    判据只看**值长什么样**, 不看键叫什么 —— 键名各家乱起 (`url` / `image_url` /
    `output` / `src`), 而"这是个 http 地址"或"这是段 base64"是跨供应商稳定的。
    实测能从 apimart 那个 `data.result.images[0].url[0]` (嵌套 + url 居然是数组) 里
    找出来, 而那正是没人猜得到的形状。
    """
    if isinstance(node, str):
        text = node.strip()
        if text.startswith(("http://", "https://")):
            return [(trail, f"URL {text[:60]}")]
        if text.startswith("data:image/") or text.startswith("data:video/"):
            return [(trail, f"data URI ({len(text)} 字符)")]
        if _LOOKS_B64.match(text):
            return [(trail, f"base64 ({len(text)} 字符)")]
        return []
    if isinstance(node, dict):
        return [hit for k, v in node.items()
                for hit in find_result_paths(v, f"{trail}.{k}" if trail else k)]
    if isinstance(node, list):
        return [hit for i, v in enumerate(node)
                for hit in find_result_paths(v, f"{trail}[{i}]")]
    return []


def looks_like_task(payload: Any) -> bool:
    """回包里没有图, 但带着任务 id / 状态 —— 这家是异步的, 需要 poll 段。

    这个判定值钱是因为它**没法从文档的 curl 里看出来**: apimart 的示例 curl 跟同步
    供应商的一模一样, 差别只在回包。发一次就知道了。
    """
    def walk(node: Any) -> bool:
        if isinstance(node, dict):
            keys = {str(k).lower() for k in node}
            if (_TASK_HINTS & keys) and ("status" in keys or "state" in keys):
                return True
            return any(walk(v) for v in node.values())
        if isinstance(node, list):
            return any(walk(v) for v in node)
        return False
    return walk(payload)


def _find_task_id_path(node: Any, trail: str = "") -> str:
    """受理单里的任务 id 在哪一层。跟 status/result 同理 —— 各家键名不同
    (`task_id` / `id` / `job_id` / `request_id`), 但"跟状态住在同一个对象里"这条是稳的,
    所以优先在带 status 的那一层找, 找不到再退回全树扫。"""
    def scan(n: Any, t: str, same_object_as_status: bool) -> str:
        if isinstance(n, dict):
            keys = {str(k).lower() for k in n}
            has_status = bool({"status", "state", "phase"} & keys)
            if not same_object_as_status or has_status:
                for cand in ("task_id", "taskid", "job_id", "id", "request_id"):
                    val = n.get(cand)
                    if isinstance(val, (str, int)) and str(val).strip():
                        return f"{t}.{cand}" if t else cand
            for k, v in n.items():
                found = scan(v, f"{t}.{k}" if t else k, same_object_as_status)
                if found:
                    return found
        elif isinstance(n, list):
            for i, v in enumerate(n):
                found = scan(v, f"{t}[{i}]", same_object_as_status)
                if found:
                    return found
        return ""
    # 先只认"跟 status 同一层"的, 免得把回包顶层的 request_id 当成任务 id。
    return scan(node, trail, True) or scan(node, trail, False)


def probe_template(
    channel: ImageChannel, variables: dict[str, Any], *,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """按模板**只发提交那一次**, 把回包和诊断结果交回去。

    刻意不走 `execute`: 那个会一路轮询到出图, 而这里要的正是"提交回来的是什么" ——
    是图(同步) 还是一张受理单(异步)。异步的话下一步是让用户再粘一段查询任务的 curl。
    """
    payload = _request(
        session or SHARED_SESSION, channel.request_template or {}, variables,
        timeout=channel.timeout, what="试跑",
    )
    hits = find_result_paths(payload)
    task_id_path = "" if hits else _find_task_id_path(payload)
    return {
        "raw": payload,
        "candidates": [{"path": p, "preview": d} for p, d in hits],
        # 第一个命中如果是个 http(s) 地址就原样给出来 —— 向导拿它在最后一步把**刚生成的
        # 那张图**显示出来。一条截断到 60 字的 "URL https://…" 只能证明"有个地址",
        # 而看见图才是"这条通道通了"的完整证据。不是地址 (base64 / data URI) 就空着:
        # 那两种在这里没必要塞进 JSON, 体积大得多。
        "preview_url": _first_http(payload, hits),
        # 第一个命中就是建议值。多个命中时后面那些通常是缩略图 / 备用尺寸, 让用户选。
        "result_path": hits[0][0] if hits else "",
        "is_async": (not hits) and looks_like_task(payload),
        # 异步时下一步要用的: 提交回来的任务 id 在哪一层。
        "task_id_path": task_id_path,
        # …以及那一层上**真实的那个值**。向导的第 3 步全靠它 (拿它去查任务、拿它在查询
        # 地址里定位该换成 `{{task_id}}` 的那一段)。
        #
        # **由后端给, 别让前端再走一遍回包**: 那样就是第二份"哪个键是任务 id"的规则, 而
        # 两份必然分叉 —— 前端那份原来只认 `task_id` / `job_id`, 于是一家把它叫 `id` 或
        # `request_id` 的供应商 (这里认得) 会让向导拿到空 id, 而空 id 会让下一步的
        # parse 接口走错分支、回一份没有 `poll` 段的东西, 界面上还弹一个成功提示。
        "task_id": _value_at(payload, task_id_path),
    }


def _value_at(payload: Any, path: str) -> str:
    """路径上的标量值, 取不到就空串。`extract("")` 会把整个回包还回来, 所以空路径先挡掉。"""
    if not path:
        return ""
    try:
        value = extract(payload, path)
    except TemplateError:
        return ""
    return str(value).strip() if isinstance(value, (str, int)) else ""


def _first_http(payload: Any, hits: list[tuple[str, str]]) -> str:
    """第一个命中位置上的值, 且它得是个 http(s) 地址。取不到就空串。

    重新走一遍 `extract` 而不是让 find_result_paths 把整个值也带回来: 那个函数会遍历到
    每一段 base64, 让它顺手把值也收集起来等于把整张回包复制一份。
    """
    if not hits:
        return ""
    try:
        value = extract(payload, hits[0][0])
    except TemplateError:
        return ""
    text = value.strip() if isinstance(value, str) else ""
    return text if text.startswith(("http://", "https://")) else ""


def _find_status_path(node: Any, trail: str = "") -> str:
    """回包里"状态"在哪一层。找键叫 status/state/phase 且值是个短字符串的位置。

    跟 `find_result_paths` 一样是"跑一次看出来的", 不问用户 —— 而且顺带能把**那次真实
    看到的状态值**填进 `done`, 比让人照着文档猜 succeeded / completed / success 靠谱。
    """
    if isinstance(node, dict):
        for key in ("status", "state", "phase"):
            val = node.get(key)
            if isinstance(val, str) and 0 < len(val) < 32:
                return f"{trail}.{key}" if trail else key
        for k, v in node.items():
            found = _find_status_path(v, f"{trail}.{k}" if trail else k)
            if found:
                return found
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found = _find_status_path(v, f"{trail}[{i}]")
            if found:
                return found
    return ""


def probe_poll(
    channel: ImageChannel, poll: dict, variables: dict[str, Any], *,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """查一次任务, 把 `status_path` / 当前状态 / `result_path` 都从回包里读出来。

    向导会反复调它直到出图 —— 每次都告诉用户"现在是 pending", 出图那次就把
    `done` 定成那一刻真实看到的状态值。
    """
    payload = _request(
        session or SHARED_SESSION, {**poll, "body": None}, variables,
        timeout=channel.poll_timeout or 30, what="查询任务",
    )
    status_path = _find_status_path(payload)
    hits = find_result_paths(payload)
    return {
        "raw": payload,
        "status_path": status_path,
        "status": str(extract(payload, status_path)) if status_path else "",
        "candidates": [{"path": p, "preview": d} for p, d in hits],
        "result_path": hits[0][0] if hits else "",
        # 跟 probe_template 一样给出来 —— 异步通道出图是在**这条路**上, 而向导最后一步
        # 要显示的正是那张图。两处各写一次的话, 同步通道有图看、异步通道没有, 而异步恰恰
        # 是这个向导最值钱的那一半。
        "preview_url": _first_http(payload, hits),
        "done": bool(hits),
    }
