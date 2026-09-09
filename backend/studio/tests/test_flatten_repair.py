"""透明被压平到黑 → 用 rembg 重新抠。见 ImageChannel.flatten_repair 上那段实测记录。

**判定和修复分开测**, 因为它们是两件事:

- `_looks_flattened` 是个启发式, 误判的代价是改坏一张本来正确的图。所以它的测试重点
  不是"能认出", 而是**每条判定的反例都不被误伤**。这部分用合成图, 纯确定性。
- `repair_flattened_alpha` 的职责只剩"判定命中才调 rembg"。rembg 是第三方神经网络,
  它在 100×100 的合成方块上表现如何跟这个改动无关 —— 所以 mock 掉, 只验闸门。
  真图上的效果靠人眼验, 不靠断言。
"""
import io
import json
from unittest import mock

import numpy as np
from django.db import IntegrityError, transaction
from django.test import SimpleTestCase, TestCase
from PIL import Image

from studio.services.agent.tools import image as image_tools
from studio.services.agent.tools.image import (
    _FLATTEN_MIN_BLACK_RATIO,
    _looks_flattened,
    repair_flattened_alpha,
)
from studio.models import AppSetting, ImageEditJob, Scene


def _png(array: np.ndarray, mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array, mode).save(buf, "PNG")
    return buf.getvalue()


def _flattened_subject(size: int = 100) -> np.ndarray:
    """一张"透明底被压平到黑"的图: 四周纯黑, 中间一块白主体。"""
    a = np.zeros((size, size, 3), dtype=np.uint8)
    a[30:70, 30:70] = 255
    return a


def _alpha_of(png_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(png_bytes))
    assert img.mode == "RGBA", img.mode
    return np.asarray(img)[:, :, 3]


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

    def test_calls_rembg_and_binarizes_its_soft_mask(self):
        """rembg 的输出要过一次二值化, **不是原样返回**。

        实测 u2net 给这类图的 mask 整片停在 240-254 而不是 255 (一张真实修复结果:
        alpha 0 占 72.4%、240-254 占 21.7%、255 只占 3.9%)。也就是整个主体带着 2-6% 的
        透明度 —— 贴白底看不出来 (白透白), 贴到深色画布上整个产品发暗发脏。
        这里造的正是那个形状: 主体 alpha=250, 修完必须是 255。
        """
        cut = np.dstack([
            _flattened_subject(),
            np.where(_flattened_subject()[:, :, 0] > 0, 250, 0).astype(np.uint8),
        ])
        with mock.patch.object(
            image_tools, "_rembg_offloaded", return_value=_png(cut, mode="RGBA"),
        ) as rembg:
            out = repair_flattened_alpha(_png(_flattened_subject()))

        rembg.assert_called_once()
        alpha = _alpha_of(out)
        self.assertEqual(alpha[50, 50], 255, "主体那 250 要被推到全不透明")
        self.assertEqual(alpha[0, 0], 0, "背景仍然是透明")

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


class FlattenRepairWiringTests(TestCase):
    """接线。函数写对了但没人调用, 是这类改动最典型的失败方式。"""

    def test_default_is_on(self):
        """**默认必须是开的。**

        这个毛病的表现 (拿一张白底产品图去编辑, 回来是黑底) 对用户来说完全没有线索指向
        "某个开关没打开" —— 他只会以为模型坏了。默认关等于这个功能对绝大多数人不存在。
        """
        self.assertTrue(AppSetting.load().flatten_repair)

    def test_singleton_refuses_a_second_row(self):
        """单行表, 而且**凭空造一个实例存下去会响亮地失败**。

        它不静默合并是有意的: 那样的实例没读过的字段都是字段默认值, 存下去等于把用户
        改过的其余所有设置悄悄重置回默认。取实例只有 `load()` 一条路。
        """
        AppSetting.load()

        with self.assertRaises(IntegrityError), transaction.atomic():
            AppSetting(flatten_repair=False).save()

        self.assertEqual(AppSetting.objects.count(), 1)
        self.assertTrue(AppSetting.load().flatten_repair)

    def _run_generate(self):
        """跑一遍 `_generate_and_persist`, 把出网和落盘都挡掉, 只看修复调没调。"""
        scene = Scene.objects.create(title="t")
        job = ImageEditJob.objects.create(scene=scene, prompt="p", num_images=1)
        with (
            mock.patch.object(image_tools, "_generate_on_channel", return_value=[b"raw"]),
            mock.patch.object(image_tools, "_persist_results", return_value=[]) as persist,
            mock.patch.object(
                image_tools, "repair_flattened_alpha", return_value=b"fixed",
            ) as repair,
        ):
            image_tools._generate_and_persist(job)
        return repair, persist

    def test_repair_runs_when_the_setting_is_on(self):
        AppSetting.objects.update_or_create(pk=1, defaults={"flatten_repair": True})

        repair, persist = self._run_generate()

        repair.assert_called_once_with(b"raw")
        self.assertEqual(persist.call_args.args[1], [b"fixed"])

    def test_repair_is_skipped_when_the_setting_is_off(self):
        """关掉之后**一次都不能调** —— 关掉的用户要的是"供应商给什么我拿什么"。"""
        AppSetting.objects.update_or_create(pk=1, defaults={"flatten_repair": False})

        repair, persist = self._run_generate()

        repair.assert_not_called()
        self.assertEqual(persist.call_args.args[1], [b"raw"])


class AppSettingApiTests(TestCase):
    URL = "/api/v1/canvas/settings/"

    def test_get_creates_the_row_on_first_call(self):
        """前端因此永远不用处理"还没有设置"这个状态。"""
        AppSetting.objects.all().delete()

        resp = self.client.get(self.URL)

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"flatten_repair": True})

    def test_patch_round_trips(self):
        resp = self.client.patch(
            self.URL, data=json.dumps({"flatten_repair": False}),
            content_type="application/json",
        )

        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["flatten_repair"])
        self.assertFalse(AppSetting.load().flatten_repair)
