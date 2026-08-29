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
# 端点路径 = `/<组>/<动作>` 或裸 `/generations`。四种 kind 各自会拼的那一段都在这:
#   images/generations  images/edits     videos/generations   chat/completions
# 剥**整段**而不只剥 `generations`: 用户粘的可能是同一家的另一个端点 (tu-zi 的
# /v1/images/edits 是图生图), 而 API 根仍然是 /v1 —— 那才是 base_url 该填的东西。留着
# 半截路径会拼成 `.../images/edits/images/generations`, 是个必然 404 的地址。
_GENERATION_PATH_RE = re.compile(
    r"/(?:(?:images|videos|chat)/[\w.-]+|generations?)/?$", re.I,
)


class CurlParseError(ValueError):
    """curl 文本无法解析 —— 消息直接给用户看, 所以要说人话。"""


def parse_curl(text: str) -> dict:
    """示例 curl → 可以预填进配置表单的字段。

    返回的键是 ImageProvider/ImageModel 表单的字段名, 只包含**推断出来的**那些 ——
    调用方把它们当预填值, 没推断出来的留给用户填。
    """
    url, headers, body_raw, form = _scan_tokens(_tokenize(text))
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
    elif form:
        out.update(_from_form(form))
    return out


def _tokenize(text: str) -> list[str]:
    """一段 curl 文本 → 去掉 `curl` 之后的参数列表。

    归一化那几步是必需的而不是防御性的: 文档里的示例几乎一定带续行反斜杠, 而中文文档
    常被编辑器把引号换成全角 —— 两者都会让 shlex 把整段切错。
    """
    text = (text or "").strip()
    if not text:
        raise CurlParseError("请粘贴一段 curl 命令")
    text = text.replace("\\\n", " ").replace("\\\r\n", " ")
    text = text.replace("‘", "'").replace("’", "'")
    text = text.replace("“", '"').replace("”", '"')
    try:
        tokens = shlex.split(text)
    except ValueError as exc:
        raise CurlParseError(f"引号不成对, 无法解析: {exc}") from exc
    if not tokens or tokens[0] != "curl":
        raise CurlParseError("这看起来不是一段 curl 命令(要以 curl 开头)")
    return tokens[1:]


def _split_endpoint(url: str) -> tuple[str, str]:
    """完整 URL → (base_url, 剩下的路径)。

    跟 `_strip_generation_path` 的区别: 那个是为内置通道服务的(它自己会拼
    `/images/generations`, 所以路径必须**丢掉**); 模板通道要把路径**留在模板里**,
    因为端点是用户自己写的 —— 这正是模板通道能够到 `/images/edits`、chat 格式生图、
    Midjourney 的原因。
    """
    stripped, _note = _strip_generation_path(url)
    path = url[len(stripped):] if url.startswith(stripped) else ""
    return stripped, path or "/"


def _scan_tokens(tokens: list[str]) -> tuple[str, dict, str, dict]:
    """一趟扫完 curl 参数, 取出 URL / 请求头 / 请求体 / multipart 字段。"""
    url, headers, body, form = "", {}, "", {}
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
        elif tok in ("-F", "--form") and i + 1 < len(tokens):
            # multipart 示例 (`-F model=gpt-image-2`)。文件字段 (`-F image=@01.png`) 只取
            # 键名 —— 那正好告诉我们这家把源图放在哪个字段里, 跟 JSON 体推断的是同一件事。
            raw = tokens[i + 1]
            if "=" in raw:
                k, v = raw.split("=", 1)
                form[k.strip()] = v.strip()
            i += 2
        elif tok in ("-X", "--request", "-u", "--user") and i + 1 < len(tokens):
            i += 2  # 方法/basic-auth 我们不需要
        elif tok.startswith("http://") or tok.startswith("https://"):
            url = tok
            i += 1
        else:
            i += 1
    return url, headers, body, form


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
    """`https://host/v1/images/generations` → `https://host/v1`, 外加一句"没认出来"的说明。

    ImageClient 自己拼 `/images/generations`, base_url 留着那段会拼成双份路径 —— 这是
    用户对着文档粘 curl 时几乎必然会踩的一脚。

    **剥掉了就不多嘴。** 剥得掉说明我们认出了端点那一段, 剩下的就是 API 根, 哪怕它长得
    不像版本号 —— Azure 的 `/openai/deployments/<部署名>` 就是这样, 对它报警是误报。

    **一段都没剥掉、而路径里还有非版本段**才提示: 那说明这个 URL 的形状我们没见过, 猜不出
    根在哪 (比如 fal.run 那种模型名即路径的), 只能让用户自己删。这个导入框是没有内置预设
    之后唯一的反馈回路, 半对的答案跟错答案一样糟 —— 但乱报警会让人学会忽略它。
    """
    parts = urlparse(url)
    raw_path = parts.path or ""
    path = _GENERATION_PATH_RE.sub("", raw_path)
    note = ""
    if path == raw_path:
        leftover = [seg for seg in path.strip("/").split("/") if seg]
        if any(not _VERSION_SEGMENT_RE.match(seg) for seg in leftover):
            note = (
                f"没认出 /{'/'.join(leftover)} 是哪个端点, Base URL 先按原样填入了。"
                "它应该只到 API 的根(通常是 /v1, 或者只有域名), 端点路径由 Canvex 自己拼 —— "
                "请把多余的那一段删掉, 否则请求地址会多出一截。"
            )
    return urlunparse((parts.scheme, parts.netloc, path.rstrip("/"), "", "", "")), note


def _from_form(form: dict) -> dict:
    """从 multipart 字段推断。

    有些供应商的文档只给 multipart 示例 (tu-zi 的 /v1/images/edits 就是), 而同一家的
    generations 端点仍然是我们能打的 JSON 形状 —— 模型名、尺寸这些照样是对的, 丢掉等于
    让用户白粘一遍。

    表单值全是字符串, 所以只认字符串型的旋钮 (`_SCALAR_KEYS` 里 bool 的那个跳过 ——
    "true"/"false" 到底哪个意思要看这家怎么定义, 猜错比不填更糟)。
    """
    out: dict = {}
    for key, expected in _SCALAR_KEYS.items():
        if expected is str and isinstance(form.get(key), str) and form[key]:
            out[key] = form[key]

    for key in _IMAGE_KEYS:
        if key in form:
            out["image_field"] = key
            # multipart 一个字段只能装一个文件, 说明不了这家 n>1 时收数组还是多字段,
            # 所以**不猜** image_as_single —— 留给用户按 generations 的文档填。
            break

    known = _IGNORED_BODY_KEYS | set(_SCALAR_KEYS) | set(_IMAGE_KEYS)
    unknown = [k for k in form if k not in known]
    if unknown:
        out["_unrecognized"] = unknown
    return out


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


# ─────────────────────── curl → 请求模板 ───────────────────────
#
# 上面那套 `parse_curl` 是把 curl 猜成**内置通道的十四个旋钮**; 这里是把 curl 变成
# **模板通道的请求模板**。后者其实更直接 —— curl 本身就是一个请求, 不需要"这个差异对应
# 哪个开关"那层映射, 只需要决定哪些值该变成占位符。
#
# 存在的理由: 让人手写模板 JSON 是不现实的。`data.result.images[0].url[0]` 这种路径
# 连写代码的人都是跑一次看回包才知道的。而用户**已经有**请求那一半 —— 供应商文档里
# 那段 curl。响应那一半由 `probe_result_path` 跑一次自动找出来。

# 键名 → 变量。按 key 猜, 命中即用。顺序无关, 键名是精确匹配(小写)。
_KEY_TO_VAR: dict[str, str] = {
    "model": "model", "model_name": "model",
    "prompt": "prompt", "text": "prompt", "description": "prompt", "input": "prompt",
    "n": "n", "num_images": "n", "count": "n", "samples": "n", "batch_size": "n",
    "aspect_ratio": "aspect_ratio", "ratio": "aspect_ratio",
    "width": "width", "height": "height",
    "resolution": "resolution", "quality_tier": "resolution",
    "duration": "duration", "duration_seconds": "duration",
}
# 装图的键。值是数组 → {{images}}, 是字符串 → {{image}}。
_IMAGE_KEYS = {
    "image", "images", "image_url", "image_urls", "init_image", "init_images",
    "source_image", "source_images", "reference_image", "reference_image_urls",
}
# `size` 要看**值长什么样**才知道是像素还是比例 —— 这一条是实测撞出来的:
# apimart 拒了 "1024x1024" 并回 `supported ratios: 16:9, 1:1, …`。
_PIXELS_RE = re.compile(r"^\d{2,5}\s*[x×]\s*\d{2,5}$", re.I)
_RATIO_RE = re.compile(r"^\d{1,2}\s*:\s*\d{1,2}$")
# 文档里的假 key: <token> / YOUR_API_KEY / sk-xxxx / ****。别把它们当成真 key 存下来。
_FAKE_KEY_RE = re.compile(r"^(<.*>|\{.*\}|your[_-]?\w*|xxx+|\*{3,}|sk-x+|token|api[_-]?key)$", re.I)


def _var_for(key: str, value: object) -> str | None:
    """这个请求体的键该换成哪个占位符。认不出来返回 None —— 那就原样保留, 它是这家的
    固定参数 (比如 apimart 的 `"response_format": "url"`)。"""
    k = key.strip().lower()
    if k in _IMAGE_KEYS:
        return "images" if isinstance(value, list) else "image"
    if k in ("size", "image_size"):
        text = str(value).strip()
        if _RATIO_RE.match(text):
            return "aspect_ratio"
        if _PIXELS_RE.match(text):
            return "size"
        return "size"          # 认不出格式时按像素走, 那是 canvas 的原生形式
    return _KEY_TO_VAR.get(k)


def _templatize(node: object, trail: str, mapping: list[dict]) -> object:
    """递归把请求体里的值换成占位符, 同时记下"哪个键被认成了什么" —— 那张表是给界面
    渲染成一行一个下拉用的, 用户能当场改掉猜错的。"""
    if isinstance(node, dict):
        return {k: _templatize_value(k, v, f"{trail}.{k}" if trail else k, mapping)
                for k, v in node.items()}
    if isinstance(node, list):
        return [_templatize(v, f"{trail}[{i}]", mapping) for i, v in enumerate(node)]
    return node


def _templatize_value(key: str, value: object, path: str, mapping: list[dict]) -> object:
    if isinstance(value, (dict, list)) and key.strip().lower() not in _IMAGE_KEYS:
        return _templatize(value, path, mapping)
    var = _var_for(key, value)
    mapping.append({
        "path": path, "key": key,
        "sample": value if not isinstance(value, (dict, list)) else "…",
        "var": var or "",          # 空 = 固定值
    })
    return f"{{{{{var}}}}}" if var else value


def _auth_header(raw: str) -> str:
    """`Bearer sk-真key` → `Bearer {{api_key}}`。前缀原样保留 —— fal 用的是 `Key`,
    别家还有裸 key,这一段是各家真实的差异,不能规范化掉。"""
    parts = raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() in ("bearer", "key", "token", "basic"):
        return f"{parts[0]} {{{{api_key}}}}"
    return "{{api_key}}"


def curl_to_template(text: str) -> dict:
    """一段示例 curl → `{base_url, api_key, model, template, mapping, notes}`。

    `mapping` 是给界面用的: 每个请求体键被认成了什么, 用户能逐行改。**故意不追求猜全**
    —— 认不出来的键原样留在模板里当固定值, 那通常正是对的 (供应商的固定参数)。
    """
    cleaned = "\n".join(
        line for line in (text or "").splitlines()
        if not line.strip().startswith("#")          # 文档里常在 curl 上方写注释
    )
    parsed_url, headers, body_raw, form = _scan_tokens(_tokenize(cleaned))
    if not parsed_url:
        raise CurlParseError("没找到请求 URL")

    base_url, path = _split_endpoint(parsed_url)
    notes: list[str] = []
    out: dict = {"base_url": base_url}

    raw_auth = headers.get("authorization", "")
    key_value = raw_auth.split(None, 1)[-1] if raw_auth else headers.get("x-api-key", "")
    if key_value and not _FAKE_KEY_RE.match(key_value.strip()):
        out["api_key"] = key_value.strip()
    elif key_value:
        notes.append("示例里的 key 是个占位符, 没有导入 —— 填你自己的。")

    tpl_headers = {}
    for name, value in headers.items():
        if name == "authorization":
            tpl_headers["Authorization"] = _auth_header(value)
        elif name == "x-api-key":
            tpl_headers["x-api-key"] = "{{api_key}}"
        elif name == "content-type":
            tpl_headers["Content-Type"] = value
        else:
            tpl_headers[name] = value

    mapping: list[dict] = []
    body: object = None
    if body_raw:
        try:
            body = _templatize(json.loads(body_raw), "", mapping)
        except json.JSONDecodeError as exc:
            raise CurlParseError(f"请求体不是合法 JSON: {exc}") from exc
    elif form:
        notes.append("这段 curl 是 multipart (-F) 的, 模板通道目前只发 JSON。")

    for row in mapping:
        if row["key"].strip().lower() == "model" and isinstance(row["sample"], str):
            out["model"] = row["sample"]

    out["template"] = {
        "method": "POST",
        "url": f"{{{{base_url}}}}{path}",
        "headers": tpl_headers,
        "body": body if body is not None else {},
        # 响应那一半靠"跑一次看回包"填 —— 见 probe_result_path。这里刻意留空而不是瞎猜。
        "result_path": "",
    }
    out["mapping"] = mapping
    out["notes"] = notes
    return out


def poll_curl_to_section(text: str, *, task_id: str, base_url: str) -> dict:
    """查询任务的那段 curl + 刚拿到的真实 task_id → 模板的 `poll` 段。

    `task_id` 是关键: 用户粘的那段 curl 里是一个**具体的**任务 id (文档里的示例值,
    或者他自己刚跑出来的)。我们知道那个值, 所以能在 URL 里精确定位并换成 `{{task_id}}`
    —— 不用去猜"路径里哪一段是 id", 也就不会把 `/v1/` 之类误伤。
    """
    parsed_url, headers, _body, _form = _scan_tokens(_tokenize(
        "\n".join(line for line in (text or "").splitlines()
                  if not line.strip().startswith("#"))
    ))
    if not parsed_url:
        raise CurlParseError("没找到查询用的 URL")

    url = parsed_url
    if task_id and task_id in url:
        url = url.replace(task_id, "{{task_id}}")
    elif "{{task_id}}" not in url:
        raise CurlParseError(
            f"这段 curl 的地址里没有出现刚才那个任务 id ({task_id[:16]}…) —— "
            "把示例里的任务 id 换成刚跑出来的那个再粘一次, 或者直接写 {{task_id}}。"
        )
    if url.startswith(base_url):
        url = "{{base_url}}" + url[len(base_url):]

    poll_headers = {}
    for name, value in headers.items():
        if name == "authorization":
            poll_headers["Authorization"] = _auth_header(value)
        elif name == "x-api-key":
            poll_headers["x-api-key"] = "{{api_key}}"
        else:
            poll_headers[name] = value

    return {
        "method": "GET",
        "url": url,
        "headers": poll_headers,
        # 这三项由"真的轮一次"填 —— 状态字段在哪一层、完成时那个值叫什么, 都是看回包
        # 才知道的, 跟 result_path 同理。
        "status_path": "",
        "done": [],
        "failed": ["failed", "error", "cancelled"],
        "result_path": "",
    }
