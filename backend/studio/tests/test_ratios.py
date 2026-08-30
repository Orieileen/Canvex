"""比例映射。**每个模型收的比例都不一样**, 而画布上那十个是固定的 —— 所以"选得中但发
不出去"必然发生, 这张表就是防它的。

用例里的 allowed 是实测抄下来的: apimart 的 gemini-3.1-flash-image-preview 会 400 掉不
在列表里的比例, 而同一家的 gpt-image-2 连 `999:998` 都收。
"""
from django.test import SimpleTestCase

from studio.services.image_client import (
    nearest_ratio,
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
