"""预设表自己的一致性。

**为什么值得一个测试**: `_APIMART_VIDEO_RESOLUTIONS` / `_APIMART_VIDEO_DURATIONS` 是两张
按模型字符串索引的表, 而模型清单在另一处 (`_Preset.models`)。写错一个字的表现是**那个
模型静默地没有旋钮** —— 界面上少一个下拉、请求里少一个键, 没有任何报错, 而且要生成一次
才看得出来。同一类错误在这条分支上已经犯过一次 (`grok-imagine-video-1.5` ←→
`grok-imagine-1.5-video-apimart`)。
"""
import dataclasses

from django.test import SimpleTestCase

from studio.services.image_channels import (
    _APIMART_IMAGE_RATIOS,
    _APIMART_VIDEO_DURATIONS,
    _APIMART_VIDEO_MODE_MODELS,
    _APIMART_VIDEO_RESOLUTIONS,
    KIND_SPECS,
    PRESETS,
)
from studio.services.image_client import (
    ImageChannel,
    parse_durations,
    parse_resolution_map,
)
from studio.services.request_template import placeholders, render


def _preset(key):
    return next(p for p in PRESETS if p.key == key)


def _channel(preset, model):
    """预设 + 模型 → 合并好的通道, 跟 channel_for_model 同一个叠放顺序 (kind 默认 →
    provider.defaults → model.overrides), 只是不落库。"""
    return ImageChannel(
        base_url=preset.base_url, api_key="k", model=model, kind=preset.kind,
        request_template=preset.request_template,
        **{
            **KIND_SPECS[preset.kind].defaults,
            **preset.defaults,
            **preset.model_overrides.get(model, {}),
        },
    )


class ApimartVideoPresetTests(SimpleTestCase):
    def setUp(self):
        self.preset = _preset("apimart_video")

    def test_every_model_declares_its_resolutions(self):
        """一行都不能少 —— 缺一行 = 那个模型没有画质旋钮 = 按供应商默认(常是最贵那档)
        出片, 而界面上看不出来。"""
        self.assertEqual(set(_APIMART_VIDEO_RESOLUTIONS), set(self.preset.models))

    def test_duration_table_only_names_real_models(self):
        """时长表是**部分**的 (跟画布那三档一致的留空), 但不能出现清单外的模型名。"""
        self.assertLessEqual(set(_APIMART_VIDEO_DURATIONS), set(self.preset.models))

    def test_mode_models_are_real_and_use_mode(self):
        self.assertLessEqual(set(_APIMART_VIDEO_MODE_MODELS), set(self.preset.models))
        for model in _APIMART_VIDEO_MODE_MODELS:
            with self.subTest(model=model):
                self.assertEqual(_channel(self.preset, model).resolution_param, "mode")

    def test_kling_3_0_turbo_is_not_a_mode_model(self):
        """可灵一族里唯一的例外 —— 它的文档写的是 `resolution`。归错的表现是发一个
        供应商不认识的键。"""
        self.assertEqual(_channel(self.preset, "kling-3.0-turbo").resolution_param, "resolution")

    def test_template_carries_both_quality_keys(self):
        names = placeholders(self.preset.request_template)
        self.assertIn("resolution", names)
        self.assertIn("mode", names)

    def test_only_one_quality_key_is_actually_sent(self):
        """两个占位符都在模板里, 但每次只有一个渲染出值 —— 另一个是空串, 那个键整个
        消失。否则可灵会收到一个它不认识的 `resolution`。"""
        from studio.services import template_client

        for model in self.preset.models:
            with self.subTest(model=model):
                channel = _channel(self.preset, model)
                variables = template_client.video_variables(
                    channel, prompt="p", image_urls=[], duration=5,
                    aspect_ratio="16:9", resolution="1080p",
                )
                body = render(self.preset.request_template["body"], variables)
                sent = [k for k in ("resolution", "mode") if k in body]
                self.assertEqual(sent, [channel.resolution_param])
                # 而且发出去的值一定是这个模型自己报过的
                tiers = parse_resolution_map(channel.allowed_resolutions)
                self.assertIn(body[sent[0]], tiers.values())

    def test_declared_durations_are_what_gets_sent(self):
        """模型报了几档就只能发出这几档 —— 画布的 5/10/15 在 veo3 / sora 上一个都不在
        列表里, 这条测的就是那条兜底真的兜住了。"""
        from studio.services import template_client

        for model, raw in _APIMART_VIDEO_DURATIONS.items():
            allowed = parse_durations(raw)
            for want in (5, 10, 15):
                with self.subTest(model=model, want=want):
                    variables = template_client.video_variables(
                        _channel(self.preset, model), prompt="p", image_urls=[],
                        duration=want, aspect_ratio="16:9",
                    )
                    self.assertIn(variables["duration"], allowed)

    def test_no_tier_picked_sends_no_key(self):
        """没选画质 = 两个键都不下发 = 用供应商的默认, 跟这个功能之前一模一样。

        这条守的是 `nearest_resolution("", …)` 会退回列表第一项那个行为 —— 少了空值这道
        闸, 一条没人碰过画质旋钮的请求会突然带上一档, 那是替用户做了决定。"""
        from studio.services import template_client

        variables = template_client.video_variables(
            _channel(self.preset, "seedance-2.5"), prompt="p", image_urls=[],
            duration=5, aspect_ratio="16:9", resolution="",
        )
        body = render(self.preset.request_template["body"], variables)
        self.assertNotIn("resolution", body)
        self.assertNotIn("mode", body)

    def test_generic_video_starter_also_carries_both_keys(self):
        """通用起点少了 `mode` 的话, 一条把 resolution_param 设成 mode 的通道会静默地不
        下发画质档 —— 模板里没有那个占位符 = 渲染不出来 = 没有任何报错。"""
        from studio.services.image_channels import _STARTER_ASYNC_VIDEO

        names = placeholders(_STARTER_ASYNC_VIDEO)
        self.assertIn("resolution", names)
        self.assertIn("mode", names)


class ApimartImagePresetTests(SimpleTestCase):
    """生图那半: 比例是拿去**筛**画布那十档的, 所以每一项都必须是画布真的有的那十个之一
    —— 写一个画布没有的 (`4:5`) 不会报错, 只是永远筛不中, 而症状是"这个模型的选择器少了
    一档"。"""

    # 画布工具栏上的十档 —— 抄自前端的 `IMAGE_EDIT_SIZES` (hooks/use-image-edit.ts)。
    # **故意抄一份而不是从后端某处引用**: 后端没有这张表, 它纯粹是界面的事。抄在测试里
    # 的作用正是"画布加减一档时这里会红" —— 那时预设表也确实需要跟着看一眼。
    CANVAS_RATIOS = frozenset({
        "auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21",
    })

    def setUp(self):
        self.preset = _preset("apimart_image")

    def test_table_only_names_real_models(self):
        self.assertLessEqual(set(_APIMART_IMAGE_RATIOS), set(self.preset.models))

    def test_every_ratio_is_one_the_canvas_offers(self):
        from studio.services.image_client import parse_ratios

        for model, raw in _APIMART_IMAGE_RATIOS.items():
            for ratio in parse_ratios(raw):
                with self.subTest(model=model, ratio=ratio):
                    self.assertIn(ratio, self.CANVAS_RATIOS)

    def test_models_that_take_everything_are_left_blank(self):
        """十档全收的不写进表里 —— 空 = 不限制。写一份"刚好等于全集"的列表只是多一处
        要跟着画布改的数据。"""
        for model in ("gpt-image-2", "seedream-4-5", "flux-2-max", "flux-kontext-pro"):
            with self.subTest(model=model):
                self.assertNotIn(model, _APIMART_IMAGE_RATIOS)

    def test_auto_is_excluded_where_the_provider_rejects_it(self):
        """画布的默认档就是 auto。收不了它的模型必须排除, 否则选择器摆着一个默认选中、
        一发就 400 的选项 (grok-imagine-2.0-ext 实测原话: unsupported `size` … auto)。"""
        from studio.services.image_client import parse_ratios

        for model in ("grok-imagine-2.0-ext", "qwen-image-3.0", "z-image-turbo",
                      "wan2.7-image", "imagen-4.0-apimart", "grok-imagine-1.5-apimart"):
            with self.subTest(model=model):
                self.assertNotIn("auto", parse_ratios(_APIMART_IMAGE_RATIOS[model]))

    def test_both_ratio_keys_carry_the_same_value(self):
        """31 个模型读 `size`, grok 那两个官方渠道读 `aspect_ratio` —— 取值一样, 所以两个
        键都发。实测这家忽略不认识的键。"""
        from studio.services import template_client

        channel = _channel(self.preset, "grok-imagine-image")
        variables = template_client.image_variables(
            channel, prompt="p", image_urls=[], size="16:9", n=1,
        )
        body = render(self.preset.request_template["body"], variables)
        self.assertEqual(body["size"], "16:9")
        self.assertEqual(body["aspect_ratio"], "16:9")

    def test_unsupported_pick_snaps_to_nearest(self):
        """选择器已经筛过一遍, 这条兜底管 agent 自己挑的尺寸和"换模型之后旧选择失效"。
        imagen 只有五档, 21:9 不在里面 —— 不兜底的话它会被**静默回退成 16:9**, 而那正是
        我们想让用户看见的那一步。"""
        from studio.services import template_client

        variables = template_client.image_variables(
            _channel(self.preset, "imagen-4.0-apimart"),
            prompt="p", image_urls=[], size="21:9", n=1,
        )
        self.assertEqual(variables["size"], "16:9")

    def test_size_key_honours_the_ratio_map(self):
        """`allowed_ratios` 的 "=" 右半边是"实际要发的值"。模板里那个键必须吃 `{{size}}`
        —— 吃 `{{aspect_ratio}}` 的话映射会**静默失效**, 而两者在没配映射时一模一样,
        所以这个错平时看不出来。"""
        from studio.services import template_client

        channel = dataclasses.replace(
            _channel(self.preset, "gpt-image-2"),
            allowed_ratios="1:1=1024x1024, 16:9",
        )
        variables = template_client.image_variables(
            channel, prompt="p", image_urls=[], size="1:1", n=1,
        )
        body = render(self.preset.request_template["body"], variables)
        self.assertEqual(body["size"], "1024x1024")        # 映射生效
        self.assertEqual(body["aspect_ratio"], "1:1")      # 比例那一半不受影响
