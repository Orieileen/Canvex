"""通道报错 → 一句能照做的话。

「测试」按钮和卡片上那段红字回传的都是**供应商的原文** —— 那是对的, 用户拿着它对着文档
就能改, 不该被我们美化成一句"请求失败"。但原文不等于**能照做**: `401 Unauthorized`
和 `insufficient_user_quota` 说的是完全不同的两件事 (一个去改 key, 一个去充值), 而在这
两句话上分不清的人恰恰就是最需要这个按钮的人。

所以这里只做一件事: 从报错里认出**是哪一类**, 回一个 code。文案不在这儿 —— 前端按 code
翻译 (`imageProviders.diag.<code>`), 中英各一份。跟 agent/skill_md.py 的 SkillMdError 同
一套路: 后端判类型, 前端说人话。**刻意不在后端拼中文**, 那样英文界面上会冒出一句中文,
而且同一句话就有了两个来源。

认不出来就回空串 —— 那时界面上只有原文, 跟这个模块存在之前一模一样。**这是这里唯一
可以接受的失败方式**: 一句猜错的"多半是 X"比没有更糟, 它会让人去改一个本来没问题的字段。
所以下面每条规则都来自这个项目里真见过的报文, 不是想象出来的分类学。
"""
import logging
import re

logger = logging.getLogger(__name__)

# 报文里的 HTTP 状态码。三种写法都要认, 因为三条路径各自拼的:
#   内置生图  `HTTPError: 401 Unauthorized for https://…: {body}`  (image_client.generate)
#   模板      `TemplateRequestError: 提交 HTTP 400: {body}`        (template_client._request)
#   angle     `RuntimeError: angle submit HTTP 404: …`             (angle.submit_angle)
#
# **只在正文之前找**: 供应商的 JSON 正文里有 request id、时间戳、图片尺寸, 随便哪个都
# 可能撞出一个三位数。我们自己拼的那截框在第一个 `{` 之前, 那里才是可信的。
_STATUS_RE = re.compile(r"(?:^|[^0-9])(?:HTTP )?([45]\d{2})(?=[ :])")


def _status(text: str) -> int | None:
    head = text.split("{", 1)[0][:200]
    m = _STATUS_RE.search(head)
    return int(m.group(1)) if m else None


def _any(text: str, *needles: str) -> bool:
    return any(n in text for n in needles)


# 可灵那四个模型把画质叫 `mode`, 而且**是异步校验的** —— 提交那一下回 200 带 task_id,
# 任务立刻转 failed, 原话是 `mode value 'bogus' is invalid`。实测出来的: 只认 resolution
# 那几个词的话, 这条会落到最后的"供应商说请求有问题", 而那句提示指不出该改哪个字段。
#
# **必须是词边界, 不能用子串**: `"invalid mode" in "invalid model"` 是真的 —— 而这条规则
# 排在"模型名"前面, 所以纯子串匹配会把每一句 `invalid model` / `unsupported model` 都
# 判成"画质档不对", 把人送去改一个跟报错毫无关系的字段。这正是本模块顶上那句
# "一句猜错的'多半是 X'比没有更糟"说的情况。
_MODE_RE = re.compile(r"\b(?:invalid|unsupported)\s+mode\b|\bmode\s+value\b")


def diagnose(error: str, *, template: bool = False) -> str:
    """报错原文 → 诊断 code (认不出 = 空串)。

    `template` = 这是不是一条模板通道。只影响"端点不对"该让人去改哪儿: 内置通道的端点是
    `base_url` + 我们拼的后缀, 模板通道的端点整个写在模板的 `url` 里 —— 指错地方的提示
    比不提示更糟。

    规则从**最确定**排到最泛。顺序里有两处是刻意的, 都来自真实报文:

    - **欠费排在限流前面**: OpenAI 欠费回的是 429 + `insufficient_quota`, 按状态码判会
      说成"等一会儿再试", 而等多久都不会好。
    - **欠费排在鉴权前面**: 兔子额度用尽那句写的是"令牌额度已用尽", 里面有"令牌"二字,
      按 key 判会把人送去换一把没问题的 key。
    """
    if not error:
        return ""
    text = error.lower()
    status = _status(error)

    # ① 欠费 / 额度用尽 —— **不是配置问题**, 改哪个字段都没用。
    if status == 402 or _any(
        text,
        "insufficient_quota", "insufficient_user_quota", "exceeded your current quota",
        "余额不足", "额度已用尽", "额度不足", "欠费", "billing",
    ):
        return "quota"

    # ② 限流。
    if status == 429 or _any(text, "rate_limit", "rate limit", "too many requests", "请求过于频繁"):
        return "rate_limit"

    # ③ key 不对 / 没权限。
    if status in (401, 403) or _any(
        text,
        "invalid token", "invalid api key", "incorrect api key", "invalid_api_key",
        "unauthorized", "authentication", "无效的令牌", "令牌验证失败",
    ):
        return "auth"

    # ④ 聚合商"没有可用渠道" —— **必须排在 5xx 前面**。这一条是实测出来的:
    #    兔子(new-api 那一系)在模型名不存在时回的是 **503** +
    #    `{"code":"image_size_channel_not_available","message":"No channel is available
    #    for the requested image size tier 1"}`。按状态码判就成了"供应商自己挂了, 过会儿
    #    再试" —— 而等到天荒地老也不会好, 要改的是模型名。
    #
    #    单独一个 code 而不是并进 `model`: 这句话的准确含义是"这个请求路由不出去", 最常见
    #    是模型没开通, 但也可能是尺寸档不支持。文案要把两种都说到, 不能咬死是模型名。
    if _any(text, "no channel is available", "channel_not_available", "无可用渠道", "无可用的渠道"):
        return "no_channel"

    # ⑤ 比例不支持 —— **排在"模型名"前面**: 这类报文里往往同时出现模型名 (apimart 的原话
    #    是"unsupported image aspect ratio \"9:21\", gemini-3.1-flash-image-preview
    #    supported ratios: …"), 先判模型名会把人送去改一个完全正确的模型名。
    #
    #    实测出来的: 同一家的不同模型收的比例都不一样 —— apimart 的
    #    gemini-3.1-flash-image-preview 只收 15 种, 而 gpt-image-2 连 `999:998` 都收。
    #    所以这不是"选错了", 是"这条通道还没告诉我们它收哪几种"。而报文本身就把答案列出来了。
    if _any(
        text,
        "aspect ratio", "aspect_ratio", "unsupported image size", "invalid size",
        "比例不支持", "不支持的比例", "尺寸不支持",
    ):
        return "ratio"

    # ⑤b 画质档不支持 —— 跟比例同一类事、同一个理由排在"模型名"前面 (报文里常带模型名)。
    #
    #    单独一条而不是并进 ratio: 要改的字段不是同一个 ("收哪几种比例" vs "收哪几个画质
    #    档"), 而一句指错字段的提示比没有提示更费时间。apimart 的原话是
    #    `invalid_resolution`; 另有两条**跨字段**的约束 (MiniMax 的 1080p 只配得上最短的
    #    那一档时长) 也会落到这里 —— 那种只能靠原文, 所以提示语必须把原文指出来。
    if _any(
        text,
        "invalid_resolution", "invalid resolution", "unsupported resolution",
        "resolution is not supported", "分辨率不支持", "不支持的分辨率",
    ) or _MODE_RE.search(text):
        return "resolution"

    # ⑥ 模型名 —— 状态码没有专属的一种, 只能看正文, 所以也排在 4xx/5xx 前面。
    if _any(
        text,
        "model_not_found", "invalid model", "model not found", "unknown model",
        "does not exist or you do not have access", "模型不存在",
    ):
        return "model"

    # ⑦ 供应商自己挂了。**排在上面几条之后**, 见 ④。
    if status is not None and 500 <= status < 600:
        return "provider_down"

    # ⑧ 端点不存在。内置和模板要改的地方不是一处。
    if status == 404:
        return "endpoint_template" if template else "endpoint"

    # ── 网络三兄弟。**顺序在这里是有实质意义的**, 不是风格问题: urllib3 把 TLS 失败和
    #    读超时都包在 "Max retries exceeded …" 里再抛成 requests 的 ConnectionError,
    #    所以先判"连不上"会把这两种全吃掉, 用户拿到"检查 Base URL"而地址根本没问题。

    # ⑨ TLS —— 网络/代理的事, 不是配置。三兄弟里必须排最前, 理由见上。
    if _any(text, "sslerror", "ssl:", "certificate", "tlsv1", "handshake"):
        return "tls"

    # ⑩ 读超时 = 连上了但对方半天不回 → 这才是"把超时调大"。**连接**超时不算: 那是根本
    #    没连上, 调超时只会让人多等几秒再看到同一句话, 该去看地址和端口。
    if _any(text, "readtimeout", "read timed out") or (
        _any(text, "timeout", "timed out")
        and not _any(text, "connecttimeout", "connect timeout")
    ):
        return "timeout"

    # ⑪ 连不上 (含连接超时)。本机地址单独一条 —— 后端跑在容器里, `localhost` 指的是容器
    #    自己, 这是自部署时踩得最多的一个坑, 值得一句专门的话。
    if _any(
        text,
        "connectionerror", "apiconnectionerror", "connection refused", "connection error",
        "failed to establish a new connection", "nameresolutionerror", "getaddrinfo",
        "max retries exceeded", "connecttimeout", "connect timeout",
    ):
        local = _any(text, "localhost", "127.0.0.1", "0.0.0.0", "::1")
        return "unreachable_local" if local else "unreachable"

    # ⑫ 其它 4xx: 说不出是哪个字段, 但能说"答案就在上面那段原文里"。
    if status is not None and 400 <= status < 500:
        return "bad_request"

    return ""
