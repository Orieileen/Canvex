"""聊天通道的协议开关。

**验的是"支不支持 tools 参数"** —— 聊天通道那句 untestable_reason 说的就是这件事:
一个不支持工具调用的模型会回一段 markdown 然后在画布上什么都不做, 而这跟"配错了"
看起来毫无区别。

不需要真 key: 用一个假的 `/v1/messages` 记下我们发了什么、回一个 tool_use 块。协议这层
本来就是"形状对不对"的问题, 而形状不需要花钱验。
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from django.test import SimpleTestCase
from langchain_core.tools import tool

from studio.services.agent.builder import CHAT_PROTOCOLS
from studio.services.image_channels import tunable_schema
from studio.services.image_client import CHAT_PROTOCOL_CHOICES


@tool
def paint(what: str) -> str:
    """画一张图。"""
    return "ok"


class _Handler(BaseHTTPRequestHandler):
    seen: dict = {}

    def do_POST(self):
        _Handler.seen = {
            "path": self.path,
            "auth_header": next(
                (k.lower() for k in self.headers
                 if k.lower() in ("x-api-key", "authorization")), ""),
            "body": json.loads(self.rfile.read(int(self.headers["content-length"]))),
        }
        body = json.dumps({
            "id": "msg_1", "type": "message", "role": "assistant",
            "model": "claude-test", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "tu_1", "name": "paint",
                         "input": {"what": "一只橘猫"}}],
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class ChatProtocolTests(SimpleTestCase):
    def test_known_protocols(self):
        """空串跟 "openai" 是同一条路 —— 绝大多数通道没填这一项。"""
        self.assertEqual(
            {k: v.__name__ for k, v in CHAT_PROTOCOLS.items()},
            {"": "_openai_model", "openai": "_openai_model", "anthropic": "_anthropic_model"},
        )

    def test_both_build_with_blank_base_url(self):
        """chat 通道的 base_url 允许留空 (= 官方端点)。空串必须变成 None ——
        两个 SDK 都把 None 当"用默认", 而空串是一个真的、空的地址。"""
        for proto in CHAT_PROTOCOLS:
            with self.subTest(proto=proto or "(留空)"):
                model = CHAT_PROTOCOLS[proto](
                    api_key="k", base_url=None, model="m",
                    max_retries=1, timeout=5, callbacks=[],
                )
                self.assertTrue(hasattr(model, "bind_tools"))

    def test_anthropic_shape_and_tool_calling(self):
        srv = HTTPServer(("127.0.0.1", 8913), _Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            model = CHAT_PROTOCOLS["anthropic"](
                api_key="sk-ant-fake", base_url="http://127.0.0.1:8913",
                model="claude-test", max_retries=1, timeout=10, callbacks=[],
            )
            reply = model.bind_tools([paint]).invoke("给我画一只橘猫")
        finally:
            srv.shutdown()

        seen = _Handler.seen
        self.assertEqual(seen["path"], "/v1/messages")
        # Anthropic 用 x-api-key, 不是 Bearer —— 协议接错时这里第一个露馅。
        self.assertEqual(seen["auth_header"], "x-api-key")
        # max_tokens 是 Anthropic 协议的必填项; 给窄了的表现是回答被拦腰截断。
        self.assertEqual(seen["body"]["max_tokens"], 8192)
        self.assertEqual(seen["body"]["tools"][0]["name"], "paint")
        # 最要紧的一条: 它回的 tool_use 块被读成了一次真正的工具调用。
        self.assertEqual(reply.tool_calls[0]["name"], "paint")
        self.assertEqual(reply.tool_calls[0]["args"], {"what": "一只橘猫"})


class ProtocolChoicesTests(SimpleTestCase):
    """下拉里能选的 = 分派表认得的。两边漂了的表现是"下拉里选得中的值, 一聊天就抛"。"""

    def test_choices_match_dispatch_table(self):
        self.assertEqual(set(CHAT_PROTOCOL_CHOICES), set(CHAT_PROTOCOLS))

    def test_blank_is_first(self):
        """空串排第一 = 表单里的默认项。挪到后面去的话, 新建的聊天通道会默认选中
        `openai` 那一项 —— 行为一样, 但存进库的值从"没配这项"变成了一个显式值。"""
        self.assertEqual(CHAT_PROTOCOL_CHOICES[0], "")

    def test_schema_sends_a_dropdown(self):
        """表单靠这个才知道渲染 select 而不是文本框。"""
        row = next(t for t in tunable_schema()["chat"]["tunables"] if t["key"] == "protocol")
        self.assertEqual(row["control"], "choice")
        self.assertEqual(row["choices"], list(CHAT_PROTOCOL_CHOICES))
