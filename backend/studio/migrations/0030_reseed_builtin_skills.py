"""把磁盘上的内置 SKILL.md 重新播种一遍 —— 内容更新 + 被删掉的补回来。

0018 用 `get_or_create` 把种子导进库, 之后**库是唯一真相**。那条规矩对"用户改了什么"
是对的, 但它留下了一个洞: **改了种子文件没有任何办法让它生效**。这条迁移就是那个办法。

触发它的是两件事凑在一起:
- `amazon-listing-pack-sop` 的七段提示词修了几个真 bug (最要紧的是 `no logo` ——
  它会让模型把卖家产品上自己的品牌抹掉);
- 内置技能刚刚变成可以删除的了, 于是"删掉之后怎么装回来"从一个不存在的问题变成了
  一个真实的问题。

**跟 0018 的区别是 upsert 而不是 get_or_create**, 也就是同名的行会被种子覆盖、并且
扳回 `source=builtin`。这看起来危险, 其实是这两个名字本来的语义: 序列化器里的
`builtin_name_taken` 一直禁止用户创建跟内置同名的技能 —— 所以一条 `source=user` 的
同名行只可能来自"先把内置删了, 再把它自己装回去", 而那正是要被扳回来的状态。
真想改内置的内容, 面板上有「复制为我的」, 复制出来的是另一个名字。

走目录而不是写死两个名字: 跟 0018 同一个形状, 以后加内置技能仍然是"往那个目录放一份
+ 写一条这样的迁移"。同样自包含, 不 import builder / deepagents (理由见 0018)。
"""
import re
import uuid
from pathlib import Path

import yaml
from django.db import migrations

_SKILLS_DIR = Path(__file__).resolve().parent.parent / "services" / "agent" / "skills"
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _seeds():
    """磁盘上每份种子 → (name, description, content)。解析不了的跳过, 不炸迁移。"""
    if not _SKILLS_DIR.is_dir():
        return
    for skill_md in sorted(_SKILLS_DIR.glob("*/SKILL.md")):
        try:
            content = skill_md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        match = _FRONTMATTER_RE.match(content)
        if not match:
            continue
        try:
            front = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            continue
        if not isinstance(front, dict):
            continue
        name = str(front.get("name", "") or "").strip()
        description = str(front.get("description", "") or "").strip()
        if name and description:
            yield name, description, content


def _forward(apps, schema_editor):
    Skill = apps.get_model("studio", "Skill")
    for name, description, content in _seeds():
        row = Skill.objects.filter(name=name).first()
        if row is None:
            Skill.objects.create(
                id=uuid.uuid4(), name=name, description=description,
                content=content, source="builtin", enabled=True,
            )
            continue
        # `enabled` 不动 —— 用户停用过就让它保持停用, 重新播种是"内容跟上", 不是
        # "把开关也一起重置"。
        row.description = description
        row.content = content
        row.source = "builtin"
        row.save(update_fields=["description", "content", "source"])


def _backward(apps, schema_editor):
    """不可逆。

    回滚只能回到"某个旧版本的种子", 而那份文件已经不在磁盘上了 —— 硬要写的话只能把
    内置行删掉, 那比留着新内容更糟。空操作, 让 migrate 能倒回去而不丢数据。
    """


class Migration(migrations.Migration):

    dependencies = [("studio", "0029_app_settings")]

    operations = [migrations.RunPython(_forward, _backward)]
