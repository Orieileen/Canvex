"""SKILL.md 正文的解析与准入校验。纯函数 —— 不碰 DB, 不碰 store, 不碰 HTTP。

## 谁说了算

**准入的最终裁决权在 deepagents 的 `_parse_skill_metadata` 手里。** 这里做的所有前置
检查, 只是为了把它的失败翻译成人话 —— 它失败时只 `logger.warning` 一行然后返回 None,
用户那边看到的会是"保存失败", 没有任何可行动的信息。

顺序因此是: 先跑我们自己的检查给出具体报错, **最后仍然让它拍板**。反过来 (自己判完就
放行) 就是把它的规则手抄了一份 —— 抄的那份会抢先生效, 升级 deepagents 之后我们收下的
和 agent 认的就对不上了, 而且没有任何报错。这个坑通道配置那边踩过一次 (前端硬编码
kind 规则、后端改了等于没改), 不再踩第二次。

## 两处我们**故意比 deepagents 严**

deepagents 对这两种情况只是 warning + 继续加载, 我们直接拒:

1. **name 不合规范** (大写 / 下划线 / 首尾连字符)。因为 name 同时是 store 的 key 和
   agent `read_file("/skills/<name>/SKILL.md")` 里的那一段路径。放行 `Image-Prompt`
   意味着它和 `image-prompt` 会变成两个独立的 skill, 而用户看到的是"我明明装过了"。
2. **description 超过 1024 字**。deepagents 会**静默截断**。description 是
   progressive disclosure 的唯一依据 —— agent 就是靠它决定要不要把整篇 SOP 读进来。
   截掉一半而不告诉任何人, 表现是"这个 skill 有时候不触发", 排查起来毫无线索。

## 大小上限为什么是 256KB 而不是 deepagents 的 10MB

SKILL.md 是 agent 按需 `read_file` **整篇读进上下文**的。10MB 一篇塞进去会直接撑爆
上下文窗口, 而报错发生在 LLM 那一层, 归因极难。现有两篇是 6.5KB / 16.6KB。
"""
import re

import yaml
from deepagents.middleware.skills import (
    MAX_SKILL_DESCRIPTION_LENGTH,
    _parse_skill_metadata,
    _validate_skill_name,
)

# 见模块文档。按 UTF-8 字节数算 —— 中文 SOP 的字符数会比字节数小三倍, 卡字符数等于
# 对中文放宽三倍, 而撑爆上下文的是 token 不是字符。
MAX_CONTENT_BYTES = 256 * 1024

# 跟 deepagents 同一个式子 (skills.py `frontmatter_pattern`)。这里只用来判"有没有",
# 具体解析仍然交给它 —— 两边的正则如果哪天分叉, 分叉的表现是我们说有、它说没有,
# 那时报错会落到最后那道 generic 门上, 而不是悄悄放行。
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


class SkillMdError(ValueError):
    """SKILL.md 不合格。

    **带 `code` + `params`, 不是只带一句话。** 这里产出的东西会被原样 toast 到技能库
    面板上, 而那个面板每个字都有中英两份 —— 报错写死一种语言, 等于在一个 README 有英文
    版、卖点就是"装你自己的 SOP"的功能上, 让看不懂那种语言的人对着一句天书。完整的解释
    住在 `frontend/src/i18n/canvas/skills.ts` 的 `errors.*` 里, 按 code 查表。

    `str(exc)` 仍然是一句能读的英文: curl、日志、别的调用方拿到的是它, 不能只给一个裸
    code。但它是**开发者视角**的一句话, 不承担"跟用户解释清楚为什么"的职责 —— 那句话
    在 i18n 里, 因为那才是用户会读到的地方。
    """

    def __init__(self, code: str, message: str, **params: object) -> None:
        super().__init__(message)
        self.code = code
        self.params = params


def _normalize(raw: str) -> str:
    """去掉 BOM、统一换行。`parse_skill_md` 自己会调, 外面不用管。

    BOM: Windows 上另存的 .md 常带 `\\ufeff` 开头, 于是 `^---` 匹配不上, 用户收到的
    是"没找到 frontmatter" —— 而他明明看见文件第一行就是 `---`。这是上传路径上最容易
    撞的一个坑, 也是最难自己看出来的。

    CRLF: yaml 本身能处理, 但存进库之后会原样回到编辑框, 再存一次又是一样的内容却和
    别处的 LF 版本 diff 不掉。统一成 LF, 编辑框里的往返就是稳定的。
    """
    return raw.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")


def parse_skill_md(raw: str) -> tuple[str, str, str]:
    """校验一篇 SKILL.md, 返回 `(要存的正文, name, description)`。

    **一个入口, 归一化在里面做。** 以前这是 `normalize()` + `parse_skill_md()` 两步,
    契约("入参必须先 normalize 过")只写在 docstring 里 —— 漏掉第一步的人会撞上这个模块
    专门为之存在的那个坑: 带 BOM 的文件被报成"没有 frontmatter", 而他明明看见第一行就是
    `---`。类型签名管不住的前提条件, 迟早有人不满足。

    不合格一律抛 `SkillMdError`, message 是给用户看的中文说明。
    """
    content = _normalize(raw)
    if not content.strip():
        raise SkillMdError("empty", "SKILL.md is empty.")

    size = len(content.encode("utf-8"))
    if size > MAX_CONTENT_BYTES:
        raise SkillMdError(
            "too_big",
            f"SKILL.md is {size // 1024} KB, over the {MAX_CONTENT_BYTES // 1024} KB limit.",
            size_kb=size // 1024,
            limit_kb=MAX_CONTENT_BYTES // 1024,
        )

    match = _FRONTMATTER_RE.match(content)
    if not match:
        raise SkillMdError("no_frontmatter", "No YAML frontmatter at the top of the file.")

    try:
        front = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise SkillMdError(
            # 参数**不能叫 `detail`**: 前端的 parseApiErrors 把 `detail` 当成 DRF 的顶层
            # 错误键, 专门把它排除在 fields 之外, 于是 i18n 插值时取不到, 用户看到的是
            # 一句原样的 `{detail}`。(踩过。)
            "yaml_error", f"Invalid YAML in frontmatter: {exc}", reason=str(exc),
        ) from exc

    if not isinstance(front, dict):
        raise SkillMdError(
            "frontmatter_not_mapping", "Frontmatter is not a `key: value` mapping.",
        )

    name = str(front.get("name", "") or "").strip()
    if not name:
        raise SkillMdError("name_missing", "Frontmatter is missing `name`.")
    # 第二个参数传 name 自己: 规范要求 name == 所在目录名, 而我们的目录名就是拿 name
    # 生成的 (`/{name}/SKILL.md`), 那一条天然成立。这里真正要的是它的字符集/长度检查。
    ok, err = _validate_skill_name(name, name)
    if not ok:
        raise SkillMdError(
            "name_invalid", f"Invalid `name` {name!r}: {err}", name=name, reason=err,
        )

    description = str(front.get("description", "") or "").strip()
    if not description:
        raise SkillMdError("description_missing", "Frontmatter is missing `description`.")
    if len(description) > MAX_SKILL_DESCRIPTION_LENGTH:
        raise SkillMdError(
            "description_too_long",
            f"`description` is {len(description)} chars, over the "
            f"{MAX_SKILL_DESCRIPTION_LENGTH} limit.",
            length=len(description),
            limit=MAX_SKILL_DESCRIPTION_LENGTH,
        )

    # 最后一道门, 见模块文档: 我们上面判过的它都判, 但它还判了别的 (metadata 结构、
    # allowed-tools 形状…), 而且将来还会加。它说不行就是不行。
    if _parse_skill_metadata(content, f"/{name}/SKILL.md", name) is None:
        raise SkillMdError(
            "rejected_by_deepagents", "deepagents could not parse this SKILL.md.",
        )

    return content, name, description
