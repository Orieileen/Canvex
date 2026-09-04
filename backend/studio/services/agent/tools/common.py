"""Shared helpers for canvas LLM tools (Canvex 独立版).

Mostly pure functions. `absolute_media_url` reads `settings.PUBLIC_MEDIA_BASE`,
`job_lifecycle` writes job rows, and `enqueue_on_commit` schedules a Celery
task to fire when the surrounding tx commits. Import-safe at module top.

从 meired apps/canvas/services/agent/tools/common.py port:
- 纯工具原样保留(import 路径改写)。
- 落库层 library.Asset/Folder → Canvex 的 DataAsset/DataFolder(单工作区,无
  organization/user)。DataAsset 的元数据(width/height/mime/size/tags)逻辑融自
  studio/tools/assets.py 的 _save_asset。
- meired 的 enqueue_scope_or_friendly_message(跨 org 计费/资产泄漏防护)不 port:
  Scene 已无 organization,单工作区无跨租户面。
"""
import base64
import hashlib
import io
import ipaddress
import logging
import os
import socket
import uuid
from contextlib import contextmanager
from typing import Iterable, Iterator, Sequence
from urllib.parse import unquote, unquote_to_bytes, urljoin, urlparse

import requests
from django.conf import settings
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import IntegrityError, transaction
from PIL import Image

from studio.models import DataAsset, DataFolder
from studio.services.http_retry import make_retry_session

logger = logging.getLogger(__name__)

DOWNLOAD_TIMEOUT = 60

# TextField 理论无限, 但防 API 异常字符串带巨量 stack trace
_ERROR_TRUNC = 5000


def decode_image_payload(item: dict) -> bytes:
    """One data-item from an OpenAI-compatible /images/generations response → bytes.

    Accepts either `b64_json` (e.g. gpt-image-1) or `url` (DALL-E, some providers).
    Raises ValueError if neither is present.
    """
    if b64 := item.get("b64_json"):
        return base64.b64decode(b64)
    if url := item.get("url"):
        resp = requests.get(url, timeout=DOWNLOAD_TIMEOUT)
        resp.raise_for_status()
        return resp.content
    raise ValueError(
        f"image response item missing 'b64_json' and 'url' (keys={list(item.keys())})"
    )


def extract_images_from_response(response: dict) -> list[bytes]:
    """Full response from ImageClient.generate() → list of raw image bytes."""
    data = response.get("data") or []
    if not data:
        raise ValueError("image generation response has empty 'data' array")
    return [decode_image_payload(item) for item in data]


def bytes_to_django_file(data: bytes, filename: str) -> ContentFile:
    """Wrap raw bytes so Django ImageField.save(...) can store them directly."""
    return ContentFile(data, name=filename)


@contextmanager
def job_lifecycle(
    job,
    *,
    success_extra_fields: Sequence[str] = (),
) -> Iterator[None]:
    """Wrap a job executor in QUEUED → RUNNING → SUCCEEDED | FAILED state flips.

    - On enter: flip status to RUNNING + save.
    - On normal exit: flip to SUCCEEDED, save (including any `success_extra_fields`
      the caller set inside the block, e.g. `result_url` / `thumbnail_url`).
    - On exception: flip to FAILED, persist truncated `str(exc)` as `job.error`,
      re-raise so callers (Celery task / billing wrapper) can roll back.

    `job` must have a `.Status` TextChoices with RUNNING/SUCCEEDED/FAILED, plus
    `.status`, `.error`, `.updated_at` fields and Meta + save().
    """
    Status = type(job).Status
    job.status = Status.RUNNING
    job.save(update_fields=["status", "updated_at"])
    try:
        yield
    except Exception as exc:
        job.status = Status.FAILED
        job.error = str(exc)[:_ERROR_TRUNC]
        job.save(update_fields=["status", "error", "updated_at"])
        logger.exception("%s failed: %s", type(job).__name__, job.id)
        raise
    job.status = Status.SUCCEEDED
    job.save(update_fields=[*success_extra_fields, "status", "updated_at"])
    logger.info("%s succeeded: %s", type(job).__name__, job.id)


def enqueue_on_commit(job, task) -> str:
    """Schedule `task.apply_async(args=[job.id])` to run once the enclosing
    DB tx commits. Returns the stringified job id for logging/confirmation.

    The lambda captures `job_id` (a str) by value so subsequent job mutations
    don't affect what the worker picks up. Callers must create `job` inside
    the request's tx (Django ATOMIC_REQUESTS or an explicit `transaction.atomic`)
    for on_commit to actually defer — in autocommit mode it fires immediately,
    which is also correct (row already visible).
    """
    job_id = str(job.id)
    transaction.on_commit(lambda: task.apply_async(args=[job_id]))
    return job_id


def is_public_http_url(url: str) -> bool:
    """Reject private-network URLs before they reach an external provider.

    SSRF vector: external video / image providers fetch any URL we give them
    (agent `generate_video` args; direct `POST /video/` `image_urls`). Without
    this filter, a malicious user can coax the provider into probing
    169.254.169.254 (AWS IMDS), 127.0.0.1, 10.x/172.16.x/192.168.x, or
    internal k8s / service DNS — a blind SSRF pivot.

    Domain hosts are DNS-resolved and the resolved IP is checked too, so
    `http://intranet.example.com` pointing at 10.0.0.1 is rejected.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # host 是域名, DNS 解析后核对
        try:
            resolved = socket.gethostbyname(host)
            ip = ipaddress.ip_address(resolved)
        except (socket.gaierror, ValueError):
            return False
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def is_gevent_patched() -> bool:
    """True if this process has been gevent-monkeypatched (socket patched).

    Blocking CPU work (rembg) and asyncio-driven work both
    freeze / deadlock the event loop under a --pool=gevent worker, so callers
    check this and fail loud instead of hanging. Detection is shared here; each
    caller keeps its own exception type + remediation message.
    """
    try:
        from gevent.monkey import is_module_patched  # noqa: PLC0415 — runtime check
    except Exception:  # gevent not installed in this process → not patched
        return False
    return is_module_patched("socket")


def _public_media_base() -> str:
    """读 PUBLIC_MEDIA_BASE。优先 settings(meired 契约),回落 os.getenv。

    settings.py 已定义 PUBLIC_MEDIA_BASE(dev 默认 localhost:28000);这里仍 getattr
    软读 + getenv 兜底 + blank 时 raise,是为了防止它被改没时早炸(而非 AttributeError
    把整个 import/请求打崩)。生产必须配成 ngrok / CDN / 真实公网 host(见
    absolute_media_url docstring)。
    """
    base = getattr(settings, "PUBLIC_MEDIA_BASE", None)
    if not base:
        base = os.getenv("PUBLIC_MEDIA_BASE", "").strip()
    if not base:
        raise RuntimeError("PUBLIC_MEDIA_BASE is not configured")
    return base


def get_or_create_canvas_scene_folder(scene) -> DataFolder:
    """`Canvas/<scene.title>/` 文件夹(DataFolder), canvas job 产物全部落到这里.

    两层 nesting: 顶层 "Canvas" 把所有 canvas 产物聚成一组, 子层按 scene
    组织. scene.title 重命名后老 asset 留在旧 folder 里 (用户接受 trade-off:
    自己根据文件名 canvas-<job-id>-<i>.png 找).

    Canvex 单工作区: DataFolder 无 organization/user, get_or_create 只按
    (parent, name) —— 正好对上 DataFolder 的 unique_together。并发写经
    IntegrityError 回退查询避免竞态(同 studio/tools/assets.py 的处理)。
    """
    canvas_root = _get_or_create_folder("Canvas", None)
    title = (scene.title or "Untitled scene")[:200]
    folder = _get_or_create_folder(title, canvas_root)
    # 顶层 "Canvas" 与子层 title 都非空 → _get_or_create_folder 必返非 None。
    return folder


def _get_or_create_folder(name: str, parent: DataFolder | None) -> DataFolder | None:
    """按 (parent, name) 取或建 DataFolder;并发写经 IntegrityError 回退查询。"""
    if not name:
        return None
    try:
        folder, _ = DataFolder.objects.get_or_create(parent=parent, name=name)
        return folder
    except IntegrityError:
        return DataFolder.objects.filter(parent=parent, name=name).first()


def persist_bytes_to_asset(
    *,
    folder,
    image_bytes: bytes,
    display_filename: str,
    ext: str = "png",
) -> DataAsset:
    """Save image bytes as a DataAsset under the given folder.

    `display_filename` 是人类可读名,落在 DataAsset.alt_text(供 admin / 库 UI 识别)。
    DataAsset 的 (folder, filename) 是 unique_together, 所以 on-disk + DB filename
    一律用 UUID 防撞(同名重传 / 同一 scene 多 job 不会触发 IntegrityError)。
    width/height 用 PIL header 读取;mime/size/tags 元数据补齐(融自 assets._save_asset)。
    Caller wraps in a transaction if the call needs to be atomic with sibling
    rows (see `persist_canvas_image_results`).
    """
    width = height = None
    try:
        with Image.open(io.BytesIO(image_bytes)) as im:
            width, height = im.size
    except Exception:
        pass

    saved_name = f"{uuid.uuid4().hex}.{ext}"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return DataAsset.objects.create(
        folder=folder,
        file=bytes_to_django_file(image_bytes, saved_name),
        filename=saved_name,
        mime_type=mime,
        size_bytes=len(image_bytes),
        width=width,
        height=height,
        alt_text=display_filename[:255],
        tags=["canvas", "ai"],
        is_public=False,
    )


def persist_canvas_image_results(
    job,
    image_bytes_list: Iterable[bytes],
    *,
    result_model,
    filename_prefix: str,
) -> list:
    """原始 image bytes → DataAsset + canvas 结果行, 一个原子 tx 兜底.

    image-edit / angle 两条路径最后都落同样的形状 (DataAsset + <Result> order=i),
    所以抽到这里. `result_model` 必须是带 (job, asset, order) 三个字段的 Django
    模型 (ImageEditResult / AngleResult), asset FK 指向 DataAsset.
    """
    results: list = []
    with transaction.atomic():
        folder = get_or_create_canvas_scene_folder(job.scene)
        for i, img_bytes in enumerate(image_bytes_list):
            asset = persist_bytes_to_asset(
                folder=folder,
                image_bytes=img_bytes,
                display_filename=f"{filename_prefix}-{job.id}-{i}.png",
            )
            results.append(result_model.objects.create(job=job, asset=asset, order=i))
    return results


def absolute_media_url(media_url: str) -> str:
    """Relative `/media/.../x.png` → absolute `https://host/media/.../x.png`.

    第三方 API (图片 / 视频生成) 需要公网可达的 URL, 浏览器拉 `result_url` 下载图
    blob 同样需要 —— 两者都走 `settings.PUBLIC_MEDIA_BASE`. dev 默认 localhost:8000
    (外部 API 拿不到, 测试时 mock); 生产必须设成 ngrok / CDN / 真实公网 host.
    如果 media_url 已经是绝对 URL (例如 MEDIA_URL 指到 S3), 原样返.
    """
    if media_url.startswith(("http://", "https://")):
        return media_url
    # urljoin 需要 base 带 trailing slash 才能把它当目录拼接, 否则它会吃掉最后一段
    base = _public_media_base().rstrip("/") + "/"
    return urljoin(base, media_url.lstrip("/"))


def our_media_relpath(url: str) -> str | None:
    """If `url` points at our own media (served under `MEDIA_URL`), return the
    storage-relative path; otherwise None.

    Matches on the URL's *path* component, so both `/media/x.png` and an
    absolute `http://localhost:28000/media/x.png` resolve to the same storage
    key `x.png` — a dev/localhost URL the worker can't HTTP-fetch still maps to
    a direct storage read. A remote CDN URL (MEDIA_URL points at S3/qiniu, or
    the path has no `/media/` prefix) returns None → the caller passes it through
    for the provider to fetch."""
    media_path = urlparse(settings.MEDIA_URL).path or settings.MEDIA_URL
    if not media_path.startswith("/"):
        return None  # MEDIA_URL is a remote base (S3/qiniu) — not local storage
    path = unquote(urlparse(url).path)
    if path.startswith(media_path):
        return path[len(media_path):]
    return None


def _read_source_bytes(ref) -> bytes:
    """Local source bytes via storage (no HTTP). `ref` = Django FieldFile or a
    storage-relative path string."""
    if hasattr(ref, "open"):  # FieldFile
        ref.open("rb")
        try:
            return ref.read()
        finally:
            ref.close()
    with default_storage.open(ref, "rb") as fh:  # storage-relative path
        return fh.read()


def _source_bytes(ref) -> bytes | None:
    """能读到字节就返字节; 读不到 (外部公网 URL) 返 None —— 那种原样交给供应商就行。

    **"一个 ref 是什么"只在这里判一次。** `source_to_inline_uri` (内联那条路) 和
    `upload_source_to_provider` (上传那条路) 都从这儿拿字节, 所以同一张图在两条路上
    必然被认成同一种东西。分成两份判的话, "配没配 upload_path"会变成一个悄悄改变**失败
    方式**的开关 —— 同一个源, 一条路上是 warning + 透传, 另一条是 job FAILED。
    """
    if not isinstance(ref, str):
        return _read_source_bytes(ref)  # FieldFile
    if ref.startswith("data:"):
        # `;base64,` 不是 data URI 的必选项 —— `data:image/svg+xml,<svg …>` 是合法的,
        # 而对它 b64decode 拿到的是垃圾字节或者一个 binascii.Error。逗号也可能没有。
        head, sep, payload = ref.partition(",")
        if not sep:
            raise ValueError(f"data URI 里没有逗号, 取不到内容: {ref[:64]}")
        return base64.b64decode(payload) if ";base64" in head else unquote_to_bytes(payload)
    is_url = ref.startswith(("http://", "https://"))
    rel = our_media_relpath(ref)
    if rel is not None:
        try:
            return _read_source_bytes(rel)
        except (FileNotFoundError, OSError) as exc:
            if is_url:
                # 同 source_to_inline_uri: 绝对 URL 读盘落空 → 交给供应商自己试一次。
                logger.warning("source bytes: storage read failed for %r (%s); passthrough", rel, exc)
                return None
            raise  # 根相对 /media 路径而文件不在 → fail loud
    if is_url:
        return None  # 外部公网图, 供应商自己抓得到
    return _read_source_bytes(ref)  # 裸 storage 路径


def source_to_inline_uri(ref) -> str:
    """Any canvas image source → `data:image/...;base64,...` whenever we can read
    it from our own storage, so providers never need a public URL / tunnel.

    - FieldFile / storage-relative path → read storage → data URI
    - our-media http(s) URL (under MEDIA_URL, incl. an unreachable localhost dev
      URL) → strip to storage path → read storage → data URI
    - already a `data:` URI → returned unchanged
    - external http(s) URL (public CDN, not our media) → passthrough; the
      provider fetches it directly (caller still asserts reachability)

    只对能从本地 storage 读到字节的源内联;读不到(远程 CDN / 外部 URL)原样返,
    交给 provider 自己 fetch —— 自托管开箱即用,无需 ngrok / PUBLIC_MEDIA_BASE。

    上面那张分类表**不在这里实现** —— 它在 `_source_bytes` 里, 上传那条路也读同一份。
    """
    from studio.services.image_client import bytes_to_data_uri  # noqa: PLC0415 — avoid import cycle

    # 已经是 data URI: 直接返回, 别解码再编码一遍。
    if isinstance(ref, str) and ref.startswith("data:"):
        return ref
    data = _source_bytes(ref)
    return bytes_to_data_uri(data) if data is not None else ref


# 上传的图在供应商那边存 72 小时 (apimart 文档)。缓存留足余量, 免得刚过期就拿去用。
_UPLOAD_CACHE_SECONDS = 12 * 3600

# 上传走跟生成同一套重试 (5xx/429/连接抖动都值得再试一次) —— 一次瞬时故障不该把一条
# 已经排到队、马上要花几分钟的视频任务整条打掉。同 agent/tools/video.py 的 `_session`。
_upload_session = make_retry_session()


def upload_source_to_provider(
    ref, *, base_url: str, api_key: str, path: str,
    result_path: str = "url", timeout: int = 120,
) -> str:
    """一张画布图 → **供应商自己托管**的公开 URL(multipart 推上去, 换回一个地址)。

    为什么需要这条路: 有的端点既不收 base64, 又要求图片地址公网可达 —— 而自托管的
    `http://localhost:28000/media/...` 供应商永远抓不到。这两条同时成立时, 内联和
    "配个公网 media" 都不成立, 只剩"我们主动把字节推过去"。apimart 的视频端点就是这种
    (文档: 「不再支持在生成接口中直接传入 base64,请使用本接口上传图片」)。

    方向很重要: **是我们往外发请求**, 跟调用生成接口同一个方向。本机不需要被任何人
    访问, 不需要隧道, 也不需要把 /media/ 暴露出去。

    同一张图重复生成很常见 (改一版提示词再跑), 所以按内容哈希缓存一段时间 —— 供应商
    那边的地址有有效期, 缓存时长取得比它短得多。缓存不可用时只是多传一次, 不影响正确性。
    """
    from studio.services.request_template import extract  # noqa: PLC0415 — 避免 import 环

    data = _source_bytes(ref)
    if data is None:
        return ref  # 外部公网图: 不用经手

    key = "provider-upload:" + hashlib.sha256(
        f"{base_url}|{path}".encode() + data
    ).hexdigest()
    cached = cache.get(key)
    if cached:
        return cached

    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    resp = _upload_session.post(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": ("source.png", data, "image/png")},
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"上传参考图失败 HTTP {resp.status_code} ({url}): {resp.text[:500]}"
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"上传参考图: 回包不是 JSON ({url}): {exc}") from exc
    got = extract(payload, result_path or "url")
    if not isinstance(got, str) or not got.startswith(("http://", "https://")):
        raise RuntimeError(
            f"上传参考图: 按 `{result_path or 'url'}` 没取到 http 地址, 回包是 "
            f"{str(payload)[:400]}"
        )
    cache.set(key, got, _UPLOAD_CACHE_SECONDS)
    logger.info("参考图已上传给供应商: %d bytes → %s", len(data), got)
    return got


def source_for_channel(channel, ref) -> str:
    """一张画布图 → **这条通道真的收得下**的形状。

    只有这一个函数知道该内联还是该上传, 所有生成路径都该走它 —— 之前"要不要内联"散在
    各条路径里, 结果视频的模板分支漏了一处, 把 `http://localhost:28000/...` 原样发给了
    供应商, 表现是供应商回一句"抓不到你的图", 看起来像通道配错了。

    - 通道填了 `upload_path` → 推给供应商换一个它托管的 URL (见上面那个函数)
    - 否则 → 内联成 data URI (绝大多数生图端点收 base64, 自托管无需公网地址)
    """
    up = (getattr(channel, "upload_path", "") or "").strip()
    if not up:
        return source_to_inline_uri(ref)
    return upload_source_to_provider(
        ref,
        base_url=channel.base_url,
        api_key=channel.api_key,
        path=up,
        result_path=getattr(channel, "upload_result_path", "") or "url",
        timeout=getattr(channel, "timeout", 120) or 120,
    )


_SOURCE_URL_HEAD_TIMEOUT_SECONDS = 5


def assert_source_url_reachable(url: str) -> None:
    """HEAD-check a source-image / source-video URL before handing it to a
    third-party provider. Raise on any non-2xx / transport error so the job
    fails loud (and credit gets rolled back in `_load_or_skip`) instead of the
    provider silently degrading to text-to-image / blank result.

    Shared between image / video / angle entry points. PUBLIC_MEDIA_BASE 配错
    (典型: ngrok 失效 / 域名指向别的项目) 时 provider 拿 404 后行为不可预测,
    很多 provider 实测会静默回 text-only 鬼图. 拒绝在我们这一端先发就解决问题.
    """
    try:
        resp = requests.head(url, timeout=_SOURCE_URL_HEAD_TIMEOUT_SECONDS, allow_redirects=True)
    except requests.RequestException as exc:
        logger.error("source URL unreachable (transport): %s (%s)", url, exc)
        raise RuntimeError(f"source URL unreachable: {url} ({exc})") from exc
    if resp.status_code >= 400:
        base = getattr(settings, "PUBLIC_MEDIA_BASE", None) or os.getenv("PUBLIC_MEDIA_BASE", "")
        logger.error(
            "source URL returned %d: %s (PUBLIC_MEDIA_BASE=%s)",
            resp.status_code, url, base,
        )
        raise RuntimeError(
            f"source URL returned {resp.status_code}: {url} — "
            f"check PUBLIC_MEDIA_BASE={base}"
        )
