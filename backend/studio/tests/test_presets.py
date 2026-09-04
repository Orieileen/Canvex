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
    _APIMART_IMAGE_RESOLUTIONS,
    _TEXT_ONLY_IMAGE_MODELS,
    _UNDOCUMENTED_IMAGE_MODELS,
    _APIMART_VIDEO_DURATIONS,
    _APIMART_VIDEO_RATIOS,
    _APIMART_VIDEO_T2V_ONLY,
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

    def test_text_only_models_stay_out_of_the_preset(self):
        """只会文生图的模型不进这条预设 —— 画布的「图像」标签必须先选中一张图, 所以它们
        从工具栏根本没有能用的路径, 留着只会让人选中再吃一个报错 (其中 z-image-turbo 那句
        `Field 'text' is required in content item.` 跟真实原因隔着两层翻译)。

        真要支持它们, 先给 ImageChannel 加一个"收不收源图"的旋钮再说 —— 别直接加回名单。"""
        for model in _TEXT_ONLY_IMAGE_MODELS:
            with self.subTest(model=model):
                self.assertNotIn(model, self.preset.models)
                self.assertNotIn(model, _APIMART_IMAGE_RATIOS)

    def test_undocumented_models_stay_out_of_the_preset(self):
        """docs.apimart.ai 上没有页的模型不进这条预设。

        预设的全部意义是"只填一把 key, 剩下的都对好了" —— 一个连收哪些比例、哪些画质、
        收不收源图都不知道的模型混在里面, 破坏的正是这个承诺, 而且它跟旁边配好的模型
        长得一模一样, 用户分辨不出哪几个是我们心里没底的。

        也别照邻居猜一份填上: grok 这一族内部就不一致 —— 有文档的三个里
        grok-imagine-1.5-apimart 收五个比例、没有画质档, grok-imagine-image 收八个比例、
        有 1k/2k, 连比例放哪个键都不一样 (size vs aspect_ratio)。"""
        for model in _UNDOCUMENTED_IMAGE_MODELS:
            with self.subTest(model=model):
                self.assertNotIn(model, self.preset.models)
                self.assertNotIn(model, _APIMART_IMAGE_RATIOS)
                self.assertNotIn(model, _APIMART_IMAGE_RESOLUTIONS)

    def test_every_model_is_accounted_for(self):
        """每个留在名单里的模型, 要么在某张约束表里, 要么在下面这个"核过, 确实不限制"
        的白名单里。

        **这条守的是"有人加了个模型但没加数据"** —— 那种模型在界面上跟配好的一模一样,
        只有生成失败时才暴露, 而这条预设正是为了不让人撞上这个。"""
        # 核过文档, 确实两样都不限制的:
        #   flux-kontext-max / -pro —— 十个比例全收, 且文档里根本没有 resolution 参数
        unconstrained = {"flux-kontext-max", "flux-kontext-pro"}
        covered = set(_APIMART_IMAGE_RATIOS) | set(_APIMART_IMAGE_RESOLUTIONS) | unconstrained
        self.assertEqual(set(self.preset.models) - covered, set())

    def test_auto_is_excluded_where_the_provider_rejects_it(self):
        """画布的默认档就是 auto。收不了它的模型必须排除, 否则选择器摆着一个默认选中、
        一发就 400 的选项 (grok-imagine-2.0-ext 实测原话: unsupported `size` … auto)。"""
        from studio.services.image_client import parse_ratios

        for model in ("qwen-image-3.0", "qwen-image-3.0-pro", "qwen-image-2.0",
                      "wan2.7-image", "wan2.7-image-pro", "grok-imagine-1.5-apimart"):
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
        qwen-image-3.0 只有七档, 21:9 不在里面 —— 我们把它落到 16:9, 而不是让供应商
        自己去猜(有的家会静默回退, 有的直接 400)。"""
        from studio.services import template_client

        variables = template_client.image_variables(
            _channel(self.preset, "qwen-image-3.0"),
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


class ApimartImageResolutionTests(SimpleTestCase):
    """生图的画质档。跟比例相反, 这里是**照它列**而不是拿它筛画布那三档 —— 各家有
    `0.5K` / `1.5K` / `3K`, flux-2 干脆按百万像素计, 画布那三档筛完要么残缺要么全空。"""

    def setUp(self):
        self.preset = _preset("apimart_image")

    def test_table_only_names_real_models(self):
        self.assertLessEqual(set(_APIMART_IMAGE_RESOLUTIONS), set(self.preset.models))

    def test_every_tier_is_parseable(self):
        """认不出的档 (`_resolution_value` 给 None) 排不了序也挑不了最近的 —— 表现是
        换模型时静默落到列表第一项, 也就是最便宜那一档。"""
        from studio.services.image_client import _resolution_value, parse_resolutions

        for model, raw in _APIMART_IMAGE_RESOLUTIONS.items():
            tiers = parse_resolutions(raw)
            self.assertTrue(tiers, model)
            for tier in tiers:
                with self.subTest(model=model, tier=tier):
                    self.assertIsNotNone(_resolution_value(tier))

    def test_tiers_are_listed_low_to_high(self):
        """选择器照这个顺序列, 而"落到最近的一档"平手时取低的 —— 顺序乱了这两条都会
        给出让人意外的结果。"""
        from studio.services.image_client import _resolution_value, parse_resolutions

        for model, raw in _APIMART_IMAGE_RESOLUTIONS.items():
            values = [_resolution_value(t) for t in parse_resolutions(raw)]
            with self.subTest(model=model):
                self.assertEqual(values, sorted(values))

    def test_template_sends_the_tier(self):
        """模板里没有 `resolution` 这个键的话, 工具栏那个画质旋钮是个死的 —— 画布照档位
        预留占位框, 而供应商压根没收到档位。"""
        from studio.services import template_client

        variables = template_client.image_variables(
            _channel(self.preset, "seedream-4-5"),
            prompt="p", image_urls=[], size="1:1", n=1, resolution="2K",
        )
        body = render(self.preset.request_template["body"], variables)
        self.assertEqual(body["resolution"], "2K")

    def test_unsupported_tier_snaps_to_nearest(self):
        """seedream-4-5 明写不支持 1K; seedream-5-0-pro 传 3K/4K 直接 400。"""
        from studio.services import template_client

        for model, want, expect in [
            ("seedream-4-5", "1K", "2K"),          # 没有 1K → 最近的是 2K
            ("seedream-5-0-pro", "4K", "2K"),      # 封顶 2K
            ("seedream-5-0-lite", "1K", "2K"),     # 没有 1K
            ("gemini-2.5-flash-image-preview", "4K", "1K"),   # 只有一档
            ("flux-2-max", "2K", "4MP"),           # 4MP = 2048² ≈ 2K
        ]:
            with self.subTest(model=model, want=want):
                variables = template_client.image_variables(
                    _channel(self.preset, model),
                    prompt="p", image_urls=[], size="1:1", n=1, resolution=want,
                )
                self.assertEqual(variables["resolution"], expect)

    def test_undeclared_models_pass_the_canvas_tier_through(self):
        """文档里没有 resolution 的那几个 (gpt-image-1 / flux-kontext / grok-imagine-1.5),
        照样把画布选的档发出去。

        **这是实测定的, 不是想当然**: 一开始写的是"不该发这个键", 但拿 gpt-image-1 真发了
        一条 —— 它把字段透传给 OpenAI(最严的那个上游), 任务照样 completed 出图。这家
        忽略不认识的键(另有一次探测: 塞一个完全不存在的键, 它只报别的错)。

        所以留着透传是对的: 空的 allowed_resolutions 意思是"我们没这个模型的档位数据",
        不是"这个模型没有档位"。硬改成不发, 会让手写模板的通道白白少一个能用的旋钮。"""
        from studio.services import template_client

        for model in ("gpt-image-1", "flux-kontext-pro", "grok-imagine-1.5-apimart"):
            with self.subTest(model=model):
                variables = template_client.image_variables(
                    _channel(self.preset, model),
                    prompt="p", image_urls=[], size="1:1", n=1, resolution="2K",
                )
                body = render(self.preset.request_template["body"], variables)
                self.assertEqual(body["resolution"], "2K")

    def test_declared_models_only_ever_send_a_tier_they_declared(self):
        """报了档位的模型, 发出去的一定在它自己那张表里 —— 这条才是这批数据的价值所在。"""
        from studio.services import template_client
        from studio.services.image_client import parse_resolutions

        for model, raw in _APIMART_IMAGE_RESOLUTIONS.items():
            tiers = parse_resolutions(raw)
            for want in ("1K", "2K", "4K"):        # 画布只会发这三个
                with self.subTest(model=model, want=want):
                    variables = template_client.image_variables(
                        _channel(self.preset, model),
                        prompt="p", image_urls=[], size="1:1", n=1, resolution=want,
                    )
                    self.assertIn(variables["resolution"], tiers)


class ApimartVideoRatioTests(SimpleTestCase):
    """视频比例。画布的视频标签只给 16:9 / 9:16 / 1:1 三档, 而七个模型**不收 1:1** ——
    跟当初时长那个是同一类 bug: 选择器摆着一档, 一发就错。"""

    def setUp(self):
        self.preset = _preset("apimart_video")

    def test_table_only_names_real_models(self):
        self.assertLessEqual(set(_APIMART_VIDEO_RATIOS), set(self.preset.models))

    def test_only_narrower_than_the_canvas_is_written_down(self):
        """三档全收的留空 = 不限制。写一份"刚好等于全集"的列表只是多一处要跟着画布改的
        数据 —— 跟生图那张比例表同一个规矩。"""
        from studio.services.image_client import parse_ratios

        for model, raw in _APIMART_VIDEO_RATIOS.items():
            with self.subTest(model=model):
                self.assertLess(len(parse_ratios(raw)), 3)

    def test_every_ratio_is_one_the_canvas_offers(self):
        from studio.services.image_client import parse_ratios

        for model, raw in _APIMART_VIDEO_RATIOS.items():
            for ratio in parse_ratios(raw):
                with self.subTest(model=model, ratio=ratio):
                    self.assertIn(ratio, {"16:9", "9:16", "1:1"})

    def test_square_snaps_to_landscape_on_the_seven(self):
        """选 1:1 时这七个必须落到一个它们真收的比例。不兜底的话:
        gemini-omni-flash-preview 会**静默按 16:9 出片**(文档原话「其它值按 16:9 处理」),
        用户拿到横屏而他选的是方形。"""
        from studio.services import template_client

        for model in _APIMART_VIDEO_RATIOS:
            with self.subTest(model=model):
                variables = template_client.video_variables(
                    _channel(self.preset, model), prompt="p", image_urls=[],
                    duration=5, aspect_ratio="1:1",
                )
                self.assertIn(variables["aspect_ratio"], ("16:9", "9:16"))

    def test_unrestricted_models_still_get_square(self):
        """留空的那三十四个不受影响 —— 1:1 原样发出去。"""
        from studio.services import template_client

        for model in ("seedance-2.5", "kling-v3", "wan2.6", "MiniMax-H3"):
            with self.subTest(model=model):
                variables = template_client.video_variables(
                    _channel(self.preset, model), prompt="p", image_urls=[],
                    duration=5, aspect_ratio="1:1",
                )
                self.assertEqual(variables["aspect_ratio"], "1:1")

    # ── 图生视频时的比例键 (ratio_scope) ────────────────────────────────────
    #
    # 画布的视频标签**恒为图生**, 所以这几条测的是每一次真实生成。
    # 一刀切("有图就不发")是错的: 文档里有九个模型图生时比例仍然生效, 其中
    # viduq3 / viduq3-mix **只有**参考生视频一种模式 —— 不发等于拆掉它们唯一的方向
    # 旋钮, 而且不报错。所以这是一张 per-model 的表, 下面两组分别钉住它的两侧。

    def test_t2v_only_models_drop_the_ratio_when_an_image_is_sent(self):
        """报了 text_only 的模型带参考图时, 比例两个键都要空 —— 空 = render 把键整个
        删掉。viduq3-pro / -turbo 的文档写的是「就不能同时设置 aspect_ratio」, 是禁止,
        不是"传了会被忽略"。"""
        from studio.services import template_client

        for model in sorted(_APIMART_VIDEO_T2V_ONLY):
            with self.subTest(model=model):
                variables = template_client.video_variables(
                    _channel(self.preset, model), prompt="p",
                    image_urls=["https://x/a.png"], duration=5, aspect_ratio="16:9",
                )
                self.assertEqual(variables["aspect_ratio"], "")
                self.assertEqual(variables["size"], "")
                # 渲染之后那个键必须真的不在 body 里 —— 只把值置空是不够的。
                body = render(self.preset.request_template["body"], variables)
                self.assertNotIn("aspect_ratio", body)

    def test_t2v_only_models_keep_the_ratio_without_an_image(self):
        """没有参考图时照发 —— 通道配置向导的试跑走的正是这条 (image_urls=[])。"""
        from studio.services import template_client

        for model in sorted(_APIMART_VIDEO_T2V_ONLY):
            with self.subTest(model=model):
                variables = template_client.video_variables(
                    _channel(self.preset, model), prompt="p", image_urls=[],
                    duration=5, aspect_ratio="9:16",
                )
                self.assertEqual(variables["aspect_ratio"], "9:16")

    def test_models_that_still_take_a_ratio_with_an_image_keep_it(self):
        """反面: 这几个文档明写图生时比例仍然是合法参数, 一个都不能被顺手带走。
        viduq3 / viduq3-mix 尤其要紧 —— 它们**只有**参考生视频一种模式。"""
        from studio.services import template_client

        for model in ("kling-v3", "kling-v2-6", "viduq3", "viduq3-mix",
                      "MiniMax-H3", "happyhorse-1.0", "seedance-2.5"):
            with self.subTest(model=model):
                variables = template_client.video_variables(
                    _channel(self.preset, model), prompt="p",
                    image_urls=["https://x/a.png"], duration=5, aspect_ratio="9:16",
                )
                self.assertEqual(variables["aspect_ratio"], "9:16")

    def test_t2v_only_table_only_names_real_models(self):
        self.assertLessEqual(set(_APIMART_VIDEO_T2V_ONLY), set(self.preset.models))
