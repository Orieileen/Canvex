"""
通用图片生成 HTTP 客户端。

适配任何 OpenAI 兼容的 /images/generations 接口，
不同服务商的差异通过字段映射 + 环境变量解决。

用法:
    channel = channel_from_env("CANVAS_IMAGE_PRIMARY")   # 或 channel_from_model(...)
    client = build_image_client(channel)
    result = client.generate(prompt=..., image_urls=[...], size=...)

「通道」(ImageChannel) 是一次调用需要的全部供应商参数。它有两个来源 —— env 前缀
(channel_from_env) 和数据库里用户在前端配的 ImageProvider/ImageModel
(services/image_channels.py) —— 但下游只认这个 dataclass, 不知道也不关心它从哪来。
"""

import base64
import functools
import logging
from dataclasses import dataclass, field
from typing import Any

import requests

from studio.services.http_retry import make_retry_session
from studio.services.listings_utils import SourceImageDownloadError, env, env_bool, env_int

logger = logging.getLogger(__name__)


# 源图下载超时跟生成 POST 分开: 生成 self.timeout 可能 300s (出图慢), 但源图下载
# 应快; CDN 卡住别把 worker 线程拖满 5 分钟. (connect, read) 秒.
_INLINE_DOWNLOAD_TIMEOUT = (10, 60)

# 非标准 / 容器 MIME 归一到火山认的标准类型. 'image/jpg' 是常见非规范拼写; 'MPO'
# 是 iPhone 多图 JPEG 容器 (PIL 报 'MPO'), 本质是 JPEG —— 不归一会拼出火山拒收的
# data:image/mpo / data:image/jpg.
_MIME_ALIASES = {"image/jpg": "image/jpeg", "image/mpo": "image/jpeg", "image/jfif": "image/jpeg"}


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
            # provider HTTP 错误 → 把 status + body 打 ERROR 让定位 (tu-zi/apimart 的
            # 400/422 通常带具体字段 / quota / model 错误描述). raise_for_status 之前
            # 拦, 再让它 raise 不掩盖原 HTTPError.
            logger.error(
                "ImageClient %d %s: prompt_len=%d image_count=%d body=%.500s",
                resp.status_code, url, len(prompt), len(image_urls), resp.text,
            )
        resp.raise_for_status()
        result = resp.json()

        logger.info(
            "ImageClient response: keys=%s",
            list(result.keys()) if isinstance(result, dict) else type(result).__name__,
        )
        return result


@dataclass(frozen=True)
class ImageChannel:
    """一次生图调用需要的全部供应商参数 —— 「用哪个模型、怎么跟它说话」。

    frozen 是刻意的: 它同时是 build_image_client 的**缓存键**, 所以必须可哈希。用户在
    前端改了任何一个字段 → 新的 ImageChannel → 自然拿到新 client, 不需要任何显式失效
    逻辑; 没改则命中缓存, 连接池照常复用。

    字段分三组: 连接 / 请求形状(各家差异都在这里) / 异步轮询。为什么需要这些奇怪的
    旋钮见 ImageClient 上各字段的注释 —— 那些注释就是前端配置表单的字段提示。
    """

    # ── 连接 ──
    base_url: str
    api_key: str
    model: str
    # ── 请求形状 ──
    image_field: str = "image"
    image_as_single: bool = False
    response_format: str = "b64_json"
    quality: str = ""
    watermark: bool | None = None
    inline_image: bool = False
    timeout: int = 300
    # size 适配: "pixel" → 火山合法像素; 空 + poll_enabled → 归一成比例串 (apimart)
    size_mode: str = ""
    # ── 异步轮询 (apimart 这类先返 task_id 的供应商) ──
    poll_enabled: bool = False
    poll_url: str = ""          # 空则用 base_url
    poll_max_attempts: int = 60
    poll_interval: int = 5
    poll_timeout: int = 30
    # 只用于日志和报错文案, 不参与请求 (env 通道是前缀名, 库通道是"供应商 · 模型")
    label: str = ""


def channel_from_env(prefix: str) -> ImageChannel:
    """从环境变量前缀构建通道 —— 老路径, 库里还没配置时的兜底。

    参数:
        prefix: 环境变量前缀，如 "CANVAS_IMAGE_PRIMARY" 或 "CANVAS_IMAGE_FALLBACK"

    读取的环境变量:
        {prefix}_BASE_URL           服务商端点      (可回退 OPENAI_BASE_URL)
        {prefix}_API_KEY            Bearer 密钥     (可回退 OPENAI_API_KEY)
        {prefix}_MODEL              模型名称         (必须)
        {prefix}_IMAGE_FIELD        图片字段名       (默认 "image")
        {prefix}_IMAGE_AS_SINGLE    n=1 时发 string  (默认 false; tu-zi 设 true)
        {prefix}_RESPONSE_FORMAT    响应格式         (默认 "b64_json")
        {prefix}_QUALITY            质量参数         (可选)
        {prefix}_WATERMARK          是否打水印       (未设=不传; 火山默认 true 需显式 false)
        {prefix}_INLINE_IMAGE       外部源 URL 下载转 base64 (默认 false; 火山拉不到远程源时设 true)
        {prefix}_TIMEOUT            请求超时秒数     (默认 300)
        {prefix}_SIZE_MODE          "pixel" → 火山合法像素
        {prefix}_POLL_*             异步轮询 (ENABLED / URL / MAX_ATTEMPTS / INTERVAL / TIMEOUT)
    """
    base_url = env(f"{prefix}_BASE_URL") or env("OPENAI_BASE_URL")
    api_key = env(f"{prefix}_API_KEY") or env("OPENAI_API_KEY")
    model = env(f"{prefix}_MODEL")

    if not base_url or not api_key or not model:
        missing = []
        if not base_url:
            missing.append(f"{prefix}_BASE_URL")
        if not api_key:
            missing.append(f"{prefix}_API_KEY")
        if not model:
            missing.append(f"{prefix}_MODEL")
        raise RuntimeError(f"缺少环境变量: {', '.join(missing)}")

    # tri-state: env 未设 → None (不下发, 用 provider 默认); 设了 → 显式 true/false.
    watermark = env_bool(f"{prefix}_WATERMARK") if env(f"{prefix}_WATERMARK") else None

    return ImageChannel(
        base_url=base_url,
        api_key=api_key,
        model=model,
        image_field=env(f"{prefix}_IMAGE_FIELD") or "image",
        image_as_single=env_bool(f"{prefix}_IMAGE_AS_SINGLE", default=False),
        response_format=env(f"{prefix}_RESPONSE_FORMAT") or "b64_json",
        quality=env(f"{prefix}_QUALITY"),
        watermark=watermark,
        inline_image=env_bool(f"{prefix}_INLINE_IMAGE", default=False),
        timeout=env_int(f"{prefix}_TIMEOUT", 300),
        size_mode=env(f"{prefix}_SIZE_MODE"),
        poll_enabled=env_bool(f"{prefix}_POLL_ENABLED"),
        poll_url=env(f"{prefix}_POLL_URL"),
        poll_max_attempts=env_int(f"{prefix}_POLL_MAX_ATTEMPTS", 60),
        poll_interval=env_int(f"{prefix}_POLL_INTERVAL", 5),
        poll_timeout=env_int(f"{prefix}_POLL_TIMEOUT", 30),
        label=prefix,
    )


# maxsize 而非无上限 cache: 通道现在可由用户在前端编辑, 每次改动产生一个新键, 无上限
# 会一直堆积。32 远超任何人会配的通道数, 又保证旧 client (及其 TCP 池) 最终被回收。
@functools.lru_cache(maxsize=32)
def build_image_client(channel: ImageChannel) -> ImageClient:
    """通道 → HTTP 客户端。同通道同进程一个实例 (TCP 池跨 task 复用)。"""
    return ImageClient(
        base_url=channel.base_url,
        api_key=channel.api_key,
        model=channel.model,
        image_field=channel.image_field,
        image_as_single=channel.image_as_single,
        response_format=channel.response_format,
        quality=channel.quality,
        watermark=channel.watermark,
        inline_image=channel.inline_image,
        timeout=channel.timeout,
    )
