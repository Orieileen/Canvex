"""按用户填的请求模板真发一次调用。模板引擎的运行时另一半。

`request_template.render` 把模板变成一个**具体的请求** (一串 URL、一个 headers 字典、
一个 body 字典); 这里负责把它发出去、必要时轮询、并从回包里取出结果。

## 它取代了三份写死的代码

同一件事现在散在三处, 每处都把假设焊死:

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
from math import gcd
from typing import Any

import requests

from studio.services.image_channels import ImageChannel
from studio.services.listings_utils import _extract_image_bytes_from_item, resolve_image_bytes
from studio.services.request_template import TemplateError, extract, render

logger = logging.getLogger(__name__)

# 报错里带多少响应体。够看清供应商说了什么, 又不至于把一整个 base64 图塞进日志/DB。
_BODY_TRUNC = 800


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
    channel: ImageChannel, template: dict, variables: dict[str, Any],
    *, session: requests.Session,
) -> Any:
    """跑完一次模板调用, 返回 `result_path` 指到的那一项。

    同步就是一次 POST; 模板里有 `poll` 段就先取 `task_id_path`, 再按 poll 段反复查,
    直到状态落进 `done` 或 `failed`。

    模板**单独传, 不挂在 channel 上**: `ImageChannel` 是 `frozen=True` 且它的 docstring
    明写着必须可哈希 (它派生 build_image_client 的缓存键), 而模板是个 dict —— 塞进去就
    破坏了那条不变量, 而且是到某次 hash 时才炸的那种。channel 在这里只提供连接三件套、
    超时和轮询参数。
    """
    tpl = template or {}
    if not tpl:
        raise TemplateRequestError("这条通道还没有配请求模板")

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
    last_status = ""

    for attempt in range(attempts):
        if attempt:
            time.sleep(interval)
        payload = _request(
            session, {**poll, "body": None}, variables,
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
        f"轮询了 {attempts} 次 (间隔 {interval}s) 任务还没完成, 最后看到的状态是 "
        f"`{last_status or '(取不到)'}`。要么把 poll_max_attempts / poll_interval 调大, "
        f"要么检查模板里的 `status_path` 和 `done` 写对了没有。"
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
        if token.startswith(("http://", "https://")):
            return resolve_image_bytes(token)
        if token.startswith("data:") and "," in token:
            token = token.split(",", 1)[1]
        try:
            return base64.b64decode("".join(token.split()))
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
        )
    raise TemplateRequestError(f"按 `result_path` 取到的不是地址也不是对象: {type(item).__name__}")


# ── 变量表 ────────────────────────────────────────────────────────────────

def _to_ratio(size: str) -> str:
    """`WxH` 像素 → `W:H` 比例 (gcd 化简)。已是比例 / 解析不了就原样返回。

    跟 `agent.tools.image._canvas_size_to_ratio` 同一个式子。刻意不 import 它 ——
    那个模块把整条生图任务链 (Django 模型、celery、PIL) 都拉进来, 而这里只想要一个
    两行的算术。两边哪天要是分叉了, 分叉的是"比例怎么算"这种不会变的东西。
    """
    if "x" not in size.lower():
        return size
    try:
        w, h = (int(part) for part in size.lower().split("x", 1))
    except ValueError:
        return size
    g = gcd(w, h) or 1
    return f"{w // g}:{h // g}"


def _wh(size: str) -> tuple[int | None, int | None]:
    """`WxH` → (宽, 高)。给那些要分开两个字段的供应商。解析不了给 (None, None),
    渲染时这两个键会自动消失 (见 request_template 的空值规则)。"""
    if "x" not in size.lower():
        return None, None
    try:
        w, h = (int(part) for part in size.lower().split("x", 1))
    except ValueError:
        return None, None
    return w, h


def image_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str], size: str,
    n: int = 1, resolution: str = "",
) -> dict[str, Any]:
    """喂给 custom_image 模板的变量表。跟 KIND_SPECS[custom_image].variables 必须一致 ——
    那边是给用户看的清单和存盘校验的依据, 这边是真值。"""
    width, height = _wh(size)
    return {
        "base_url": channel.base_url, "api_key": channel.api_key, "model": channel.model,
        "prompt": prompt, "n": n, "resolution": resolution,
        "size": size, "aspect_ratio": _to_ratio(size), "width": width, "height": height,
        # 标量取第一张 —— 没有源图时是空串, 于是那个键自动消失(文生图)。
        "image": image_urls[0] if image_urls else "",
        "images": list(image_urls),
    }


def video_variables(
    channel: ImageChannel, *, prompt: str, image_urls: list[str],
    duration: int, aspect_ratio: str,
) -> dict[str, Any]:
    """喂给 custom_video 模板的变量表。"""
    return {
        "base_url": channel.base_url, "api_key": channel.api_key, "model": channel.model,
        "prompt": prompt, "duration": duration, "aspect_ratio": aspect_ratio,
        "image": image_urls[0] if image_urls else "",
        "images": list(image_urls),
    }
