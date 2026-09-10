"""技能库的删除规则。

**内置技能可以删, 但正文只读** —— 这两条看起来矛盾, 其实回答的是两个不同的问题:

- 改坏了怎么办? 出厂那份在镜像的 `services/agent/skills/` 下, docker 部署的用户根本
  够不着, 所以**编辑**没有回退路径 —— 挡住。
- 删掉之后怎么办? 那是个干净的、用户明确知道自己在做什么的动作, 而且只有全新数据库
  才会由迁移 0018 重新播种 (迁移只跑一次, `resync_skills` 纯从库里推导, 不 walk 磁盘)。
  所以**删除**放行。
"""
from django.test import TestCase

from studio.models import Skill

_MD = """---
name: {name}
description: A skill used by the tests.
---

Body.
"""


class BuiltinSkillDeletionTests(TestCase):
    URL = "/api/v1/canvas/skill-library/"

    def setUp(self):
        self.builtin = Skill.objects.create(
            name="demo-builtin", description="d", content=_MD.format(name="demo-builtin"),
            source=Skill.Source.BUILTIN,
        )

    def test_builtin_can_be_deleted(self):
        """演示"从空技能库开始装"要靠它 —— 而挡着它的那条理由 (重建容器又会回来)
        本来就不成立。"""
        resp = self.client.delete(f"{self.URL}{self.builtin.id}/")

        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Skill.objects.filter(pk=self.builtin.pk).exists())

    def test_builtin_content_is_still_read_only(self):
        """删得了 ≠ 改得了。改坏了没有回退路径, 所以编辑仍然挡着。"""
        resp = self.client.patch(
            f"{self.URL}{self.builtin.id}/",
            data={"content": _MD.format(name="demo-builtin").replace("Body.", "Hacked.")},
            content_type="application/json",
        )

        self.assertEqual(resp.status_code, 400)
        # DRF 把每个字段包成 list, code 也不例外。
        self.assertEqual(resp.json()["code"], ["builtin_readonly"])
        self.builtin.refresh_from_db()
        self.assertIn("Body.", self.builtin.content)

    def test_user_skill_can_still_be_deleted(self):
        """回归: 放开内置那条路的时候别把自装的删除弄丢了。"""
        mine = Skill.objects.create(
            name="mine", description="d", content=_MD.format(name="mine"),
            source=Skill.Source.USER,
        )

        resp = self.client.delete(f"{self.URL}{mine.id}/")

        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Skill.objects.filter(pk=mine.pk).exists())
