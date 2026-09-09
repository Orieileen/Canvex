"""透明被压平到黑 → 用 rembg 重新抠。见 ImageChannel.flatten_repair 上那段实测记录。

**判定和修复分开测**, 因为它们是两件事:

- `_looks_flattened` 是个启发式, 误判的代价是改坏一张本来正确的图。所以它的测试重点
  不是"能认出", 而是**每条判定的反例都不被误伤**。这部分用合成图, 纯确定性。
- `repair_flattened_alpha` 的职责只剩"判定命中才调 rembg"。rembg 是第三方神经网络,
  它在 100×100 的合成方块上表现如何跟这个改动无关 —— 所以 mock 掉, 只验闸门。
  真图上的效果靠人眼验, 不靠断言。
"""
import io
from unittest import mock

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from studio.services.agent.tools import image as image_tools
from studio.services.agent.tools.image import (
    _FLATTEN_MIN_BLACK_RATIO,
    _looks_flattened,
    repair_flattened_alpha,
)
from studio.services.image_channels import PRESETS, tunable_schema
from studio.models import ImageProvider


def _png(array: np.ndarray, mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array, mode).save(buf, "PNG")
    return buf.getvalue()


def _flattened_subject(size: int = 100) -> np.ndarray:
    """一张"透明底被压平到黑"的图: 四周纯黑, 中间一块白主体。"""
    a = np.zeros((size, size, 3), dtype=np.uint8)
    a[30:70, 30:70] = 255
    return a


def _detects(array: np.ndarray, mode: str = "RGB") -> bool:
    return _looks_flattened(_png(array, mode), _FLATTEN_MIN_BLACK_RATIO)


class LooksFlattenedTests(SimpleTestCase):
    """判定。**每条都是一个不该被碰的反例** —— 误判一次就是改坏一张正确的图。"""

    def test_detects_a_flattened_image(self):
        self.assertTrue(_detects(_flattened_subject()))

    def test_image_that_already_has_alpha_is_not_flattened(self):
        """有 alpha = 没被压平过, 一个字节都不该动。"""
        rgba = np.dstack([_flattened_subject(), np.full((100, 100), 128, dtype=np.uint8)])

        self.assertFalse(_detects(rgba, mode="RGBA"))

    def test_near_black_but_not_bit_exact_is_not_flattened(self):
        """(1,1,1) 不是 (0,0,0)。

        判定的地基就是"比特级全零" —— 扩散模型画出来的黑背景一定带噪声, 合成出来的不带。
        放宽到"接近黑"的话, 夜景图和用户明说要的纯黑背景都会被判成压平。
        """
        a = _flattened_subject()
        a[a.sum(axis=2) == 0] = 1

        self.assertFalse(_detects(a))

    def test_small_black_region_is_below_the_threshold(self):
        """只有一条 2% 的黑边 —— 不是压平的指纹。"""
        a = np.full((100, 100, 3), 255, dtype=np.uint8)
        a[:2, :] = 0

        self.assertFalse(_detects(a))

    def test_black_that_does_not_touch_the_border_is_not_background(self):
        """整张图正中一大块黑, 四边全是白 —— 那是画面内容, 不是被抠掉的背景。

        这条是走连通域而不是"数一数有多少黑像素"的**唯一**理由。
        """
        a = np.full((100, 100, 3), 255, dtype=np.uint8)
        a[20:80, 20:80] = 0  # 36% 纯黑, 但一条边都不碰

        self.assertFalse(_detects(a))

    def test_unreadable_bytes_are_not_flattened(self):
        """认不出的字节当成"不是" —— 这是个补救步骤, 不该由它决定一次生成算不算失败。"""
        self.assertFalse(_looks_flattened(b"not an image", _FLATTEN_MIN_BLACK_RATIO))


class RepairFlattenedAlphaTests(SimpleTestCase):
    """闸门。rembg 本身 mock 掉 —— 它是第三方神经网络, 不是这个改动的一部分。"""

    def test_calls_rembg_when_the_image_looks_flattened(self):
        with mock.patch.object(image_tools, "_rembg_offloaded", return_value=b"cut") as rembg:
            out = repair_flattened_alpha(_png(_flattened_subject()))

        rembg.assert_called_once()
        self.assertEqual(out, b"cut")

    def test_does_not_call_rembg_on_a_normal_image(self):
        """没命中判定时**一次都不能调** —— rembg 是 1.4 秒的 CPU, 每张图都跑一遍既慢,
        又会把没被压平的图重新抠一遍轮廓。"""
        normal = np.full((100, 100, 3), 255, dtype=np.uint8)

        with mock.patch.object(image_tools, "_rembg_offloaded") as rembg:
            out = repair_flattened_alpha(_png(normal))

        rembg.assert_not_called()
        self.assertEqual(out, _png(normal))

    def test_rembg_failure_returns_the_original_bytes(self):
        """修复失败不该让一次**成功的生成**变成失败: 用户拿到黑底图总比拿到报错好,
        而且他还能自己点一下「抠图」。"""
        original = _png(_flattened_subject())

        with mock.patch.object(image_tools, "_rembg_offloaded", side_effect=RuntimeError("boom")):
            self.assertEqual(repair_flattened_alpha(original), original)


class FlattenRepairWiringTests(SimpleTestCase):
    """旋钮接没接上去 —— 函数写对了但没人调用是这类改动最典型的失败方式。"""

    def _preset(self, key):
        return next(p for p in PRESETS if p.key == key)

    def test_gpt_image_2_ships_with_the_repair_on(self):
        overrides = self._preset("apimart_image").model_overrides
        self.assertIs(overrides["gpt-image-2"]["flatten_repair"], True)

    def test_models_without_the_defect_do_not_get_it(self):
        """实测 seedream 三次都是 0% 纯黑。没这个毛病的不该被顺手打开 —— 那样这一项就
        从"记录一条实测事实"退化成"给所有模型套一个启发式"。"""
        overrides = self._preset("apimart_image").model_overrides
        for model, over in overrides.items():
            if model != "gpt-image-2":
                self.assertNotIn("flatten_repair", over, model)

    def test_knob_reaches_the_custom_image_form(self):
        """表单由后端 schema 下发。不在 tunables 里 = 用户永远看不见、也关不掉。"""
        rows = tunable_schema()[ImageProvider.Kind.CUSTOM_IMAGE]["tunables"]
        row = next((r for r in rows if r["key"] == "flatten_repair"), None)

        self.assertIsNotNone(row, "flatten_repair 没有下发给 custom_image 表单")
        self.assertEqual(row["control"], "bool")
