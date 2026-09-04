"""「交给供应商之前必须先把源图变成这家收得下的形状」—— 这条约定的回归测试。

为什么值得一个测试: job 行上存的 `image_urls` 是
`http://localhost:28000/media/...` —— 两个建 job 的入口 (services/video.py:37 和
agent/tools/video.py:148) 都是**拿「提交时会内联」当前提**, 才敢把一个外部不可达的地址
存进库。这条前提不成立时的表现不是报错, 而是供应商回一句"我抓不到你的图" —— 看起来
像通道配错了。

"收得下的形状"分两种, 由通道自己说了算 (source_for_channel):
- 不填 upload_path → 内联成 data URI。绝大多数生图端点收 base64, 自托管不需要公网地址。
- 填了 upload_path → 先把字节推给供应商换一个它托管的公开 URL。apimart 的**视频**端点
  只认这种 (文档明写不收 base64, 而 image_urls 又要求公网可达)。

历史上模板通道那条分支两件都没做, 把 `http://localhost:28000/...` 原样发了出去, 而后端
对整条约定零覆盖, 所以它能一直躺着。现在变形提到了分流之上, 这里钉住两条分支都拿到
变形后的形状。

用 SimpleTestCase: 把碰库 (通道解析 / 健康记录) 和碰网 (发请求) 的部分都换掉, 只留下
"源图从 job 行到请求体经过了什么"这一件事。
"""
import contextlib
from unittest import mock

from django.test import SimpleTestCase

from studio.models import ImageProvider, VideoJob
from studio.services.agent.tools import common as common_mod
from studio.services.agent.tools import video as video_mod
from studio.services.image_client import ImageChannel

# 库里真实存过的形状 (2026-09-03 那条 FAILED 的 sora-2 任务就是它)。
LOCAL_URL = "http://localhost:28000/media/library/2026/08/30/deadbeef.png"
INLINED = "data:image/png;base64,AAAA"
PUBLIC_URL = "https://cdn.example.com/a.png"
UPLOADED = "https://upload.provider.invalid/f/image/xyz.png"


class _FakeJob:
    """job_lifecycle 只用到 .Status / .status / .error / .save() —— 不需要真行。"""

    Status = VideoJob.Status

    def __init__(self, image_urls):
        self.id = "test-job"
        self.prompt = "动起来"
        self.image_urls = list(image_urls)
        self.duration = 4
        self.aspect_ratio = "16:9"
        self.resolution = ""
        self.image_model_id = None
        self.status = VideoJob.Status.QUEUED
        self.error = ""
        self.task_id = ""
        self.result_url = ""
        self.thumbnail_url = ""

    def save(self, update_fields=None):
        pass


def _channel(kind, **extra):
    return ImageChannel(
        base_url="https://provider.invalid/v1", api_key="k", model="m",
        kind=kind, label="测试通道", provider_id="p1", **extra,
    )


@contextlib.contextmanager
def _no_db_no_net(channel):
    """通道解析 / 健康记录 / 读盘 / 上传 / 可达性预检 全换掉。

    **不**打桩 source_for_channel 本身 —— "该内联还是该上传"正是要测的那个判断, 桩打在
    它下面那两个原语上, 这样测的是真的分派逻辑。"""
    with mock.patch.object(video_mod, "resolve_video_channel", lambda job: channel), \
         mock.patch.object(video_mod.channel_health, "watch",
                           lambda ch: contextlib.nullcontext()), \
         mock.patch.object(common_mod, "source_to_inline_uri",
                           lambda u: INLINED if u == LOCAL_URL else u), \
         mock.patch.object(common_mod, "upload_source_to_provider",
                           lambda ref, **kw: UPLOADED if ref == LOCAL_URL else ref), \
         mock.patch.object(video_mod, "assert_source_url_reachable", lambda u: None):
        yield


class _Resp:
    status_code = 200

    def json(self):
        return {"task_id": "t1"}


class VideoSourceInlineTests(SimpleTestCase):
    def _run_template(self, job, channel):
        """跑模板分支, 返回喂给模板的变量表。"""
        sent = {}

        def fake_execute(ch, variables, **kw):
            sent.update(variables)
            return {"url": "https://x/v.mp4"}

        with _no_db_no_net(channel), \
             mock.patch.object(video_mod.template_client, "execute", fake_execute), \
             mock.patch.object(video_mod.template_client, "item_to_url", lambda item: item["url"]):
            video_mod.run_video_job(job)
        return sent

    def _run_builtin(self, job, channel):
        """跑内置分支, 返回真正 POST 出去的 body。"""
        sent = {}

        def fake_post(url, **kw):
            sent.update(kw.get("json") or {})
            return _Resp()

        with _no_db_no_net(channel), \
             mock.patch.object(video_mod._session, "post", fake_post), \
             mock.patch.object(video_mod, "_poll_until_done", lambda tid, ch: {"url": "https://x/v.mp4"}):
            video_mod.run_video_job(job)
        return sent

    # ── 通道要求公网地址时: 先上传, 发回来的那个 URL ────────────────────────
    #    apimart 视频就是这条 —— 实测发 data: URI 会被 400 顶回来:
    #    "Only http/https URLs or asset:// private asset URLs are supported."
    def test_channel_with_upload_path_sends_the_uploaded_url(self):
        channel = _channel(
            ImageProvider.Kind.CUSTOM_VIDEO,
            upload_path="/uploads/images",
            request_template={"body": {"image_urls": "{{images}}"}},
        )
        sent = self._run_template(_FakeJob([LOCAL_URL]), channel)
        self.assertEqual(sent["images"], [UPLOADED])
        self.assertNotIn("localhost", str(sent["images"]))
        self.assertNotIn("data:", str(sent["images"]))

    # ── 模板通道 (custom_video): 就是当初漏掉的那条 ──────────────────────────
    def test_template_channel_gets_data_uri_not_our_localhost(self):
        channel = _channel(
            ImageProvider.Kind.CUSTOM_VIDEO,
            request_template={"url": "{{base_url}}/videos/generations",
                              "body": {"image_urls": "{{images}}"}},
        )
        sent = self._run_template(_FakeJob([LOCAL_URL]), channel)
        # {{images}} 拿到的就是这个 —— template_client 对它是原样透传 (只有
        # {{images_base64}} 才会去下载, 而那条对本机地址同样抓不到)。
        self.assertEqual(sent["images"], [INLINED])
        self.assertEqual(sent["image"], INLINED)
        self.assertNotIn("localhost", str(sent["images"]))

    # ── 内置通道 (video): 本来就对, 钉住别被改回去 ──────────────────────────
    def test_builtin_channel_gets_data_uri_not_our_localhost(self):
        channel = _channel(ImageProvider.Kind.VIDEO)
        body = self._run_builtin(_FakeJob([LOCAL_URL]), channel)
        self.assertEqual(body["image_urls"], [INLINED])
        self.assertNotIn("localhost", str(body["image_urls"]))

    # ── 外部公网图: 不该被动 ────────────────────────────────────────────────
    def test_public_url_passes_through_untouched(self):
        channel = _channel(
            ImageProvider.Kind.CUSTOM_VIDEO,
            request_template={"body": {"image_urls": "{{images}}"}},
        )
        sent = self._run_template(_FakeJob([PUBLIC_URL]), channel)
        self.assertEqual(sent["images"], [PUBLIC_URL])

    # ── 纯文生视频: 内置分支不该多发一个空的 image_urls 键 ──────────────────
    def test_no_source_image_omits_the_key(self):
        body = self._run_builtin(_FakeJob([]), _channel(ImageProvider.Kind.VIDEO))
        self.assertNotIn("image_urls", body)

    # ── 外部图不可达时 fail loud, 而不是静默退化成纯文生视频 ────────────────
    def test_unreachable_public_url_fails_loud(self):
        channel = _channel(ImageProvider.Kind.CUSTOM_VIDEO,
                           request_template={"body": {"image_urls": "{{images}}"}})
        job = _FakeJob([PUBLIC_URL])
        boom = RuntimeError(f"source URL unreachable: {PUBLIC_URL}")

        def blow_up(url):
            raise boom

        with mock.patch.object(video_mod, "resolve_video_channel", lambda j: channel), \
             mock.patch.object(video_mod.channel_health, "watch",
                               lambda ch: contextlib.nullcontext()), \
             mock.patch.object(common_mod, "source_to_inline_uri", lambda u: u), \
             mock.patch.object(video_mod, "assert_source_url_reachable", blow_up), \
             mock.patch.object(video_mod.template_client, "execute",
                               lambda *a, **k: self.fail("不该走到发请求这一步")):
            with self.assertRaises(RuntimeError):
                video_mod.run_video_job(job)
        self.assertEqual(job.status, VideoJob.Status.FAILED)
        self.assertIn("unreachable", job.error)
