"""再播种一次 —— `image-prompt-sop` 的说明文字转中文, 并把提示词里那几处跟
`amazon-listing-pack-sop` 同源的毛病一并修掉 (`no logo` / `no shadow` / 手部负向词)。

跟 0030 **逐字相同的一段代码**, 只是又跑了一遍。这是有意的自包含 (理由见 0018:
迁移必须能在未来任何一个版本的代码上重放, 所以不 import 会变的应用代码)。

⚠️ **但这已经是第二次了。** 再有第三次改种子的需求, 就该把这段抽成一个
management command (`manage.py resync_builtin_skills`), 让"改了种子怎么生效"变成一条
运维命令而不是一条迁移 —— 重新播种本来就是个操作, 不是 schema 变更。到那时这两条
历史迁移原样留着, 不要回头去改它们。
"""
import re
import uuid
from pathlib import Path

import yaml
from django.db import migrations

_SKILLS_DIR = Path(__file__).resolve().parent.parent / "services" / "agent" / "skills"
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _seeds():
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
        # `enabled` 不动 —— 见 0030。
        row.description = description
        row.content = content
        row.source = "builtin"
        row.save(update_fields=["description", "content", "source"])


def _backward(apps, schema_editor):
    """不可逆, 空操作 —— 见 0030。"""


class Migration(migrations.Migration):

    dependencies = [("studio", "0030_reseed_builtin_skills")]

    operations = [migrations.RunPython(_forward, _backward)]
