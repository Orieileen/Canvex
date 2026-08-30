"""比例映射。**每个模型收的比例都不一样**, 而画布上那十个是固定的 —— 所以"选得中但发
不出去"必然发生, 这张表就是防它的。

用例里的 allowed 是实测抄下来的: apimart 的 gemini-3.1-flash-image-preview 会 400 掉不
在列表里的比例, 而同一家的 gpt-image-2 连 `999:998` 都收。
"""
from django.test import SimpleTestCase

from studio.services.image_client import (
    nearest_duration,
    nearest_resolution,
    nearest_ratio,
    parse_durations,
    parse_resolution_map,
    parse_resolutions,
    resolve_ratio,
    resolve_resolution,
    parse_ratio_map,
    parse_ratios,
    ratio_to_pixels,
)

GEMINI = parse_ratios(
    "16:9, 1:1, 1:4, 1:8, 21:9, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, auto"
)


class NearestRatioTests(SimpleTestCase):
    def test_empty_allowed_is_passthrough(self):
        """没填 = 不限制。**绝大多数通道走这条**, 不能有任何改动。"""
        for want in ("9:21", "auto", "1:1", "随便写的"):
            with self.subTest(want=want):
                self.assertEqual(nearest_ratio(want, []), want)

    def test_supported_ratio_is_untouched(self):
        for want in ("21:9", "1:1", "auto", "9:16"):
            with self.subTest(want=want):
                self.assertEqual(nearest_ratio(want, GEMINI), want)

    def test_unsupported_falls_to_nearest(self):
        """画布给 9:21, gemini 不收 —— 9:16 (0.5625) 比 1:4 (0.25) 更接近 0.4286。"""
        self.assertEqual(nearest_ratio("9:21", GEMINI), "9:16")

    def test_matches_by_value_not_string(self):
        """21:9 和 7:3 是同一个画面、不同的字符串。gcd 化简会把前者变成后者, 而供应商
        认的是前者 —— 按数值比才能把它换回来。"""
        self.assertEqual(nearest_ratio("7:3", GEMINI), "21:9")
        self.assertEqual(nearest_ratio("2:1", GEMINI), "16:9")

    def test_uncomparable_prefers_auto(self):
        """"auto" 比不出数值。allowed 里有 auto 就给 auto, 没有再退 1:1。"""
        self.assertEqual(nearest_ratio("auto", ["1:1", "16:9"]), "1:1")
        self.assertEqual(nearest_ratio("auto", ["16:9", "auto"]), "auto")
        self.assertEqual(nearest_ratio("auto", ["16:9"]), "16:9")


class RatioToPixelsTests(SimpleTestCase):
    """画布**只发比例串**, 而 size_to_wh 对比例串是"解析不了" —— 于是模板里的
    `{{width}}` / `{{height}}` 一直渲染成空、那两个键整个消失, 且没有任何报错。"""

    def test_ratio_strings_become_pixels(self):
        self.assertEqual(ratio_to_pixels("1:1"), (1024, 1024))
        self.assertEqual(ratio_to_pixels("16:9"), (1024, 576))
        self.assertEqual(ratio_to_pixels("9:16"), (576, 1024))

    def test_snaps_to_multiples_of_32(self):
        """不少模型要求边长是 32 的倍数。凑整比"精确比例"重要 —— 1365.33 发不出去。"""
        for ratio in ("21:9", "4:3", "3:2", "5:4"):
            with self.subTest(ratio=ratio):
                w, h = ratio_to_pixels(ratio)
                self.assertEqual((w % 32, h % 32), (0, 0), f"{ratio} → {w}x{h}")

    def test_pixel_strings_pass_through(self):
        self.assertEqual(ratio_to_pixels("1024x768"), (1024, 768))

    def test_unparseable_is_none(self):
        """"auto" 没有确定尺寸 —— 给 None 让那两个键消失, 比编一个数好。"""
        for raw in ("auto", "", "abc", "1:0"):
            with self.subTest(raw=raw):
                self.assertEqual(ratio_to_pixels(raw), (None, None))


class RatioMapTests(SimpleTestCase):
    """`比例=要发的值`。有些家只收一张写死的像素表, 而那些像素**不是**按比例算出来的 ——
    OpenAI 的 gpt-image-1 只认 1024x1024 / 1536x1024 / 1024x1536, 而 3:2 按长边 1024 算
    出来是 1024x672, 发过去就是 400。"""

    OPENAI = "1:1=1024x1024, 3:2=1536x1024, 2:3=1024x1536, auto=auto"

    def test_maps_ratio_to_send_value(self):
        self.assertEqual(parse_ratio_map(self.OPENAI), {
            "1:1": "1024x1024", "3:2": "1536x1024",
            "2:3": "1024x1536", "auto": "auto",
        })

    def test_bare_ratio_maps_to_itself(self):
        """**绝大多数供应商走这条** (apimart 直接收 `16:9`) —— 不能因为加了映射就变。"""
        self.assertEqual(parse_ratio_map("16:9, 1:1, auto"),
                         {"16:9": "16:9", "1:1": "1:1", "auto": "auto"})

    def test_parse_ratios_returns_only_the_canvas_half(self):
        """工具栏的选择器和 nearest_ratio 只关心比例本身。"""
        self.assertEqual(parse_ratios(self.OPENAI), ["1:1", "3:2", "2:3", "auto"])

    def test_empty_and_junk(self):
        for raw in ("", "   ", ",,", None):
            with self.subTest(raw=raw):
                self.assertEqual(parse_ratio_map(raw), {})

    def test_full_width_comma(self):
        """中文文档里逗号常常是全角的, 而复制粘贴是这个框最主要的填写方式。"""
        self.assertEqual(list(parse_ratio_map("16:9，1:1")), ["16:9", "1:1"])


class DurationTests(SimpleTestCase):
    """各家收的秒数差得离谱, 而画布原来固定给 5/10/15 —— veo3 只收 8、sora 只收
    4/8/12/16/20, 那八个模型**一条都生成不出来**, 报错还是供应商给的 invalid duration,
    跟"通道配错了"看起来一模一样。"""

    def test_empty_is_passthrough(self):
        """没填 = 不限制。绝大多数模型走这条 (它们 5/10/15 都收)。"""
        for want in (5, 10, 15, 7):
            with self.subTest(want=want):
                self.assertEqual(nearest_duration(want, []), want)

    def test_supported_value_untouched(self):
        self.assertEqual(nearest_duration(8, [4, 8, 12, 16, 20]), 8)

    def test_falls_to_nearest(self):
        """选择器已经照 allowed 列过一次, 这条兜底管的是 agent 自己挑的秒数, 以及
        "换了模型之后 localStorage 里那个旧选择失效"。"""
        self.assertEqual(nearest_duration(5, [8]), 8)              # veo3: 只有一个
        self.assertEqual(nearest_duration(5, [4, 8, 12, 16, 20]), 4)
        self.assertEqual(nearest_duration(15, [5, 10, 12]), 12)
        self.assertEqual(nearest_duration(5, [6, 10]), 6)          # Hailuo-2.3 下限是 6

    def test_ties_prefer_the_shorter(self):
        """离得一样近时取小的 —— 时长直接决定计费, 多给不如少给。"""
        self.assertEqual(nearest_duration(5, [4, 6]), 4)

    def test_parse(self):
        self.assertEqual(parse_durations("4, 8, 12"), [4, 8, 12])
        self.assertEqual(parse_durations("6，10"), [6, 10])        # 全角逗号
        self.assertEqual(parse_durations(""), [])
        self.assertEqual(parse_durations("abc, 5"), [5])           # 认不出的跳过


class NearestResolutionTests(SimpleTestCase):
    """画质档跟时长同一类事, 但**没有画布默认可退** —— 各家从 360p 排到 4k, 还有
    MiniMax 的 `2K` 和可灵的 `std/pro`, 凑不出一张通用的表。所以没配 = 不发这个键 =
    用供应商的默认, 而那个默认往往是最贵的一档 (wan3.0-video 文档原话: 不传按 1080P
    计费)。"""

    def test_empty_is_passthrough(self):
        self.assertEqual(nearest_resolution("720p", []), "720p")

    def test_case_insensitive_exact_match(self):
        """同一档各家写法不一 (`720p` / `720P`), 而画布上存的是**上一个模型**的写法。
        不归一的话换个模型就变成"没匹配上", 白白掉一档。"""
        self.assertEqual(nearest_resolution("720p", ["720P", "1080P"]), "720P")
        self.assertEqual(nearest_resolution("4K", ["720p", "1080p", "4k"]), "4k")

    def test_falls_to_nearest_not_to_first(self):
        """从 seedance-2.0 的 1080p 换到 -fast (只有 480p/720p): 最近的是 720p,
        取第一个会掉到 480p。"""
        self.assertEqual(nearest_resolution("1080p", ["480p", "720p"]), "720p")
        self.assertEqual(nearest_resolution("4k", ["720p"]), "720p")

    def test_k_notation_sorts_between(self):
        """`2K` 排在 1080p 和 4k 中间 —— MiniMax-H3 只有 768P / 2K 两档。"""
        self.assertEqual(nearest_resolution("720p", ["768P", "2K"]), "768P")
        self.assertEqual(nearest_resolution("1080p", ["768P", "2K"]), "768P")
        self.assertEqual(nearest_resolution("4k", ["768P", "2K"]), "2K")

    def test_ties_prefer_the_cheaper(self):
        self.assertEqual(nearest_resolution("720p", ["480p", "960p"]), "480p")

    def test_unparseable_want_falls_to_first(self):
        self.assertEqual(nearest_resolution("", ["480p", "720p"]), "480p")
        self.assertEqual(nearest_resolution("auto", ["480p", "720p"]), "480p")

    def test_map_form_shows_pixels_sends_mode(self):
        """可灵那四个模型把画质叫 `mode`, 取值 std / pro —— 文档自己标了 std=720P。
        选择器摆「std」等于让用户去查那是多少像素, 摆「720P」再发 std 两边都对。"""
        tiers = parse_resolution_map("720P=std, 1080P=pro, 4K=4k")
        self.assertEqual(tiers, {"720P": "std", "1080P": "pro", "4K": "4k"})
        self.assertEqual(parse_resolutions("720P=std, 1080P=pro"), ["720P", "1080P"])
        picked = nearest_resolution("1080p", list(tiers))
        self.assertEqual(tiers[picked], "pro")

    def test_parse_plain_list(self):
        self.assertEqual(parse_resolutions("480p, 720p, 1080p"), ["480p", "720p", "1080p"])
        self.assertEqual(parse_resolutions("720p，1080p"), ["720p", "1080p"])   # 全角逗号
        self.assertEqual(parse_resolutions(""), [])

    def test_megapixel_tiers_sort_by_edge_not_by_the_bare_number(self):
        """flux-2 按**百万像素**计档 (1MP / 2MP / 3MP / 4MP)。照字面读成 1~4 的话,
        4MP 会排到 0.5K 前面 —— 于是"选 2K"挑中的是它最小的那一档。换算成边长才对:
        1MP = 1024², 4MP = 2048², 所以 4MP 落在 2K 附近。"""
        flux = ["1MP", "2MP", "3MP", "4MP"]
        self.assertEqual(nearest_resolution("2K", flux), "4MP")     # 2048² ≈ 2K
        self.assertEqual(nearest_resolution("1K", flux), "1MP")     # 1024² = 1K
        self.assertEqual(nearest_resolution("4K", flux), "4MP")     # 封顶

    def test_half_k_and_one_and_a_half_k_parse(self):
        """gemini-3.1-flash 有 0.5K, seedream-5-0-pro 有 1.5K —— 画布那三档里都没有。"""
        self.assertEqual(nearest_resolution("2K", ["1K", "1.5K", "2K"]), "2K")
        self.assertEqual(nearest_resolution("4K", ["1K", "1.5K", "2K"]), "2K")
        self.assertEqual(nearest_resolution("0.5K", ["0.5K", "1K", "2K", "4K"]), "0.5K")
        self.assertEqual(nearest_resolution("1K", ["2K", "3K", "4K"]), "2K")   # lite 没有 1K


class ResolveHelpersTests(SimpleTestCase):
    """`resolve_ratio` / `resolve_resolution` —— 「解析成表 → 挑最近的 → 查出要发的那半」
    这三步的唯一实现。四个调用点以前各抄一份, 而**第三步最容易掉**: 它对没写 `=` 右半边
    的通道是空操作, 所以漏了看不出来, 只有配了映射的那一家会静默发错值。
    video_variables 就掉过一次。"""

    def test_no_mapping_means_both_halves_are_the_same(self):
        self.assertEqual(resolve_ratio("16:9, 1:1", "1:1"), ("1:1", "1:1"))
        self.assertEqual(resolve_resolution("1K, 2K", "2K"), ("2K", "2K"))

    def test_mapping_splits_shown_from_sent(self):
        """OpenAI 只认写死的像素表; 可灵把画质叫 mode。"""
        self.assertEqual(resolve_ratio("3:2=1536x1024", "3:2"), ("3:2", "1536x1024"))
        self.assertEqual(
            resolve_resolution("720P=std, 1080P=pro", "1080p"), ("1080P", "pro"),
        )

    def test_unconfigured_channel_is_a_no_op(self):
        """绝大多数通道没填这两项 —— 原样返回, 这条路不该有任何行为。"""
        self.assertEqual(resolve_ratio("", "21:9"), ("21:9", "21:9"))
        self.assertEqual(resolve_resolution("", "4K"), ("4K", "4K"))

    def test_resolution_is_empty_in_empty_out(self):
        """没选画质 = 不下发这个键。少了这条, 空串会退回列表第一项 —— 等于替用户挑了
        一档。比例那半没有对应规则: 画布永远会给一个比例。"""
        self.assertEqual(resolve_resolution("1K, 2K", ""), ("", ""))
        self.assertEqual(resolve_resolution("1K, 2K", "   "), ("", ""))
