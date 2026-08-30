"""模板渲染里那条"值为空就把键整个丢掉"的规则。

它是这个格式最容易出错的一处: 丢多了 = 用户显式配的东西没下发 (火山的 watermark=false),
丢少了 = 发出去一个供应商没料到的键。两种都不报错, 都要等到生成结果不对才发现。
"""
from django.test import SimpleTestCase

from studio.services.request_template import render


class DropEmptyKeysTests(SimpleTestCase):
    TPL = {"a": "{{x}}", "keep": "literal"}

    def _rendered(self, value):
        return render(self.TPL, {"x": value})

    def test_none_and_blank_string_are_dropped(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.assertNotIn("a", self._rendered(value))

    def test_zero_and_false_are_kept(self):
        """**这条踩过坑**: 火山默认打水印, 必须显式下发 `watermark: false` —— 当成空丢掉
        就等于没配, 而图上会多一个水印, 没有任何报错。"""
        self.assertEqual(self._rendered(0)["a"], 0)
        self.assertEqual(self._rendered(False)["a"], False)

    def test_empty_collections_are_dropped(self):
        """`{{images}}` 在文生图 / 文生视频时渲染成 `[]`。而 `"image_urls": []` 和
        "没有这个键"对供应商是两句不同的话 —— apimart 的 seedance 按"有没有参考素材"
        判定任务类型 (文生 / 参考生 / 编辑), 空数组可能把它推到另一条分支。"""
        for value in ([], (), {}):
            with self.subTest(value=value):
                self.assertNotIn("a", self._rendered(value))

    def test_non_empty_collections_are_kept(self):
        self.assertEqual(self._rendered(["https://x/a.png"])["a"], ["https://x/a.png"])

    def test_untouched_keys_survive(self):
        """只丢空的那一个, 别的原样。"""
        self.assertEqual(self._rendered(None)["keep"], "literal")
