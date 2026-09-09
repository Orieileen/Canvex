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
from unittest import mock

from django.test import SimpleTestCase, TestCase

from studio.models import Scene
from studio.services.agent.builder import CanvasAgentInvocationError
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
        # 端口要 0 让内核分配, 别写死一个数: 写死的那个在 CI 上迟早撞上别人 (或者上一次
        # 跑剩的 TIME_WAIT), 表现是这条测试偶发 EADDRINUSE —— 跟协议本身毫无关系。
        srv = HTTPServer(("127.0.0.1", 0), _Handler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            model = CHAT_PROTOCOLS["anthropic"](
                api_key="sk-ant-fake", base_url=f"http://127.0.0.1:{port}",
                model="claude-test", max_retries=1, timeout=10, callbacks=[],
            )
            reply = model.bind_tools([paint]).invoke("给我画一只橘猫")
        finally:
            srv.shutdown()
            srv.server_close()      # shutdown 只停循环, 不放监听套接字

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


class ChatErrorStreamTests(TestCase):
    """聊天流炸掉的时候, `error` 事件里必须带着**供应商原话** + 诊断 code。

    以前这里发的是 `assistant_failed: {异常类名}`。表现: 用户在界面上只看到"回复失败"
    四个字一闪而过, 而"额度不足, 去后台充值"这句唯一能让他知道该干什么的话, 只进了
    服务器日志 —— 而会看 `docker compose logs` 的用户本来就不需要这句提示。

    `diagnosis` 是 code 不是话 (文案在前端 lib/channel-diagnosis), 跟通道卡片同一套。
    """

    #: 兔子/new-api 那家在余额为负时的真实报文, 从一次真实失败里抄下来的。
    _QUOTA_403 = (
        "agent stream failed: PermissionDeniedError: Error code: 403 - "
        "{'error': {'message': '用户额度不足, 剩余额度: ＄-0.088648', "
        "'type': 'new_api_error', 'code': 'insufficient_user_quota'}}"
    )

    def _stream(self, exc):
        scene = Scene.objects.create(title="t")
        with mock.patch("studio.views.stream_canvas_agent", side_effect=exc):
            resp = self.client.post(
                f"/api/v1/canvas/scenes/{scene.id}/chat/",
                data=json.dumps({"content": "hi"}),
                content_type="application/json",
            )
            body = b"".join(resp.streaming_content).decode()
        return [
            json.loads(line[len("data: "):])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]

    def test_error_event_carries_provider_text_and_diagnosis(self):
        events = self._stream(CanvasAgentInvocationError(self._QUOTA_403))

        error = next(e for e in events if e["event"] == "error")
        # 原话在里面 —— 这是用户唯一能照着做事的东西。
        self.assertIn("用户额度不足", error["detail"])
        self.assertIn("CanvasAgentInvocationError", error["detail"])
        self.assertEqual(error["diagnosis"], "quota")

    def test_error_turn_still_closes_the_stream(self):
        """失败也要发 `done`, 否则前端的流循环挂在那儿等。

        注意**不能**有 `assistant` 事件: 一轮没产出的对话不该在库里留一条空回复,
        那样刷新页面会看到一条"(空)"的助手消息。
        """
        events = self._stream(CanvasAgentInvocationError(self._QUOTA_403))
        kinds = [e["event"] for e in events]

        self.assertEqual(kinds[-1], "done")
        self.assertIn("error", kinds)
        self.assertNotIn("assistant", kinds)

    def test_unrecognised_error_still_ships_the_raw_text(self):
        """认不出的报错 → diagnosis 是空串, 但原话照发。

        诊断表跟不上供应商的措辞是常态; 那时候界面上少一句提示, 而不是少全部信息。
        """
        events = self._stream(CanvasAgentInvocationError("something nobody mapped yet"))

        error = next(e for e in events if e["event"] == "error")
        self.assertEqual(error["diagnosis"], "")
        self.assertIn("something nobody mapped yet", error["detail"])
