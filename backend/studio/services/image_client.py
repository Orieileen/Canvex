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
    timeout: int = _D["timeout"]
    # ── 异步轮询 (apimart 这类先返 task_id 的供应商) ──
    poll_enabled: bool = False
    poll_url: str = ""          # 空则用 base_url
    poll_max_attempts: int = 60
    poll_interval: int = 5
    # 退避上限: 每轮等待 ×1.5 直到这个值。0 / ≤poll_interval = 不退避, 固定间隔。
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
