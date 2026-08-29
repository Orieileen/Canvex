"""供应商文档里的示例 curl → 一份请求模板。

**curl 本身就是一个请求**, 所以这条路是直的: 把它拆成 url / headers / body, 再决定哪些
值该换成占位符。没有"这个差异对应哪个开关"那层翻译。

这里原来还有另一套 `parse_curl`, 把 curl 猜成**内置通道的那十四个旋钮**。它删掉了 ——
文档会写「`image` 传 URL 数组」, 但不会告诉你 `image_as_single` 该开还是关, 那层翻译
本来就是用户卡住的地方; 而且它**从不验证**, 猜完直接把人扔进十四个输入框。向导这条路
猜完会真跑一次, 把结果路径和"这家是不是异步"都问出来 —— 同样是"粘一段 curl", 一条通
到底、一条通到一半, 界面上并排放两个入口只是让人选错。
"""
import json
import logging
import re
import shlex
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)

# 端点那一段: `/<组>/<动作>` 或裸 `/generations`。各家常见的都在这:
#   images/generations  images/edits  videos/generations  chat/completions
#
# 为什么要把它从 URL 上切下来: 模板里的地址写成 `{{base_url}}/images/generations`,
# 而**同一个 `base_url` 还要拼查询任务那一段** (`{{base_url}}/tasks/{{task_id}}`)。
# 不切的话 base_url 就是整条提交地址, 第二段没法拼。路径本身**留在模板里** (端点是用户
# 自己写的 —— 这正是模板通道能够到 /images/edits、chat 格式生图、Midjourney 的原因)。
#
# 只剥这一段, 不连版本前缀一起剥: `/v1/images/generations` 的根是 `…/v1`, 不是裸域名。
_GENERATION_PATH_RE = re.compile(
    r"/(?:(?:images|videos|chat)/[\w.-]+|generations?)/?$", re.I,
)


class CurlParseError(ValueError):
    """curl 文本无法解析 —— 消息直接给用户看, 所以要说人话。"""


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
    """完整 URL → (base_url, 剩下的路径)。两半都要留着 —— 见 `_GENERATION_PATH_RE`。

    认不出端点那一段时整条 URL 就是 base_url, 路径回 `/`。那不是错 —— fal.run 那种
    "模型名即路径"的形状本来就没有可切的端点段, 而模板里 `{{base_url}}/{{model}}` 正好
    是对的。
    """
    parts = urlparse(url)
    raw_path = parts.path or ""
    path = _GENERATION_PATH_RE.sub("", raw_path)
    base = urlunparse((parts.scheme, parts.netloc, path.rstrip("/"), "", "", ""))
    return base, (url[len(base):] if url.startswith(base) else "") or "/"


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


# 文档里"任务 id 放这儿"的常见写法。**只在路径和查询串里找**, 不碰 scheme 和主机名 ——
# `https:` 和 `:8080` 都长得像占位符。
#
# 存在的理由: 文档给的查询 curl 几乎不会带一个真实 id, 而是 `/v1/tasks/<task_id>`。
# 不认这个的话, 用户得手工把刚跑出来的那串 id 抄进去再粘一次 —— 而向导手上就有那个 id。
# 这正是"少一步手工翻译"该省掉的地方。
_TASK_PLACEHOLDER_RE = re.compile(
    r"<[^<>/]{1,40}>"              # <task_id> / <id> / <YOUR TASK ID>
    r"|\{[^{}/]{1,40}\}"           # {task_id} / {id}
    r"|\[[^\[\]/]{1,40}\]"          # [task_id]
    r"|:[A-Za-z_][\w-]{0,39}"      # :task_id  (Rails 风格)
    r"|\$\{?[A-Z_][A-Z0-9_]{0,39}\}?"  # $TASK_ID / ${TASK_ID}
    r"|\b[A-Z][A-Z0-9_]{3,39}\b"   # YOUR_TASK_ID / TASK_ID
)


def _fill_task_id(url: str, task_id: str) -> str:
    """把查询地址里"任务 id 那一段"换成 `{{task_id}}`, 换不了就抛。

    三条路, 按可信度从高到低:
      1. 地址里出现了**刚跑出来的那个真实 id** —— 精确定位, 不可能误伤;
      2. 用户已经自己写了 `{{task_id}}` —— 什么都不用做;
      3. 地址里有一个占位符写法 (`<task_id>` 这类) —— 文档里的示例几乎都是这样。

    第 3 条只在**路径和查询串**里找。整条 URL 一起找的话 `https:` 会被 `:xxx` 那条命中,
    把协议头换掉。
    """
    if task_id and task_id in url:
        return url.replace(task_id, "{{task_id}}")
    if "{{task_id}}" in url:
        return url
    head, sep, tail = url.partition("://")
    host, slash, rest = (tail.partition("/") if sep else ("", "", url))
    if slash:
        replaced, n = _TASK_PLACEHOLDER_RE.subn("{{task_id}}", slash + rest, count=1)
        if n:
            return f"{head}{sep}{host}{replaced}"
    raise CurlParseError(
        f"这段 curl 的地址里认不出任务 id 该放哪儿。它可以是刚跑出来的那个 id "
        f"({task_id[:16]}…), 也可以是文档里的占位写法 (<task_id> / {{task_id}} / :task_id), "
        f"或者直接写 {{{{task_id}}}}。"
    )


def poll_curl_to_section(text: str, *, task_id: str, base_url: str) -> dict:
    """查询任务的那段 curl + 刚拿到的真实 task_id → 模板的 `poll` 段。

    任务 id 在地址里怎么定位见 `_fill_task_id`。
    """
    parsed_url, headers, _body, _form = _scan_tokens(_tokenize(
        "\n".join(line for line in (text or "").splitlines()
                  if not line.strip().startswith("#"))
    ))
    if not parsed_url:
        raise CurlParseError("没找到查询用的 URL")

    url = _fill_task_id(parsed_url, task_id)
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
