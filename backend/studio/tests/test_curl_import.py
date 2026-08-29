"""curl → 模板里那些**猜**的部分。跟 test_channel_diagnosis 同一个理由: 规则是字符串
匹配, 而猜错的表现是"向导跑到一半停下, 或者建出一条形状不对的通道"。

眼下只覆盖任务 id 的定位 —— 它是向导第 3 步唯一会卡住人的地方 (文档给的查询 curl 几乎
不会带一个真实 id), 而且"认错一段"的后果是把协议头或路径改坏, 静默且难查。
"""
from django.test import SimpleTestCase

from studio.services.curl_import import CurlParseError, _fill_task_id

TID = "task_01M177CGTMWMJZBQYDC82C7PRD"


class FillTaskIdTests(SimpleTestCase):
    def test_recognises_placeholder_shapes(self):
        """文档里"任务 id 放这儿"的各种写法。**这些才是常态** —— 用户粘的是文档,
        文档里不会有他刚跑出来的那个 id。"""
        for url, want in [
            ("https://api.apimart.ai/v1/tasks/<task_id>", "https://api.apimart.ai/v1/tasks/{{task_id}}"),
            ("https://api.apimart.ai/v1/tasks/{task_id}", "https://api.apimart.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/[task_id]", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/:task_id", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/$TASK_ID", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/YOUR_TASK_ID", "https://api.x.ai/v1/tasks/{{task_id}}"),
            # 有的家把 id 放查询串里
            ("https://api.x.ai/v1/query?id=<task_id>", "https://api.x.ai/v1/query?id={{task_id}}"),
        ]:
            with self.subTest(url=url):
                self.assertEqual(_fill_task_id(url, TID), want)

    def test_real_id_wins(self):
        """地址里出现了刚跑出来的那个 id —— 精确定位, 不可能误伤。"""
        self.assertEqual(
            _fill_task_id(f"https://api.apimart.ai/v1/tasks/{TID}", TID),
            "https://api.apimart.ai/v1/tasks/{{task_id}}",
        )

    def test_already_templated_is_left_alone(self):
        url = "https://api.x.ai/v1/tasks/{{task_id}}"
        self.assertEqual(_fill_task_id(url, TID), url)

    def test_scheme_and_port_are_not_placeholders(self):
        """`https:` 和 `:8080` 都长得像 `:task_id`。整条 URL 一起搜就会把协议头换掉。"""
        self.assertEqual(
            _fill_task_id("http://localhost:8080/v1/tasks/<id>", TID),
            "http://localhost:8080/v1/tasks/{{task_id}}",
        )

    def test_refuses_rather_than_guessing(self):
        """认不出来就报错。乱猜一段的后果是建出一条永远查不到状态的通道, 而那条错误
        要等到第一次真实生成卡在轮询上才会显形。"""
        for url in ("https://api.x.ai/v1/tasks/status", "https://api.x.ai/v1/result"):
            with self.subTest(url=url), self.assertRaises(CurlParseError):
                _fill_task_id(url, TID)
