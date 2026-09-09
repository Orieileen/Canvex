"""透明被压平到黑 → 还原。见 ImageChannel.flatten_repair 上那段实测记录。

这个函数是个**启发式**, 所以测试的重点不是"能修", 而是**三条判定各自的反例都不被误伤**:
有 alpha 的、内部的黑、面积不够的、以及"接近黑但不是全零"的, 一个都不许动。
"""
import io

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from studio.services.agent.tools.image import repair_flattened_alpha
from studio.services.image_channels import PRESETS, tunable_schema
from studio.models import ImageProvider


def _png(array: np.ndarray, mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array, mode).save(buf, "PNG")
    return buf.getvalue()


def _flattened_subject(size: int = 100, inner_black: bool = False) -> np.ndarray:
    """一张"透明底被压平到黑"的图: 四周纯黑, 中间一块白主体。

    `inner_black` 在主体**内部**再挖一块纯黑 —— 模拟产品上的黑 logo / 深色阴影。
    那块黑不连边界, 一个像素都不该被打成透明。
    """
    a = np.zeros((size, size, 3), dtype=np.uint8)
    a[30:70, 30:70] = 255
    if inner_black:
        a[45:55, 45:55] = 0
    return a


def _alpha_of(png_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(png_bytes))
    assert img.mode == "RGBA", img.mode
    return np.asarray(img)[:, :, 3]


class RepairFlattenedAlphaTests(SimpleTestCase):
    def test_flattened_background_becomes_transparent(self):
        out = repair_flattened_alpha(_png(_flattened_subject()))
        alpha = _alpha_of(out)

        self.assertEqual(alpha[0, 0], 0, "边角应还原成透明")
        self.assertEqual(alpha[50, 50], 255, "主体应保持不透明")

    def test_interior_black_is_not_punched_through(self):
        """主体里的黑 (logo / 阴影 / 黑色产品本身) 不连边界, 不该变成洞。

        这条是走连通域而不是"把所有纯黑设成透明"的**唯一**理由 —— 后者写起来短得多,
        而代价是每一张带黑色元素的产品图都会被打出窟窿, 且没有任何报错。
        """
        out = repair_flattened_alpha(_png(_flattened_subject(inner_black=True)))
        alpha = _alpha_of(out)

        self.assertEqual(alpha[0, 0], 0, "外面的黑还是背景")
        self.assertEqual(alpha[50, 50], 255, "主体内部那块黑必须留着")

    def test_image_that_already_has_alpha_is_returned_untouched(self):
        """有 alpha = 没被压平过。原样返回, 而且必须是**同一批字节** —— 重新编码一次
        PNG 是无谓的有损/无损转换风险, 也会让"没改过"这件事变得不可断言。"""
        rgba = np.dstack([_flattened_subject(), np.full((100, 100), 128, dtype=np.uint8)])
        original = _png(rgba, mode="RGBA")

        self.assertEqual(repair_flattened_alpha(original), original)

    def test_small_black_region_is_below_the_threshold(self):
        """只有一小条黑边 (2%) —— 不是压平的指纹, 不动。"""
        a = np.full((100, 100, 3), 255, dtype=np.uint8)
        a[:2, :] = 0
        original = _png(a)

        self.assertEqual(repair_flattened_alpha(original), original)

    def test_near_black_but_not_bit_exact_is_left_alone(self):
        """(1,1,1) 不是 (0,0,0)。

        判定的地基就是"比特级全零" —— 扩散模型画出来的黑背景一定带噪声, 而合成出来的
        不带。放宽到"接近黑"的话, 一张夜景图或者用户明说要的纯黑背景就会被掏空。
        """
        a = _flattened_subject()
        a[a.sum(axis=2) == 0] = 1
        original = _png(a)

        self.assertEqual(repair_flattened_alpha(original), original)

    def test_edge_band_is_unmatted_back_to_semi_transparent(self):
        """紧贴背景那一窄条要反解回半透明, 而不是当成"不透明的深灰"。

        不做这一步的结果是每条边镶一道黑边 —— 实测那张塑料杯, 半透明的盖子整个发灰。
        这里造一圈 50% 灰 (= 白色主体以 a=0.5 压到黑上), 修完应该回到"白色 + alpha≈128"。
        """
        a = _flattened_subject()
        a[30, 30:70] = 128  # 主体最上面那一行 = 过渡带

        out = repair_flattened_alpha(_png(a))
        img = np.asarray(Image.open(io.BytesIO(out)))

        self.assertAlmostEqual(int(img[30, 50, 3]), 128, delta=2, msg="alpha 应还原成约 0.5")
        self.assertGreater(int(img[30, 50, 0]), 240, "颜色应从灰提回白")

    def test_unreadable_bytes_pass_through(self):
        """认不出的字节原样放行 —— 这是补救步骤, 不该由它决定一次生成算不算失败。"""
        self.assertEqual(repair_flattened_alpha(b"not an image"), b"not an image")


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
