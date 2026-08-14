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

logger = logging.getLogger(__name__)

# 请求体里"装图"的字段候选。命中即认为是 image_field。顺序 = 优先级。
_IMAGE_KEYS = ("image_urls", "image_url", "images", "image", "reference_images", "init_images")
# 我们自己会填的字段, 从 curl 推断时要忽略 (用户示例里常有占位值)
_IGNORED_BODY_KEYS = {"prompt", "n", "size", "seed", "user"}
# 能从请求体直接抄过来的标量字段 → 期望类型。一张表同时驱动"抄出来"和"哪些算认识的",
# 分成两处写的话, 加第五个字段时漏掉后半边就会被当成"无法识别"报给用户。
_SCALAR_KEYS = {"model": str, "response_format": str, "quality": str, "watermark": bool}

# ImageClient 会自己拼 `/images/generations`, 所以 base_url 要把这段路径剥掉。
# 只剥这一段, 不要连版本前缀一起剥 —— `/v1/images/generations` 的 base_url 是
# `…/v1`, 不是裸域名。
_GENERATION_PATH_RE = re.compile(r"/(images/)?generations?/?$", re.I)


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

    out: dict = {"base_url": _strip_generation_path(url)}

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


def _strip_generation_path(url: str) -> str:
    """`https://host/v1/images/generations` → `https://host/v1`。

    ImageClient 自己拼 `/images/generations`, base_url 留着那段会拼成双份路径 —— 这是
    用户对着文档粘 curl 时几乎必然会踩的一脚。
    """
    parts = urlparse(url)
    path = _GENERATION_PATH_RE.sub("", parts.path or "")
    return urlunparse((parts.scheme, parts.netloc, path.rstrip("/"), "", "", ""))


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
