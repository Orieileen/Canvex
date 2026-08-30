"""channel_diagnosis 的规则表 —— 每条用例都是**真见过的报文**。

为什么这个模块值得一个测试而项目里其它地方没有: 它是字符串匹配, 而且是一张**会长**的表
—— 每接一家新供应商就可能多一条规则。加规则最容易出的事不是新规则不生效, 而是它悄悄把
旁边一条盖掉 (顺序敏感), 而那个错误的表现是"给了一句自信的、错的建议", 比不给建议更糟。

用 SimpleTestCase (不碰库) 跑 `python manage.py test studio`, 不引入任何新依赖。

**新增规则时请连报文一起加进来**, 别只加规则 —— 表里的每一行同时是"这家供应商这样说话"
的记录。
"""
from django.test import SimpleTestCase

from studio.services.channel_diagnosis import diagnose


# (期望 code, 报文)。报文是 channel_health / 测试按钮存下来的那种形状:
# `{异常类名}: {消息}`, 消息里带着供应商的原始 body。
CASES: list[tuple[str, str]] = [
    # ── 鉴权 / 计费 ────────────────────────────────────────────────────────
    ("auth", 'HTTPError: 401 Unauthorized for https://api.tu-zi.com/v1/images/generations: '
             '{"error":{"code":"","message":"Invalid token (request id: 2026…)","type":"new_api_error"}}'),
    ("quota", 'TemplateRequestError: 提交 HTTP 402: {"error":{"message":"当前分组上游负载已饱和,'
              '或余额不足(-0.738658),请充值后重试","type":"insufficient_user_quota"}}'),
    # OpenAI 欠费回的是 429 —— 按状态码判会说成"等一会儿再试", 而等多久都不会好。
    ("quota", 'HTTPError: 429 Too Many Requests for https://api.openai.com/v1/images/generations: '
              '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'),
    ("rate_limit", 'HTTPError: 429 Too Many Requests for https://x/v1/images/generations: '
                   '{"error":{"code":"rate_limit_exceeded"}}'),

    # ── 模型 / 路由 ────────────────────────────────────────────────────────
    # 兔子 (new-api 那一系) 在模型名不存在时回 **503** —— 按状态码判会说成"供应商挂了"。
    ("no_channel", 'HTTPError: 503 Service Unavailable for https://api.tu-zi.com/v1/images/generations: '
                   '{"error":{"code":"image_size_channel_not_available","message":"No channel is '
                   'available for the requested image size tier 1 (request id: 2026…)"}}'),
    ("no_channel", 'HTTPError: 400 Bad Request for https://api.tu-zi.com/v1/images/generations: '
                   '{"error":{"message":"当前分组 default 下对于模型 gpt-image-9 无可用渠道"}}'),
    ("model", 'HTTPError: 404 Not Found for https://api.openai.com/v1/images/generations: '
              '{"error":{"message":"The model gpt-image-9 does not exist or you do not have access to it."}}'),

    # ── 端点 / 供应商 ──────────────────────────────────────────────────────
    ("endpoint", 'HTTPError: 404 Not Found for https://api.tu-zi.com/v1/v1/images/generations: '
                 '<html>404 page not found</html>'),
    ("provider_down", 'HTTPError: 502 Bad Gateway for https://x/v1/images/generations: upstream connect error'),

    # ── 网络三兄弟。顺序敏感: urllib3 把 TLS 失败和读超时都包进 "Max retries exceeded",
    #    所以先判"连不上"会把这两种全吃掉。
    ("tls", 'SSLError: HTTPSConnectionPool(host=1, port=443): Max retries exceeded (Caused by '
            'SSLError(SSLEOFError(8, "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol")))'),
    ("timeout", 'ReadTimeout: HTTPSConnectionPool(host=1, port=443): Read timed out. (read timeout=15)'),
    ("timeout", "ConnectionError: HTTPSConnectionPool(host='api.slow.ai', port=443): Read timed out. (read timeout=15)"),
    # **连接**超时不是"把超时调大" —— 根本没连上, 该去看地址和端口。
    ("unreachable", "ConnectionError: HTTPSConnectionPool(host='10.1.2.3', port=443): Max retries exceeded "
                    "with url: /v1/images/generations (Caused by ConnectTimeoutError(Connection to "
                    "10.1.2.3 timed out. (connect timeout=10)))"),
    ("unreachable", "ConnectionError: HTTPSConnectionPool(host='api.wrongname.ai', port=443): Max retries "
                    "exceeded with url: /v1/images/generations (Caused by NameResolutionError())"),
    ("unreachable", "APIConnectionError: Connection error."),
    ("unreachable_local", "ConnectionError: HTTPConnectionPool(host='localhost', port=11434): Max retries "
                          "exceeded with url: /v1/images/generations (Caused by NewConnectionError("
                          "Failed to establish a new connection: [Errno 111] Connection refused))"),

    ("bad_request", 'TemplateRequestError: 提交 HTTP 400: {"error":{"message":"prompt is required"}}'),

    # ── 认不出才是对的 ────────────────────────────────────────────────────
    # 模板通道自己那些报错**已经**写清了该改哪儿 (见 template_client), 再加一句泛泛的
    # "多半是…"只会把真正的话往下挤。
    ("", "TemplateRequestError: 按 `result_path` 取到的这一项里找不到图片 (b64_json / url 之类)。"
         "它有: ['created', 'data']。把 `result_path` 指到真正含图的那一层。"),
    ("", "TemplateRequestError: 轮询了 9 次 (间隔 20s 起, 退避到 180s) 任务还没完成, 最后看到的状态是 `running`。"),
    ("", "TemplateRequestError: 供应商回的是一个任务 (有 ['status', 'task_id']), 不是图 —— 这家是**异步**的, "
         "模板里要加 `task_id_path` 和 `poll` 段。"),
    ("", "ValueError: image generation response has empty 'data' array"),
    ("", ""),
]


class DiagnoseTests(SimpleTestCase):
    def test_real_provider_errors(self):
        for expected, error in CASES:
            with self.subTest(error=error[:60]):
                self.assertEqual(diagnose(error), expected)

    def test_404_points_at_the_right_place(self):
        """同一个 404, 内置通道要改 base_url, 模板通道要改模板里的 `url`。

        指错地方的提示比不提示更糟, 所以这一条单独钉住。
        """
        text = "HTTPError: 404 Not Found for https://x/v1/images/generations: nope"
        self.assertEqual(diagnose(text), "endpoint")
        self.assertEqual(diagnose(text, template=True), "endpoint_template")

    def test_body_digits_do_not_look_like_status_codes(self):
        """状态码只在我们自己拼的那一截里找 —— 供应商正文里的 request id / 尺寸不算。"""
        self.assertEqual(
            diagnose('ValueError: {"request_id":"404000","size":"512x512","note":"429 things"}'),
            "",
        )


class RatioDiagnosisTests(SimpleTestCase):
    """比例不支持。**必须排在"模型名"前面** —— 这类报文里往往同时出现模型名。"""

    def test_apimart_real_message(self):
        """实测原话。里面有 `gemini-3.1-flash-image-preview` 这个完全正确的模型名,
        先判模型名会把人送去改它。"""
        self.assertEqual(diagnose(
            'HTTP 400: {"error":{"code":"invalid_request_error","message":'
            '"unsupported image aspect ratio \\"9:21\\", gemini-3.1-flash-image-preview '
            'supported ratios: 16:9, 1:1, 21:9, 9:16, auto","type":"invalid_request_error"}}'
        ), "ratio")

    def test_other_phrasings(self):
        for text in (
            "HTTP 400: invalid size for this model",
            "HTTP 400: 该模型不支持的比例",
            'HTTP 422: {"detail":"unsupported image size"}',
        ):
            with self.subTest(text=text):
                self.assertEqual(diagnose(text), "ratio")

    def test_does_not_swallow_plain_model_errors(self):
        """没提比例的模型名错误还是 model —— 新规则不能把它抢走。"""
        self.assertEqual(diagnose('HTTP 404: {"error":{"code":"model_not_found"}}'), "model")
