"""请求模板:把「一次供应商调用长什么样」变成用户填的数据, 而不是我们写死的代码。

## 为什么需要它

生图没有统一的线上格式。源图的键各家叫法不同 (apimart `image_urls` / 兔子 `image`)、
有的同步出图有的提交完再轮询、尺寸有的是 `1024x1024` 有的是 `1:1`、认证有的 `Bearer`
有的 `Key`、模型名有的在请求体里有的在 URL 路径里。我们原来的做法是为每一处差异开一个
旋钮 (image_field / image_as_single / size_mode / poll_* …), 一共十四个 —— 而且端点
`/images/generations` 还是写死的, 所以 `/images/edits`、chat 格式生图、Midjourney 这些
形状根本够不着。

模板把这些差异**收敛成一件事**: 你把占位符写在哪、写成什么形状。七个旋钮因此消失,
端点也一起放开。

## 不是"全部由用户填"

App 必须往里塞提示词和源图, 也必须从回包里拿到图片。所以准确说法是 **请求的形状全部
你填, 变量表是固定的** —— 否则我们连"哪个键放的是提示词"都不知道。变量表由 kind 声明
(见 image_channels.KIND_SPECS), 存盘时校验, 填了不存在的变量当场报错而不是等到生成时。

## 替换规则

整个值就是一个占位符时**保留原类型**, 嵌在文字里时按字符串插值:

    {"n": "{{n}}"}              → {"n": 4}           (数字, 不是 "4")
    {"images": "{{images}}"}    → {"images": [...]}   (数组)
    {"prompt": "a photo of {{prompt}}"} → {"prompt": "a photo of 一只猫"}

**解析出来是空的就把这个键整个去掉**, 这一条替代了原来一堆 `if self.quality:` ——
供应商对"传了空字符串"和"没传"的反应经常不一样, 而模板里没法表达"这次别传这个键"。

    {"quality": "{{quality}}"}  且 quality 为空 → {}   (键消失)

数组里的占位符同理: 元素解析为空则删掉那个元素, 于是
`{"image_urls": ["{{image}}"]}` 在没有源图时得到 `{"image_urls": []}`。
"""
import re
from typing import Any

# `{{ var }}` —— 允许内部空格, 变量名限制成标识符, 免得把 JSON 里正常的花括号误伤。
_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
# 整个字符串**正好**是一个占位符 (前后可有空白) —— 这种才保留原类型。
_SOLE_PLACEHOLDER = re.compile(r"^\s*\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}\s*$")

# 取值路径: `data[0].url` / `data.0.url` 都认。分段时把 `[0]` 拆成独立一段。
_PATH_SEGMENT = re.compile(r"[^.\[\]]+")


class TemplateError(ValueError):
    """模板不合法 / 渲染不出来。message 直接给用户看。"""


def placeholders(node: Any) -> set[str]:
    """模板里用到的全部变量名。存盘时拿它跟 kind 声明的变量表比对。"""
    found: set[str] = set()
    _walk(node, found)
    return found


def _walk(node: Any, found: set[str]) -> None:
    if isinstance(node, str):
        found.update(_PLACEHOLDER.findall(node))
    elif isinstance(node, dict):
        for k, v in node.items():
            _walk(k, found)
            _walk(v, found)
    elif isinstance(node, (list, tuple)):
        for v in node:
            _walk(v, found)


def _is_empty(value: Any) -> bool:
    """什么算"没值" —— 决定这个键要不要整个去掉。

    `0` 和 `False` **不算空**: 它们是正经的取值 (n=0 没意义, 但 watermark=false 是这个
    项目里真正踩过的坑 —— 火山默认打水印, 必须显式下发 false, 当成空丢掉就等于没配)。

    **空列表 / 空字典算空**, 跟空串同一个道理: `{{images}}` 在文生图 / 文生视频时渲染成
    `[]`, 而 `"image_urls": []` 和"没有这个键"对供应商是两句不同的话 —— 有些家会据此
    判定任务类型 (apimart 的 seedance 就按"有没有参考素材"分文生 / 参考生 / 编辑)。
    空集合不携带任何信息, 却可能改变对方的行为, 所以按"没填"处理。
    """
    if isinstance(value, (list, tuple, dict)):
        return not value
    return value is None or (isinstance(value, str) and not value.strip())


def render(node: Any, variables: dict[str, Any]) -> Any:
    """按变量表渲染模板。空值的键 / 数组元素会被删掉, 见模块文档。"""
    if isinstance(node, str):
        sole = _SOLE_PLACEHOLDER.match(node)
        if sole:
            # 整串就是一个占位符 → 原样返回它的值, 保留类型
            return variables.get(sole.group(1))
        # 嵌在文字里 → 字符串插值; 未知/空变量按空串处理, 不留下 "{{x}}" 这种残留
        def sub(m: re.Match) -> str:
            v = variables.get(m.group(1))
            return "" if v is None else str(v)
        return _PLACEHOLDER.sub(sub, node)
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            key = render(k, variables) if isinstance(k, str) else k
            val = render(v, variables)
            if _is_empty(val):
                continue          # 见模块文档: 空值的键整个不下发
            out[str(key)] = val
        return out
    if isinstance(node, (list, tuple)):
        return [v for v in (render(x, variables) for x in node) if not _is_empty(v)]
    return node


def extract(payload: Any, path: str) -> Any:
    """按 `data[0].url` / `data.0.url` 这种路径取值。取不到抛 TemplateError。

    报错里带上**走到哪一步断的**和那一层实际有什么键 —— 供应商换个响应形状时, 这句话
    就是用户唯一能拿来改路径的线索。
    """
    # 先归一成字符串: 模板是用户手写的 JSON, `"result_path": 0` 这种完全可能出现, 而
    # 直接拿去 .strip() / findall 抛的是 AttributeError —— 它不是 TemplateError, 逃出
    # 调用方那层翻译, 变成一个跟模板毫无关系的 500 / celery traceback。
    path = str(path) if path is not None else ""
    if not path.strip():
        return payload
    node = payload
    walked: list[str] = []
    for seg in _PATH_SEGMENT.findall(path):
        if isinstance(node, dict):
            if seg not in node:
                raise TemplateError(
                    f"取结果路径 `{path}` 在 `{'.'.join(walked) or '(顶层)'}` 这一步断了: "
                    f"没有 `{seg}`, 这一层只有 {sorted(node)[:12]}"
                )
            node = node[seg]
        elif isinstance(node, list):
            try:
                node = node[int(seg)]
            except (ValueError, IndexError) as exc:
                raise TemplateError(
                    f"取结果路径 `{path}` 在 `{'.'.join(walked) or '(顶层)'}` 这一步断了: "
                    f"`{seg}` 不是这个长度 {len(node)} 的数组里的合法下标"
                ) from exc
        else:
            raise TemplateError(
                f"取结果路径 `{path}` 在 `{'.'.join(walked) or '(顶层)'}` 这一步断了: "
                f"那里是 {type(node).__name__}, 没法再往下取 `{seg}`"
            )
        walked.append(seg)
    return node


def validate(template: Any, allowed: set[str]) -> None:
    """存盘前的校验: 模板的形状 + 用到的变量。不合格抛 `TemplateError`。

    **形状规则住在这里, 不在序列化器里。** 这个模块定义了模板这个格式, 所以"什么样的
    模板算合法"就该由它回答 —— 放在 DRF 序列化器里意味着任何不走那条路的写入 (fixture、
    shell、管理命令、以后的批量导入) 都绕过全部检查, 只剩执行器里那几道更弱的兜底。

    在存盘时拦而不是等渲染时: 渲染发生在生成任务里, 那时报错落在 celery 日志中, 用户
    看到的只是"生成失败"。存盘时拦才能把"你写了 {{iamge}}"这句话放到他眼前。
    """
    if not isinstance(template, dict) or not template:
        raise TemplateError("这种通道要填请求模板 —— 先从起点模板里选一个, 再照供应商文档改。")

    unknown = sorted(placeholders(template) - allowed)
    if unknown:
        raise TemplateError(
            f"模板里用了这种通道没有的变量: {', '.join('{{%s}}' % u for u in unknown)}。"
            f"可用的有: {', '.join('{{%s}}' % a for a in sorted(allowed))}"
        )

    if not str(template.get("url") or "").strip():
        raise TemplateError("模板里缺 `url`。")

    poll = template.get("poll")
    if poll is None:
        return
    if not isinstance(poll, dict):
        raise TemplateError("`poll` 得是个对象。")
    # 这三条漏了之后的表现是同一种, 而且最误导: 轮询一直转到次数用完, 然后给一句
    # "轮询了 N 次还没完成" —— 那会把人引到调大次数上, 方向完全错。
    #
    # `status_path` 尤其要拦: 少了它, `extract` 会把**整个回包**当成状态串, 于是永远
    # 匹配不上 `done`, 表现跟没写 `done` 一模一样。
    if not (poll.get("done") or []):
        raise TemplateError("模板有 `poll` 段但没写 `done` —— 我们无法知道什么状态算完成了。")
    if not str(poll.get("status_path") or "").strip():
        raise TemplateError(
            "模板有 `poll` 段但没写 `status_path` —— 不知道去回包的哪一层读状态。"
        )
    if not str(poll.get("url") or "").strip():
        raise TemplateError("模板有 `poll` 段但没写 `url` —— 不知道去哪查任务状态。")
    if not str(template.get("task_id_path") or "").strip():
        raise TemplateError(
            "模板有 `poll` 段但没写 `task_id_path` —— 提交之后不知道去哪拿任务 id。"
        )
