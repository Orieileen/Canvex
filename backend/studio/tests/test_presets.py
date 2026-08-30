"""预设表自己的一致性。

**为什么值得一个测试**: `_APIMART_VIDEO_RESOLUTIONS` / `_APIMART_VIDEO_DURATIONS` 是两张
按模型字符串索引的表, 而模型清单在另一处 (`_Preset.models`)。写错一个字的表现是**那个
模型静默地没有旋钮** —— 界面上少一个下拉、请求里少一个键, 没有任何报错, 而且要生成一次
才看得出来。同一类错误在这条分支上已经犯过一次 (`grok-imagine-video-1.5` ←→
`grok-imagine-1.5-video-apimart`)。
"""
from django.test import SimpleTestCase

from studio.services.image_channels import (
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
