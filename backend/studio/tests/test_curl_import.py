"""curl → 模板里那些**猜**的部分。跟 test_channel_diagnosis 同一个理由: 规则是字符串
匹配, 而猜错的表现是"向导跑到一半停下, 或者建出一条形状不对的通道"。

眼下只覆盖任务 id 的定位 —— 它是向导第 3 步唯一会卡住人的地方 (文档给的查询 curl 里
那个 id 有五六种写法), 而且"认错一段"的后果是建出一条永远查不到状态的通道, 要等第一次
真实生成卡在轮询上才显形。
"""
from django.test import SimpleTestCase

from studio.services.curl_import import CurlParseError, _fill_task_id

TID = "task_01M18H1QVDKZZZZZZZZZZZZZZ"


class FillTaskIdTests(SimpleTestCase):
    def test_literal_example_id_from_docs(self):
        """**最常见的一种**: 文档直接给一个真实的示例 id, 不是占位符。

        apimart 文档原样那一条是这个规则的来源 —— 只认占位符的话, 用户对着文档粘完会被
        顶回来"认不出任务 id 该放哪儿", 而他手上并没有第二段 curl 可粘。
        查询串 (`?language=zh`) 要原样留着, 那是这家要求带的。
        """
        url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh"
        got, note = _fill_task_id(url, TID)
        self.assertEqual(got, "https://api.apimart.ai/v1/tasks/{{task_id}}?language=zh")
        self.assertIn("task-unified-1757156493-imcg5zqt", note)   # 猜了就得说

    def test_other_literal_id_shapes(self):
        for url, want in [
            ("https://api.x.ai/v1/jobs/9f2c1a8e-4b17-4c2e-9b3d-77aa10bb2c31",
             "https://api.x.ai/v1/jobs/{{task_id}}"),                       # uuid
            ("https://api.x.ai/v1/tasks/1757156493",
             "https://api.x.ai/v1/tasks/{{task_id}}"),                      # 纯数字
        ]:
            with self.subTest(url=url):
                self.assertEqual(_fill_task_id(url, TID)[0], want)

    def test_id_in_query_string(self):
        """参数名是明说的证据, 比按值的形状猜可靠。别的参数不能动。"""
        got, note = _fill_task_id("https://api.x.ai/v1/query?id=abc-123&language=zh", TID)
        self.assertEqual(got, "https://api.x.ai/v1/query?id={{task_id}}&language=zh")
        self.assertIn("id", note)

    def test_recognises_placeholder_shapes(self):
        """文档用占位符写的那几种。"""
        for url, want in [
            ("https://api.apimart.ai/v1/tasks/<task_id>", "https://api.apimart.ai/v1/tasks/{{task_id}}"),
            ("https://api.apimart.ai/v1/tasks/{task_id}", "https://api.apimart.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/[task_id]", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/:task_id", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/$TASK_ID", "https://api.x.ai/v1/tasks/{{task_id}}"),
            ("https://api.x.ai/v1/tasks/YOUR_TASK_ID", "https://api.x.ai/v1/tasks/{{task_id}}"),
        ]:
            with self.subTest(url=url):
                got, note = _fill_task_id(url, TID)
                self.assertEqual(got, want)
                self.assertEqual(note, "")      # 占位符是明确意图, 不算猜, 不用多嘴

    def test_real_id_wins(self):
        """地址里出现了刚跑出来的那个 id —— 精确定位, 不可能误伤, 也不用多嘴。"""
        self.assertEqual(
            _fill_task_id(f"https://api.apimart.ai/v1/tasks/{TID}", TID),
            ("https://api.apimart.ai/v1/tasks/{{task_id}}", ""),
        )

    def test_already_templated_is_left_alone(self):
        url = "https://api.x.ai/v1/tasks/{{task_id}}"
        self.assertEqual(_fill_task_id(url, TID), (url, ""))

    def test_scheme_and_port_are_not_placeholders(self):
        """`https:` 和 `:8080` 都长得像 `:task_id`。整条 URL 一起搜就会把协议头换掉。"""
        self.assertEqual(
            _fill_task_id("http://localhost:8080/v1/tasks/<id>", TID)[0],
            "http://localhost:8080/v1/tasks/{{task_id}}",
        )

    def test_refuses_rather_than_guessing(self):
        """最后一段是个**动作**而不是 id 时不能认。乱猜一段建出的是一条永远查不到状态的
        通道, 而那要等第一次真实生成卡在轮询上才显形 —— 比当场报错糟得多。"""
        for url in (
            "https://api.x.ai/v1/tasks/status",
            "https://api.x.ai/v1/result",
            "https://api.x.ai/v1/tasks",
            "https://api.x.ai/v1/images/generations",
            "https://api.x.ai/v1/tasks/abc",       # 太短又没数字 —— 宁可漏
        ):
            with self.subTest(url=url), self.assertRaises(CurlParseError):
                _fill_task_id(url, TID)
