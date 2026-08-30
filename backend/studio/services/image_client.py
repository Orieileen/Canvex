"""
通用图片生成 HTTP 客户端。

适配任何 OpenAI 兼容的 /images/generations 接口，
不同服务商的差异通过字段映射解决。

用法:
    channel = channel_for_model(model)     # services/image_channels.py
    client = build_image_client(channel)
    result = client.generate(prompt=..., image_urls=[...], size=...)

「通道」(ImageChannel) 是一次调用需要的全部供应商参数, 唯一来源是用户在前端配的
ImageProvider/ImageModel (services/image_channels.py)。本模块只负责把它变成 HTTP,
不关心它是怎么来的。
"""

import base64
import functools
import math
import logging
from dataclasses import asdict, dataclass, field, fields
from math import gcd
from typing import Any

import requests

from studio.services.http_retry import make_retry_session
from studio.services.listings_utils import SourceImageDownloadError

logger = logging.getLogger(__name__)


# 源图下载超时跟生成 POST 分开: 生成 self.timeout 可能 300s (出图慢), 但源图下载
# 应快; CDN 卡住别把 worker 线程拖满 5 分钟. (connect, read) 秒.
_INLINE_DOWNLOAD_TIMEOUT = (10, 60)

# 非标准 / 容器 MIME 归一到火山认的标准类型. 'image/jpg' 是常见非规范拼写; 'MPO'
# 是 iPhone 多图 JPEG 容器 (PIL 报 'MPO'), 本质是 JPEG —— 不归一会拼出火山拒收的
# data:image/mpo / data:image/jpg.
_MIME_ALIASES = {"image/jpg": "image/jpeg", "image/mpo": "image/jpeg", "image/jfif": "image/jpeg"}


# 报错里带多少响应体。够看清供应商说了什么, 又不至于把一整个 base64 图塞进日志/DB。
# 住在这个叶子模块里, template_client 从这儿 import —— 两边各写一个数的话, 同一个"报错
# 能有多长"会在两条通道上不一样, 而没有任何地方会提醒你。
BODY_TRUNC = 800


def _sniff_image_mime(content: bytes) -> str:
    """从图片字节头嗅探 MIME (PIL lazy import, 只读 header 不解码全图).

    不从 URL 扩展名猜: 海外 CDN 常给带 ?query 的签名 URL, 从 URL 拼会得到
    'image/png?v=2' 这种非法 MIME 被火山拒. 认不出时落 image/png."""
    from io import BytesIO  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415
    try:
        fmt = Image.open(BytesIO(content)).format  # 'PNG' / 'JPEG' / 'WEBP' / ...
    except Exception:
        logger.warning("inline image: PIL could not identify format, defaulting to image/png (bytes=%d)", len(content))
        return "image/png"
    return f"image/{fmt.lower()}" if fmt else "image/png"


def size_to_wh(size: str) -> tuple[int, int] | tuple[None, None]:
    """`WxH` → (宽, 高)。解析不了给 (None, None)。大小写不敏感。"""
    if "x" not in (size or "").lower():
        return None, None
    try:
        w, h = (int(part) for part in size.lower().split("x", 1))
    except ValueError:
        return None, None
    return w, h


def size_to_ratio(size: str) -> str:
    """`WxH` 像素 → `W:H` 比例 (gcd 化简)。已是比例 / 解析不了时原样返回。

    住在这里而不是 `agent/tools/image.py`: 那个模块把整条生图任务链 (Django 模型、
    celery、PIL) 都拉进来, 而模板客户端只想要这一段算术 —— 它 import 那个模块会成环
    (`agent/tools/image.py` 反过来 import template_client)。这个模块是叶子, 两边都能用。

    以前这里有两份实现, 而且**上线当天就分叉了**: 一份判 `"x" not in size`, 一份判
    `"x" not in size.lower()` —— `"1024X1024"` 在一份里原样返回、在另一份里变成 `1:1`。
    所以合并的理由不是"少几行", 是那两份已经不是同一个函数了。
    """
    w, h = size_to_wh(size)
    if w is None or h is None:
        return size
    g = gcd(w, h) or 1
    return f"{w // g}:{h // g}"


# 比例串 → 像素时, 长边按这个数凑。1024 是各家生图模型都吃得下的常见档位, 而且
# 面积跟 1024×1024 同量级 —— 换比例不该顺带换掉出图的精细度。
_RATIO_LONG_EDGE = 1024
# 不少模型要求边长是 32 的倍数 (latent 是 8 倍下采样再过几层)。凑整比"精确比例"重要:
# 1344×768 是 16:9 的近似, 而 1365.33×768 根本发不出去。
_RATIO_STEP = 32


def ratio_to_pixels(size: str) -> tuple[int | None, int | None]:
    """`W:H` 比例 **或** `WxH` 像素 → 一对具体像素。认不出 / "auto" 时给 (None, None)。

    跟 `size_to_wh` 的区别: 那个只认像素串, 比例串对它是"解析不了"。而画布**只会**发比例
    串 (见前端的 ImageEditSize: auto / 1:1 / 16:9 …), 于是模板里的 `{{width}}` 和
    `{{height}}` 一直渲染成空、那两个键整个消失 —— 一家要 width+height 的供应商配得再
    对也拿不到尺寸, 而且没有任何报错。向导的下拉里还列着这两个占位符。

    `size_to_wh` 不动: `size_to_ratio` 建在它上面, 而"比例串原样返回"正是那条路要的 ——
    这里若让它解析出像素, gcd 化简会把画布上的 `21:9` 变成 `7:3`, 而供应商认的是前者。
    """
    w, h = size_to_wh(size)
    if w is not None and h is not None:
        return w, h
    text = (size or "").strip()
    if ":" not in text:
        return None, None
    left, _, right = text.partition(":")
    try:
        rw, rh = float(left), float(right)
    except ValueError:
        return None, None
    if rw <= 0 or rh <= 0:
        return None, None
    long_edge = _RATIO_LONG_EDGE
    if rw >= rh:
        w, h = long_edge, long_edge * rh / rw
    else:
        w, h = long_edge * rw / rh, long_edge
    snap = lambda v: max(_RATIO_STEP, round(v / _RATIO_STEP) * _RATIO_STEP)  # noqa: E731
    return snap(w), snap(h)


def _parse_pair_map(raw: str) -> dict[str, str]:
    """`"a=x, b"` → `{"a": "x", "b": "b"}`。省略右边 = 两边相同。逗号分隔, 认全角逗号。

    比例和画质档位共用这一条: 两者的形状完全一样 —— 左边是**我们摆在选择器里的那个值**,
    右边是**这家要我们填进去的那个值**。抄两份的话, 只会在其中一份修好"全角逗号"这类小事。
    """
    out: dict[str, str] = {}
    for part in (raw or "").replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        shown, _, send = part.partition("=")
        shown = shown.strip()
        if shown:
            out[shown] = send.strip() or shown
    return out


def parse_ratio_map(raw: str) -> dict[str, str]:
    """`"1:1=1024x1024, 16:9"` → `{"1:1": "1024x1024", "16:9": "16:9"}`。

    左边是**画布上的比例**, 右边是**这家要我们填进 size 字段的东西**。省略右边 = 两者
    相同 (绝大多数供应商, 比如 apimart 直接收 `16:9`)。

    为什么要有右边: 有些家只收一张写死的像素表, 而且那些像素**不是**按比例算出来的 ——
    OpenAI 的 gpt-image-1 只认 `1024x1024` / `1536x1024` / `1024x1536`, 而 3:2 按 1024
    长边算出来是 `1024x672`, 发过去就是 400。火山那张 `resolution → 合法像素` 表也是同一
    类东西 (内置通道靠 `size_mode=pixel` 里一段硬编码解决, 模板通道一直没有等价物)。

    合成一个字段而不是再加一个: 这两件事永远一起出现 —— 一家会挑比例的供应商, 正是会
    规定该发什么值的那一家。分成两个字段就必然出现"填了一边"的半配置状态。
    """
    return _parse_pair_map(raw)


def parse_ratios(raw: str) -> list[str]:
    """`"16:9, 1:1=1024x1024"` → `["16:9", "1:1"]` —— 只要**画布上那一半**。

    工具栏的选择器和 `nearest_ratio` 都只关心比例本身; 右边那个"实际要发的值"是渲染模板
    时才用的 (见 `parse_ratio_map`)。
    """
    return list(parse_ratio_map(raw))


def _ratio_value(ratio: str) -> float | None:
    """`"16:9"` → 1.777…。算不出来 (含 "auto") 返回 None。"""
    w, h = size_to_wh(ratio)
    if w is None or h is None:
        left, _, right = (ratio or "").partition(":")
        try:
            w, h = float(left), float(right)
        except ValueError:
            return None
    return w / h if h else None


# 一个画质档位在"贵/清晰"这条轴上的位置。`720p` → 720, `2K` → 2000, `4k` → 4000。
# 只用来排序和挑最近的一个, 不是真实像素 (`2K` 按宽算是 2560, 按高算是 1440 —— 两种都
# 不重要, 重要的是它排在 1080p 和 4k 中间)。
def _resolution_value(tier: str) -> float | None:
    text = (tier or "").strip().lower()
    if not text:
        return None
    # `NMP` = N 百万像素 (flux-2 用这个计)。换成"边长"才能跟 1K/2K/4K 排在同一根轴上:
    # 1MP = 1024², 4MP = 2048² —— 所以 4MP 落在 2K 附近, 而不是 4K 附近。照字面读成 4
    # 的话它会排到 0.5K 前面, 于是"选 2K"会挑中 flux 最小的那一档。
    if text.endswith("mp"):
        try:
            return 1024.0 * math.sqrt(float(text[:-2]))
        except ValueError:
            return None
    unit = 1000.0 if text.endswith("k") else 1.0
    head = text.rstrip("pk").strip()
    try:
        return float(head) * unit
    except ValueError:
        return None


def parse_resolution_map(raw: str) -> dict[str, str]:
    """`"720P=std, 1080P=pro"` → `{"720P": "std", "1080P": "pro"}`。

    左边是**选择器里显示的画质档**, 右边是**这家要我们填进去的值**。省略右边 = 两者相同
    (绝大多数模型直接收 `720p`)。

    右边这一半不是可选的装饰: apimart 的可灵四个模型把画质叫 `mode`, 取值是
    `std` / `pro` / `4k` —— 文档写明 std=720P、pro=1080P。选择器里摆一个「std」等于让用户
    自己去查那是多少像素, 而摆「720P」再发 `std` 两边都对。
    """
    return _parse_pair_map(raw)


def parse_resolutions(raw: str) -> list[str]:
    """`"720P=std, 1080P=pro"` → `["720P", "1080P"]` —— 只要**摆在选择器里的那一半**。"""
    return list(parse_resolution_map(raw))


def nearest_resolution(want: str, allowed: list[str]) -> str:
    """用户选的画质档 → 这个模型**真的收**的那一个。`allowed` 为空 = 不限制, 原样返回。

    先按大小写不敏感对一遍: 同一档各家写法不一 (`720p` / `720P`), 而画布上存的是上一个
    模型的写法 —— 不归一的话换个模型就变成"没匹配上", 白白掉一档。

    对不上时挑数值最近的, 平手取**低**的那个 —— 画质跟时长一样是按档计费的
    (wan3.0 的文档原话: 不传 resolution 按 1080P 计费, 对成本敏感请显式传 480P/720P)。
    """
    if not allowed:
        return want
    lowered = {r.lower(): r for r in allowed}
    hit = lowered.get((want or "").strip().lower())
    if hit is not None:
        return hit
    target = _resolution_value(want)
    scored = [(abs(value - target), value, r) for r in allowed
              if (value := _resolution_value(r)) is not None] if target is not None else []
    return min(scored)[2] if scored else allowed[0]


def parse_durations(raw: str) -> list[int]:
    """`"4, 8, 12"` → `[4, 8, 12]`。认不出的项跳过, 空串 → 空列表 (= 不限制)。"""
    out: list[int] = []
    for part in (raw or "").replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(float(part)))
        except ValueError:
            continue
    return out


def nearest_duration(want: int, allowed: list[int]) -> int:
    """用户选的秒数 → 这个模型**真的收**的那一个。`allowed` 为空 = 不限制, 原样返回。

    选择器本来就只列 allowed 里的数字, 所以正常路径永远命中。这条兜底管的是选择器拦不住
    的那几种: agent 自己挑的时长、以及"换了模型之后旧选择失效"(画布上那三档是粘在
    localStorage 里的)。
    """
    if not allowed or want in allowed:
        return want
    return min(allowed, key=lambda d: (abs(d - want), d))


def nearest_ratio(want: str, allowed: list[str]) -> str:
    """用户选的比例 → 这个模型**真的收**的那一个。

    `allowed` 为空 = 不限制, 原样返回 (绝大多数通道都是这样, 这条路不该有开销)。

    为什么要有: 同一家的不同模型吃的比例都不一样 —— 实测 apimart 的
    gemini-3.1-flash-image-preview 只收 15 种并会 400 拒掉别的, 而 gpt-image-2 连
    `999:998` 都收。画布上那十个选项是固定的, 所以"选得中但发不出去"必然发生。

    挑"最近的"用**长宽比的比值**而不是字符串: 21:9 和 2:1 是不同的字符串、几乎一样的画面。
    比不出来的 (auto, 或者写歪了的) 就退回 allowed 里的第一个 —— 宁可给一张能出的图,
    也不要一个 400。
    """
    if not allowed or want in allowed:
        return want
    target = _ratio_value(want)
    if target is None:                       # "auto" 之类: 优先仍然给 auto, 否则给 1:1
        for fallback in ("auto", "1:1"):
            if fallback in allowed:
                return fallback
        return allowed[0]
    scored = [(abs(value / target - 1), r) for r in allowed
              if (value := _ratio_value(r)) is not None]
    return min(scored)[1] if scored else allowed[0]


def bytes_to_data_uri(content: bytes) -> str:
    """原始图片字节 → data:image/...;base64,...(MIME 按字节头嗅探)。
    本地源图内联下发给 provider 时用 —— 免公网 URL / 隧道。"""
    return f"data:{_sniff_image_mime(content)};base64,{base64.b64encode(content).decode('ascii')}"


def _url_to_data_uri(url: str, session: requests.Session, timeout=_INLINE_DOWNLOAD_TIMEOUT) -> str:
    """Download an http(s) image URL and return a `data:image/...;base64,...` URI.

    Pass through unchanged if already a data URI or not http(s). Used when the
    provider cannot fetch the source itself in time — e.g. 火山 (Beijing) times
    out downloading from an overseas CDN, so the backend (which CAN reach it)
    fetches the bytes and inlines them as base64 instead.

    MIME 优先用 image/* 响应头, 否则按实际字节嗅探 (见 _sniff_image_mime) —— 绝不
    从 URL 扩展名猜, 否则签名 URL 的 ?query 会污染 MIME.
    """
    if not url.startswith(("http://", "https://")):
        return url
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        content = resp.content
    except requests.RequestException as exc:
        # 源图拉取失败 ≠ provider 生成失败: 包成 SourceImageDownloadError, 让上层当
        # transient 重试, 而不是被误判成 provider 的确定性 4xx 直接放弃。
        raise SourceImageDownloadError("inline source image download failed") from exc
    ct = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not ct.startswith("image/"):
        ct = _sniff_image_mime(content)
    ct = _MIME_ALIASES.get(ct, ct)  # 归一 image/jpg, image/mpo → image/jpeg
    return f"data:{ct};base64,{base64.b64encode(content).decode('ascii')}"


@dataclass
class ImageClient:
    """
    通用图片生成 HTTP 客户端。

    不同服务商的字段差异比如:
      - tu-zi:    image_field = "image",      size = "1664x2496"
      - apimart:  image_field = "image_urls",  size = "1:1"
    """

    base_url: str                       # 如 https://api.tu-zi.com/v1
    api_key: str                        # Bearer token
    model: str                          # 如 gpt-image-1
    image_field: str = "image"          # "image" (tu-zi) / "image_urls" (apimart)
    response_format: str = "b64_json"   # "b64_json" / "url" / 留空不传
    quality: str = ""                   # "4k" 等，留空不传
    timeout: int = 300                  # 请求超时（秒）
    # tu-zi runtime 跟自家 spec 不一致: schema 写 image=array, 但官方 example +
    # 实测都只接受单 string. n=1 情况开这个标 → image: "url"; 多图自然走 array.
    image_as_single: bool = False
    # 火山 doubao-seedream 默认 watermark=true (右下角 "AI生成" 水印), 对 Amazon 主图
    # 是合规硬伤. None=不传该字段 (用 provider 自身默认); True/False=显式下发. 只有
    # 火山这类默认打水印的 provider 才需要显式设 false.
    watermark: bool | None = None
    # 把源图 URL 下载下来改成 base64 内联下发, 而不是把 URL 交给 provider 自己 fetch.
    # 火山 (Beijing) 跨境拉海外 CDN (qiniu 新加坡) 会 download timeout, 但后端能直连 →
    # 后端下好再内联. 仅给"自己 fetch 不到远程源"的 provider (如火山) 开;能直接 fetch
    # URL 的 (如 apimart) 不必开。注: 服务层 source_to_inline_uri 已把我们自己的 media
    # 预先内联成 data URI(apimart / 火山 实测都吃 base64), 本开关只对仍是 http(s) 的
    # 外部源生效。
    inline_image: bool = False
    # 自动重试 transient 5xx / 429 (tu-zi 一天偶尔抖一次). build_image_client 用
    # functools.cache 单例化 → 同 prefix 同进程一个 ImageClient → 一个 Session →
    # TCP 池跨 task 复用 (urllib3 按 host 自动分桶, 多 provider 安全).
    session: requests.Session = field(default_factory=make_retry_session)

    def generate(
        self,
        *,
        prompt: str,
        image_urls: list[str],
        size: str,
        n: int = 1,
        resolution: str = "",
    ) -> dict[str, Any]:
        """发送图片生成请求，返回原始 JSON 响应。

        resolution: apimart Seedream-4.5 支持的画质档位 ('2K' / '4K'). 留空不传
            (服务端默认 2K). 其他不识别该字段的 provider 也安全 (额外字段忽略).
        """
        url = f"{self.base_url.rstrip('/')}/images/generations"

        send_urls = image_urls
        if self.inline_image and image_urls:
            send_urls = [_url_to_data_uri(u, self.session) for u in image_urls]
            logger.info("ImageClient inline_image: downloaded %d source url(s) → base64", len(image_urls))

        image_payload: list[str] | str = (
            send_urls[0] if self.image_as_single and len(send_urls) == 1 else send_urls
        )
        payload: dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "size": size,
            "n": n,
            self.image_field: image_payload,
        }
        if self.response_format:
            payload["response_format"] = self.response_format
        if self.quality:
            payload["quality"] = self.quality
        if resolution:
            payload["resolution"] = resolution
        if self.watermark is not None:
            payload["watermark"] = self.watermark

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(
            "ImageClient POST %s  model=%s  size=%s  image_field=%s  images=%d",
            url, self.model, size, self.image_field, len(image_urls),
        )

        resp = self.session.post(url, json=payload, headers=headers, timeout=self.timeout)
        if not resp.ok:
            logger.error(
                "ImageClient %d %s: prompt_len=%d image_count=%d body=%.500s",
                resp.status_code, url, len(prompt), len(image_urls), resp.text,
            )
            # **自己抛而不是 raise_for_status()**: 后者的消息只有一行状态
            # ("401 Client Error: Unauthorized for url: …"), 供应商真正说了什么全在 body
            # 里 —— tu-zi 那句 "Invalid token"、火山那句"model 不存在"、额度打光那句"余额
            # 不足"。而这条消息正是「测试」按钮和画布上那行红字要显示的东西, 只留一行状态
            # 等于把这个按钮存在的理由删掉了 (body 原来只进日志, 用户看不到)。
            # 模板通道那条路早就是这么做的 (template_client._request), 内置这条落下了。
            #
            # 仍然是 HTTPError 且带着 response: `_call_with_retries` 靠 `exc.response
            # .status_code` 判"确定性 4xx 不重试", 换个异常类型会让那条判断静默失效。
            raise requests.HTTPError(
                f"{resp.status_code} {resp.reason} for {url}: {resp.text[:BODY_TRUNC]}",
                response=resp,
            )
        result = resp.json()

        logger.info(
            "ImageClient response: keys=%s",
            list(result.keys()) if isinstance(result, dict) else type(result).__name__,
        )
        return result


# ImageClient 上那些旋钮的默认值 —— ImageChannel 直接引用, 不再抄第二份。
#
# 抄一份的下场很安静: build_image_client 会把两边同名的字段**全部**显式传进 ImageClient
# (见 _CLIENT_FIELDS), 所以只要是配过的通道, ImageClient 自己的默认值根本轮不到生效。
# 那时改 ImageClient.timeout=600 会毫无反应, 而两张表已经不一致了, 没有任何报错。
_D = {f.name: f.default for f in fields(ImageClient)}


# 聊天通道能说的协议。**空串排第一 = 默认**, 也就是 OpenAI 兼容那条 —— 绝大多数供应商
# 都提供它, 九条预设里九条都走这条。
#
# 表住在这个叶子模块而不是 agent/builder: 表单要它 (下拉里列哪几项), 而表单那条路不该为
# 了一张三个字符串的表把 deepagents / langchain 整个 import 进来。builder 那边的分派表
# 在 import 时对着它断言, 所以两边不可能漂。
CHAT_PROTOCOL_CHOICES: tuple[str, ...] = ("", "openai", "anthropic")

# 画质档位放在请求体的哪个键上。**这是一个二选一的事实, 不是一个开放的字段名**:
# apimart 那 41 个视频模型里 37 个叫 `resolution`, 可灵那 4 个 (kling-v2-6 / kling-v3 /
# kling-v3-omni / kling-video-o1) 叫 `mode`。模板是**每条通道一份**而模型有 41 个, 所以
# "填哪个键"只能是 per-model 的数据 —— 模板里两个占位符都写上, 没选中的那个渲染成空、
# 键整个消失 (见 request_template 的空值规则)。
#
# 做成 choices 而不是自由文本: 写一个模板里没有的名字 (`quality`), 表现是这个键静默地
# 不下发 —— 配得看上去完全正确, 而画质旋钮不起作用, 没有任何报错。
RESOLUTION_PARAM_CHOICES: tuple[str, ...] = ("resolution", "mode")


@dataclass(frozen=True)
class ImageChannel:
    """一次生图调用需要的全部供应商参数 —— 「用哪个模型、怎么跟它说话」。

    frozen 是刻意的 —— 它是不可变的配置快照。用户在前端改了任何一个字段 → 新的
    ImageChannel → 自然拿到新 client, 不需要任何显式失效逻辑; 没改则命中缓存, 连接池
    照常复用。

    (这里原来写着"它同时是 build_image_client 的缓存键, 所以必须可哈希"。那句已经不
    成立: 缓存键后来收窄成了 `_client_kwargs` 的元组, 整个 channel 从来不被 hash。留着
    那句话会让人以为加一个 dict 字段就会炸。)

    字段分三组: 连接 / 请求形状(各家差异都在这里) / 异步轮询。为什么需要这些奇怪的
    旋钮见 ImageClient 上各字段的注释 —— 那些注释就是前端配置表单的字段提示。

    **这个类的字段声明就是前端配置表单**: `image_channels.tunable_schema()` 从这里派生出
    控件类型、占位符、空选项语义, 前端照着渲染。所以

      - 声明**顺序 = 表单里同一组内的顺序**, 别随手调 (组与组的先后由
        `image_channels._TUNABLE_GROUPS` 决定);
      - 加一个旋钮, 表单里自动多一行 (只需补两条 i18n 文案);
      - 注解类型决定控件: str→输入框, int→数字框, bool→下拉, `bool | None`→下拉且
        "不填"的含义是**不下发该字段**(而不是"用我们的默认")。

    `metadata={"example": ...}` 用于占位符不等于默认值的字段 —— 只有 size_mode 是这样:
    它默认空(不做适配), 而 "pixel" 是个合法取值的示例。
    """

    # ── 连接 ──
    base_url: str
    api_key: str
    model: str
    # ── 请求形状 (默认值取自 ImageClient, 见上面 _D) ──
    image_field: str = _D["image_field"]
    image_as_single: bool = _D["image_as_single"]
    response_format: str = _D["response_format"]
    quality: str = _D["quality"]
    watermark: bool | None = _D["watermark"]
    inline_image: bool = _D["inline_image"]
    # 以下几项 ImageClient 没有 (是通道层自己的适配 / 轮询逻辑), 默认值只此一份。
    # size 适配: "pixel" → 火山合法像素; 空 + poll_enabled → 归一成比例串 (apimart)
    size_mode: str = field(default="", metadata={"example": "pixel"})
    # 聊天通道说哪种协议。空 / "openai" = OpenAI 的 /chat/completions (默认, 绝大多数);
    # "anthropic" = Anthropic 的 /v1/messages。
    #
    # 存在的理由: 国内几家的 **coding plan 订阅**卖的是 Anthropic 协议端点 (给 Claude
    # Code 用的), 比按量付费便宜一大截 —— 智谱的 `open.bigmodel.cn/api/anthropic`、
    # DeepSeek 的 `api.deepseek.com/anthropic` 都是。协议对不上时 ChatOpenAI 发出去的
    # 是 `/chat/completions`, 换回来一个 404, 而那跟"key 不对"看起来一模一样。
    #
    # 只对 chat 通道有意义 (见 KIND_SPECS)。生图那边形状由模板决定, 不需要这个开关。
    protocol: str = field(default="", metadata={"choices": CHAT_PROTOCOL_CHOICES})
    # 这个模型**真的收**哪几种比例, 逗号分隔; 空 = 不限制 (默认, 也是绝大多数通道)。
    # 每一项可以写成 `比例=要发的值` —— 有些家只收一张写死的像素表, 而那些像素不是按比例
    # 算出来的 (OpenAI: `3:2` 要发 `1536x1024`)。省略右边 = 原样发比例。见 parse_ratio_map。
    #
    # 存在的理由: 画布上那十个比例是固定的, 而各家各模型收的不一样 —— apimart 的
    # gemini-3.1-flash-image-preview 只收 15 种、别的直接 400, 同一家的 gpt-image-2 却
    # 什么都收。填了之后两件事: 工具栏的比例选择器只列这些, 后端再把漏网的映射到最近的
    # 一个 (agent 自己挑的尺寸、以及"换了模型之后旧选择失效"都走这条兜底)。
    #
    # **放在旋钮里而不是写一张内置表**: 这是 per-model 的事实, 而 overrides 本来就是
    # per-model 的 —— 同一条通道下两个模型可以各填各的。内置表则永远追不上新模型。
    # 这个模型**真的收**哪几个时长(秒), 逗号分隔; 空 = 用画布自己那三档 (5/10/15)。
    #
    # 跟 allowed_ratios 不同, 这里**不需要"画布值=要发的值"映射** —— 选择器直接列这些
    # 数字。veo3 只出 8 秒, 那就让它显示「8 秒」, 而不是显示「5 秒」偷偷发 8: 后者用户
    # 拿到一条时长不对的视频, 还以为是模型没听话。
    #
    # 实测这件事有多要紧: 画布原来固定给 5/10/15, 而 apimart 那 41 个模型里 veo3 只收 8、
    # sora 只收 4/8/12/16/20 —— 那八个模型**一条都生成不出来**, 而报错是供应商给的
    # invalid duration, 跟"通道配错了"看起来一样。
    allowed_durations: str = field(default="", metadata={"example": "5, 10, 15"})
    allowed_ratios: str = field(
        default="", metadata={"example": "16:9, 1:1, 4:3, auto  或  16:9=1536x1024"},
    )
    # 这个模型**真的收**哪几个画质档, 由低到高; 空 = 这个模型没有画质旋钮, 那个键不下发
    # (= 用供应商自己的默认, 也就是这个功能之前的行为)。
    #
    # 跟 allowed_durations 一样是"照它列"而不是"拿它筛" —— 画布这边根本没有一张固定的
    # 画质档表可筛, 各家的档位从 360p 一路到 4k, 还有 MiniMax 的 `2K`、可灵的 `std/pro`。
    #
    # 右边那一半 (`720P=std`) 的用处见 parse_resolution_map。
    #
    # **不填的代价是钱**: wan3.0-video 的文档原话是"不传 resolution 时按 1080P 计费,
    # 对成本敏感时请显式传 480P 或 720P" —— 一条没配这一项的通道会一直按最贵的档出片,
    # 而界面上完全看不出来。
    allowed_resolutions: str = field(default="", metadata={"example": "480p, 720p, 1080p"})
    # 画质档发到哪个键上。只有视频通道用得上 (生图那边没有第二种叫法)。见
    # RESOLUTION_PARAM_CHOICES。
    resolution_param: str = field(
        default="resolution", metadata={"choices": RESOLUTION_PARAM_CHOICES},
    )
    timeout: int = _D["timeout"]
    # ── 异步轮询 (apimart 这类先返 task_id 的供应商) ──
    poll_enabled: bool = False
    poll_url: str = ""          # 空则用 base_url
    # 200 × 5 秒 ≈ 17 分钟。给得宽是因为**它不是超时**: 轮询一轮只是一个便宜的 GET,
    # 而这个数管的是"等多久才认输"。给小了的表现是一条**配得完全正确**、只是出图慢的
    # 通道稳定报"轮询完了还没结果" —— 那是最难查的一类假失败, 因为每个字段看上去都对。
    # 真正兜底的是 poll_timeout(单轮)和「测试」按钮那条 deadline(同步调用), 不是这个数。
    poll_max_attempts: int = 200
    poll_interval: int = 5
    # 退避上限: 每轮等待**翻倍**直到这个值。0 / ≤poll_interval = 不退避, 固定间隔。
    # 视频是分钟级的, 固定 5 秒去敲一个要跑 3 分钟的任务只是白敲。
    poll_max_interval: int = 0
    poll_timeout: int = 30
    # ── 模板通道 (kind=custom_*) ──
    # 这条通道是哪种 kind。生成路径据此分流: 模板通道走 template_client, 其余走
    # ImageClient 那套写死的形状。
    kind: str = ""
    # 一次调用的完整形状 (method/url/headers/body/result_path + 可选的 poll)。
    # 只有 kind=custom_* 用得上, 其余留空。
    #
    # `compare=False` 把它排除在 __eq__ / __hash__ 之外 —— dict 本身不可哈希, 而
    # frozen dataclass 会生成 __hash__。**将来如果有人重新按整个 channel 做缓存, 这里
    # 是个坑**: 两条只差模板的通道会被判等、撞同一个缓存格。真要那么做的话, 先把这个
    # 字段换成一个可哈希的表示 (比如 json.dumps 的结果), 别直接把 compare 改回去。
    request_template: dict = field(default_factory=dict, compare=False)
    # ── 身份 (不参与请求) ──
    # 这条通道是库里哪一行 ImageProvider。**只给 channel_health 用** —— 它要把"这次调用
    # 供应商应答了吗"记回那一行。空串 = 不是从库里来的 (向导里还没保存的探针通道), 记录
    # 直接跳过。
    #
    # 放在通道上而不是让每个调用方自己传: 调用方拿到的就是这个 dataclass, 再多传一个
    # provider_id 意味着**每一条**生成路径 (生图/角度/视频/探针) 都要各自记得带上它, 而
    # 忘掉的那条会静默地不记健康 —— 没有任何报错, 只是那张卡片上的点永远是灰的。
    provider_id: str = ""
    # 只用于日志和报错文案, 不参与请求 (库通道是"供应商 · 模型")
    label: str = ""


# ImageChannel 里 HTTP 层真正用得到的那些字段 —— 从两个 dataclass 的交集派生, 不手抄。
# 手抄的那份会在有人给 ImageChannel 加旋钮时悄悄落后, 表现是"在界面上配了却不生效",
# 而且没有任何报错。(session 是 ImageClient 自己 default_factory 出来的, 不从通道来。)
_CLIENT_FIELDS = frozenset(f.name for f in fields(ImageClient)) & frozenset(
    f.name for f in fields(ImageChannel)
)


# maxsize 而非无上限 cache: 通道现在可由用户在前端编辑, 每次改动产生一个新键, 无上限
# 会一直堆积。32 远超任何人会配的通道数, 又保证旧 client (及其 TCP 池) 最终被回收。
@functools.lru_cache(maxsize=32)
def _build_client(client_key: tuple) -> ImageClient:
    return ImageClient(**dict(client_key))


def _client_kwargs(channel: ImageChannel) -> dict:
    """通道里 HTTP 层用得到的那部分。_CLIENT_FIELDS 存在的意义就是这个投影只写一次 ——
    build_image_client / build_probe_client 两处各抄一遍的话, 它们的唯一真实差别
    (session 和缓存) 就淹没在两段看起来一样的推导式里了。"""
    return {k: v for k, v in asdict(channel).items() if k in _CLIENT_FIELDS}


def build_image_client(channel: ImageChannel) -> ImageClient:
    """通道 → HTTP 客户端。HTTP 参数相同的通道共用一个实例 (TCP 池跨 task 复用)。

    缓存键**只取 HTTP 层用得到的字段**, 不是整个通道。否则同一供应商下两个只差
    size_mode 的模型 (豆包要 pixel、Google 不要 —— 正是这个特性的典型场景) 会各自建一个
    Session、对同一个 host 开两套连接池; 给供应商改个名字也会白白丢掉一个热的池子。
    """
    return _build_client(tuple(sorted(_client_kwargs(channel).items())))


def build_probe_client(channel: ImageChannel) -> ImageClient:
    """配置面板「测试」按钮专用的客户端: 不进缓存、**不重试**。

    worker 里重试是对的 (用户不在场, 多等 7 秒好过一次 FAILED), 但测试是一次同步 HTTP
    请求, 浏览器和反代都在等着 —— 默认的 total=3 会把 ImageProviderTestView 那个 60s 墙钟
    预算悄悄乘成四倍 (4 × 单次超时 + 1/2/4s 退避), 用户拿到的是一句通用网络错误, 而这个
    接口存在的全部价值就是把供应商的原始报文放到他眼前。angle 那边的 `_probe_session`
    是同一条理由, 生图这条不能落下。

    也不进 lru_cache: 探针用的是被钳过的一次性参数组合, 缓存它只会把真正在跑的通道从
    32 格里挤出去, 连带丢掉一个热的连接池。
    """
    return ImageClient(session=make_retry_session(total=0), **_client_kwargs(channel))
