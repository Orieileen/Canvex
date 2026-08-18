"""从供应商文档里的示例 curl 推断通道配置。

为什么需要这个: 那 16 个旋钮是 Canvex 适配器的词汇, 不是供应商的词汇。文档会写
「`image` 传 URL 数组」, 不会告诉你 `image_as_single` 该开还是关 —— 用户要做的是把文档
**翻译**成我们的旋钮, 而卡住的正是这一步。

所以不内置供应商预设 (维护负担, 且永远追不上新供应商), 改成让用户把文档里的示例 curl
粘进来, 从请求体的形状把这几个字段推出来。推不出来的留空由用户填。
"""
import json
import logging
import re
import shlex
from urllib.parse import urlparse, urlunparse

from studio.services.image_channels import TUNABLE_TYPES

logger = logging.getLogger(__name__)

# 请求体里"装图"的字段候选。命中即认为是 image_field。顺序 = 优先级。
_IMAGE_KEYS = ("image_urls", "image_url", "images", "image", "reference_images", "init_images")
# 我们自己会填的字段, 从 curl 推断时要忽略 (用户示例里常有占位值)
_IGNORED_BODY_KEYS = {"prompt", "n", "size", "seed", "user"}
# 能从请求体直接抄过来的标量字段 → 期望类型。一张表同时驱动"抄出来"和"哪些算认识的",
# 分成两处写的话, 加第五个字段时漏掉后半边就会被当成"无法识别"报给用户。
# 示例 curl 的请求体里, 哪些键我们认得 —— **类型从 TUNABLE_TYPES 取, 不再手写一份**。
# 手写那份的失败方式很安静: 把 quality 在 ImageChannel 上改成 int 之后, 这里仍然只认
# str, 于是那个值既进不了预填, 又会被塞进 `_unrecognized` 报给用户说"这个键我们不认识"
# —— 一句错话, 且没有任何报错。model 不在 TUNABLE_TYPES 里 (它不是旋钮, 有自己的字段)。
_SCALAR_KEYS = {"model": str} | {
    k: TUNABLE_TYPES[k] for k in ("response_format", "quality", "watermark")
}

# ImageClient 会自己拼 `/images/generations`, 所以 base_url 要把这段路径剥掉。
# 只剥这一段, 不要连版本前缀一起剥 —— `/v1/images/generations` 的 base_url 是
# `…/v1`, 不是裸域名。
#
# `videos/` 也认: 视频通道自己拼 `/videos/generations`, 而这个导入框是通用的 (kind 就在
# 下面一行选)。只剥 `generations` 的话 `/v1/videos/generations` 会留下 `/v1/videos`,
# 换成 video 通道后拼出 `/v1/videos/videos/generations`, 而且看起来完全正常。
_GENERATION_PATH_RE = re.compile(r"/(?:images/|videos/)?generations?/?$", re.I)


class CurlParseError(ValueError):
    """curl 文本无法解析 —— 消息直接给用户看, 所以要说人话。"""


def parse_curl(text: str) -> dict:
    """示例 curl → 可以预填进配置表单的字段。

    返回的键是 ImageProvider/ImageModel 表单的字段名, 只包含**推断出来的**那些 ——
    调用方把它们当预填值, 没推断出来的留给用户填。
    """
    text = (text or "").strip()
    if not text:
        raise CurlParseError("请粘贴一段 curl 命令")

    # 文档里的示例常有续行反斜杠和花哨引号, 先归一, 否则 shlex 会当成参数
    text = text.replace("\\\n", " ").replace("\\\r\n", " ")
    text = text.replace("‘", "'").replace("’", "'")
    text = text.replace("“", '"').replace("”", '"')

    try:
        tokens = shlex.split(text)
    except ValueError as exc:
        raise CurlParseError(f"引号不成对, 无法解析: {exc}") from exc
    if not tokens or tokens[0] != "curl":
        raise CurlParseError("这看起来不是一段 curl 命令(要以 curl 开头)")

    url, headers, body_raw = _scan_tokens(tokens[1:])
    if not url:
        raise CurlParseError("没找到请求 URL")

    base_url, path_note = _strip_generation_path(url)
    out: dict = {"base_url": base_url}
    if path_note:
        out["_path_note"] = path_note

    api_key = _api_key_from_headers(headers)
    if api_key:
        out["api_key"] = api_key

    if body_raw:
        out.update(_from_body(body_raw))
    return out


def _scan_tokens(tokens: list[str]) -> tuple[str, dict, str]:
    """一趟扫完 curl 参数, 取出 URL / 请求头 / 请求体。"""
    url, headers, body = "", {}, ""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in ("-H", "--header") and i + 1 < len(tokens):
            raw = tokens[i + 1]
            if ":" in raw:
                k, v = raw.split(":", 1)
                headers[k.strip().lower()] = v.strip()
            i += 2
        elif tok in ("-d", "--data", "--data-raw", "--data-binary") and i + 1 < len(tokens):
            body = tokens[i + 1]
            i += 2
        elif tok in ("-X", "--request", "-u", "--user") and i + 1 < len(tokens):
            i += 2  # 方法/basic-auth 我们不需要
        elif tok.startswith("http://") or tok.startswith("https://"):
            url = tok
            i += 1
        else:
            i += 1
    return url, headers, body


def _api_key_from_headers(headers: dict) -> str:
    """从 Authorization / x-api-key 取 key。文档示例里通常是 `$YOUR_API_KEY` 这类占位符,
    识别出来就不要往表单里填 —— 填了用户会以为已经配好。"""
    raw = headers.get("authorization") or headers.get("x-api-key") or ""
    raw = re.sub(r"^Bearer\s+", "", raw.strip(), flags=re.I)
    if not raw:
        return ""
    placeholder = (
        raw.startswith("$")
        or raw.startswith("<")
        or "YOUR" in raw.upper()
        or "API_KEY" in raw.upper()
        or set(raw) <= {"x", "X", "*", ".", "-"}
    )
    return "" if placeholder else raw


# 剥完之后 base_url 里还允许剩下的路径段: 版本前缀而已。多出别的段说明这根本不是我们
# 会打的那个端点 (比如 /v1/images/edits —— tu-zi 的图生图, multipart 表单)。
_VERSION_SEGMENT_RE = re.compile(r"^(?:v\d+\w*|api|openai)$", re.I)


def _strip_generation_path(url: str) -> tuple[str, str]:
    """`https://host/v1/images/generations` → `https://host/v1`, 外加一句"没剥干净"的说明。

    ImageClient 自己拼 `/images/generations`, base_url 留着那段会拼成双份路径 —— 这是
    用户对着文档粘 curl 时几乎必然会踩的一脚。

    剥不掉的情况必须**说出来**: 粘一段 `/v1/images/edits` (图生图, multipart) 进来时,
    正则匹配不上, 于是整条路径原样留在 base_url 里, 之后拼成
    `.../v1/images/edits/images/generations` —— 一个必然 404 的地址, 而用户完全看不出
    哪里错了。这个导入框是没有内置预设之后唯一的反馈回路, 给一个静默的错答案是最坏的结果。
    """
    parts = urlparse(url)
    path = _GENERATION_PATH_RE.sub("", parts.path or "")
    leftover = [seg for seg in path.strip("/").split("/") if seg]
    note = ""
    if any(not _VERSION_SEGMENT_RE.match(seg) for seg in leftover):
        note = (
            f"这段 curl 打的是 /{'/'.join(leftover)}, 不是 Canvex 会打的 "
            "/images/generations(或 /videos/generations)。Base URL 已按原样填入, "
            "但请自行改成不带端点路径的部分(通常到 /v1 为止), 否则请求地址会多出一截。"
        )
    return urlunparse((parts.scheme, parts.netloc, path.rstrip("/"), "", "", "")), note


def _from_body(body_raw: str) -> dict:
    """从 JSON 请求体推断字段形状。非 JSON(表单等)就放弃推断, 不报错。"""
    try:
        body = json.loads(body_raw)
    except (ValueError, TypeError):
        logger.info("curl import: 请求体不是 JSON, 跳过形状推断")
        return {}
    if not isinstance(body, dict):
        return {}

    out: dict = {}
    for key, expected in _SCALAR_KEYS.items():
        if isinstance(body.get(key), expected):
            out[key] = body[key]

    for key in _IMAGE_KEYS:
        if key in body:
            out["image_field"] = key
            # 这正是「文档写 array 但实测只吃单 string」那类差异的来源: 示例里给的是
            # 字符串就说明这家 n=1 时要单值。
            out["image_as_single"] = isinstance(body[key], str)
            break

    # 示例里出现但我们不认识的键 —— 报给用户看, 别假装没发生
    known = _IGNORED_BODY_KEYS | set(_SCALAR_KEYS) | set(_IMAGE_KEYS)
    unknown = [k for k in body if k not in known]
    if unknown:
        out["_unrecognized"] = unknown
    return out
