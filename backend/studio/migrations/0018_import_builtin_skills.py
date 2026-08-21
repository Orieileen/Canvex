"""把磁盘上 `services/agent/skills/` 里的 SKILL.md 导进 Skill 表, 只导一次。

这次改造之后, **库是 skill 的唯一真相** —— 运行时的 seed 只读库, 不再 walk 磁盘。
但那个目录不能删: 它是出厂种子, 全新部署 migrate 完就该有两条能用的 SOP, 而不是一个
空面板。以后再想加内置 skill, 就是"往那个目录放一份 + 写一条这样的迁移"。

自包含 —— 不 import `builder` 也不 import deepagents:
- builder 会一路拉进 langchain / langgraph, 让 migrate 变慢而且多一堆失败面;
- 迁移必须能在**未来任何一个版本**的代码上重放, 而那两个模块随时会改。

因此路径和 frontmatter 解析都在这里重写一份。这跟"别手抄规则"不矛盾: 抄一份规则
是因为两份会**同时生效**并分叉; 迁移只在这一刻跑一次, 跑完这段代码就是历史了。
"""
import re
import uuid
from pathlib import Path

import yaml
from django.db import migrations

# backend/studio/migrations/ → backend/studio/services/agent/skills/
_SKILLS_DIR = Path(__file__).resolve().parent.parent / "services" / "agent" / "skills"
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def import_builtin_skills(apps, schema_editor):
    Skill = apps.get_model("studio", "Skill")
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
        if not name or not description:
            continue
        # get_or_create 而不是 create: 这条迁移之后如果有人 rollback 再 migrate, 或者
        # 用户已经手动装了同名的 skill, 都不该炸在 unique 约束上, 更不该覆盖用户的版本。
        Skill.objects.get_or_create(
            name=name,
            defaults={
                "id": uuid.uuid4(),
                "description": description,
                "content": content,
                "source": "builtin",
                "enabled": True,
            },
        )


def drop_builtin_skills(apps, schema_editor):
    """回滚只删 source=builtin —— 用户自己传的不能跟着一起没。"""
    apps.get_model("studio", "Skill").objects.filter(source="builtin").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0017_skill"),
    ]

    operations = [
        migrations.RunPython(import_builtin_skills, drop_builtin_skills),
    ]
