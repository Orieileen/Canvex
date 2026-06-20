"""
图片生成服务通用工具函数（Canvex studio 子集）。

从 meired apps.listings.services.utils 摘出 canvas 链路实际依赖的部分：
环境变量读取、图片下载、OpenAI 兼容响应解析、异步任务轮询、源图下载异常。

未搬运的 listings 专属函数（canvas 不用）：clean_llm_json / compress_image /
save_image_to_public_url（依赖 spapi.to_abs_media）/ retry_on_request_error /
env_json / generate_image_via_channel / generate_with_fallback。
"""

import base64
import logging
import os
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

# ── 完成 / 失败状态集合（轮询用） ────────────────────────────────────────────

DONE_STATUSES = {"completed", "succeeded", "success"}
FAILED_STATUSES = {"failed", "failure", "error", "cancelled", "canceled"}


# ── 环境变量读取 ──────────────────────────────────────────────────────────────


def env(key: str, default: str = "") -> str:
    """读取字符串环境变量，自动 strip。"""
    return os.getenv(key, default).strip()


def env_int(key: str, default: int) -> int:
    """读取整型环境变量。"""
    raw = os.getenv(key, "").strip()
    return int(raw) if raw.isdigit() else default


def env_bool(key: str, default: bool = False) -> bool:
    """读取布尔环境变量，支持 true/1/yes（不区分大小写）。"""
    raw = os.getenv(key, "").strip().lower()
    if not raw:
        return default
    return raw in ("true", "1", "yes")


# ── 图片处理工具 ──────────────────────────────────────────────────────────────


def resolve_image_bytes(image_url: str, timeout: int = 60) -> bytes:
    """从 URL 或 data URI 获取图片原始字节。"""
    if not image_url:
        raise ValueError("image_url is empty")
    if image_url.startswith("data:"):
        try:
            header, b64_data = image_url.split(",", 1)
        except ValueError as exc:
            raise ValueError("Invalid data URI") from exc
        if "base64" not in header:
            raise ValueError("Unsupported data URI encoding")
        return base64.b64decode(b64_data)
    resp = requests.get(image_url, timeout=timeout)
    resp.raise_for_status()
    return resp.content


# ── 响应解析 ──────────────────────────────────────────────────────────────────


def _response_field(item: Any, key: str) -> Any:
    """dict / object 通用字段访问。"""
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)


def _extract_image_bytes_from_item(item: Any) -> bytes | None:
    """从单个响应条目提取图片字节。"""
    for key in ("b64_json", "b64", "base64", "image_base64", "result"):
        val = _response_field(item, key)
        if not isinstance(val, str) or not val.strip():
            continue
        token = val.strip()
        if token.startswith(("http://", "https://")):
            return resolve_image_bytes(token)
        if token.startswith("data:") and "," in token:
            token = token.split(",", 1)[1]
        try:
            return base64.b64decode("".join(token.split()))
        except Exception:
            continue

    for key in ("url", "image_url"):
        val = _response_field(item, key)
        if isinstance(val, str) and val.strip():
            logger.info("image_response: no inline base64, downloading from URL")
            return resolve_image_bytes(val.strip())

    return None


def extract_image_bytes_from_response(response: Any) -> bytes:
    """
    从 OpenAI 兼容图片响应中提取图片字节。
    优先读取 b64_json，回退到 URL 下载。
    支持嵌套的 images 列表结构。
    """
    data = (
        response.get("data")
        if isinstance(response, dict)
        else getattr(response, "data", None)
    )
    if not isinstance(data, list) or not data:
        raise ValueError("image response data is empty")

    item = data[0]
    result = _extract_image_bytes_from_item(item)
    if result:
        return result

    # 兼容嵌套 images 结构
    nested = _response_field(item, "images")
    if isinstance(nested, list):
        for nested_item in nested:
            result = _extract_image_bytes_from_item(nested_item)
            if result:
                return result

    raise ValueError("image response did not contain b64_json or url")


# ── 源图下载异常 ──────────────────────────────────────────────────────────────


class SourceImageDownloadError(Exception):
    """inline_image 通道拉取源图失败 (源 CDN 抖动 / 签名 URL 过期 / 4xx/5xx)。

    刻意不复用 requests.HTTPError: provider 生成接口返回的"确定性 4xx"上层会
    fail-fast 不重试 (重发同 payload 也一样失败); 源图拉取失败是另一回事 ——
    transient, 该重试 / escalate fallback。独立类型让它走 transient 分支。
    """


# ── 异步任务轮询 ──────────────────────────────────────────────────────────────


def extract_task_id(response: Any) -> str:
    """从 images.generations 响应中提取异步任务 ID。"""
    data = (
        response.get("data")
        if isinstance(response, dict)
        else getattr(response, "data", None)
    )
    if isinstance(data, list) and data:
        item = data[0] if isinstance(data[0], dict) else None
        if item:
            for key in ("task_id", "id", "job_id", "image_id"):
                val = item.get(key)
                if val is not None and str(val).strip():
                    return str(val).strip()
    # 顶层字段
    if isinstance(response, dict):
        for key in ("task_id", "id", "job_id"):
            val = response.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
    return ""


def poll_task(
    task_id: str,
    api_key: str,
    poll_url: str,
    max_attempts: int = 60,
    interval: int = 5,
    req_timeout: int = 30,
) -> bytes:
    """
    轮询异步任务直到完成/失败/超时，返回图片字节。

    参数:
        task_id:      异步任务 ID
        api_key:      Bearer 鉴权密钥
        poll_url:     轮询基础 URL（会拼接 /tasks/{task_id}）
        max_attempts: 最大轮询次数
        interval:     轮询间隔秒数
        req_timeout:  单次 HTTP 请求超时秒数
    """
    status_url = f"{poll_url.rstrip('/')}/tasks/{task_id}"
    headers = {"Authorization": f"Bearer {api_key}"}

    for attempt in range(max_attempts):
        try:
            resp = requests.get(status_url, headers=headers, timeout=req_timeout)
            resp.raise_for_status()
            result = resp.json()
        except requests.exceptions.RequestException as e:
            logger.warning("poll_async: request failed, retrying: error=%s", e)
            time.sleep(interval)
            continue

        # 提取状态
        status = ""
        data = result.get("data", {})
        if isinstance(data, dict):
            for key in ("status", "state", "phase"):
                val = data.get(key)
                if val is not None and str(val).strip():
                    status = str(val).strip().lower()
                    break

        logger.info(
            "Task %s status: %s, attempt %d/%d",
            task_id, status, attempt + 1, max_attempts,
        )

        if status in DONE_STATUSES:
            try:
                return extract_image_bytes_from_response(result)
            except (ValueError, KeyError):
                pass
            # 嵌套: data.result.images[].url
            if isinstance(data, dict):
                res = data.get("result", {})
                images = res.get("images", []) if isinstance(res, dict) else []
                if isinstance(images, list) and images:
                    first = images[0]
                    if isinstance(first, dict):
                        url_val = first.get("url")
                        if isinstance(url_val, list) and url_val:
                            url_val = url_val[0]
                        if isinstance(url_val, str) and url_val.startswith("http"):
                            return resolve_image_bytes(url_val.strip())
            raise RuntimeError("任务完成但无法提取图片数据")

        if status in FAILED_STATUSES:
            error_msg = ""
            if isinstance(data, dict):
                for key in ("fail_reason", "error", "message"):
                    val = data.get(key)
                    if val is not None and str(val).strip():
                        error_msg = str(val).strip()
                        break
            raise RuntimeError(f"异步任务失败: {error_msg or 'unknown error'}")

        time.sleep(interval)

    raise TimeoutError(
        f"Task {task_id} did not complete within {max_attempts * interval}s"
    )


def handle_poll_if_needed(
    response: Any,
    poll_enabled: bool,
    api_key: str,
    poll_url: str,
    max_attempts: int = 60,
    interval: int = 5,
    req_timeout: int = 30,
) -> bytes:
    """
    从 images.generations 响应中提取图片。
    若开启轮询且响应不含图片数据，则提取 task_id 进入轮询。

    参数:
        response:     images.generations 的原始 JSON 响应
        poll_enabled: 是否开启异步轮询
        api_key:      轮询鉴权密钥
        poll_url:     轮询基础 URL
        max_attempts: 最大轮询次数
        interval:     轮询间隔秒数
        req_timeout:  单次请求超时秒数
    """
    # 先尝试直接提取图片（同步响应）
    try:
        return extract_image_bytes_from_response(response)
    except (ValueError, KeyError):
        pass

    if not poll_enabled:
        raise ValueError("响应不含图片数据且未开启轮询")

    # 异步响应：提取 task_id → 轮询
    task_id = extract_task_id(response)
    if not task_id:
        raise ValueError("响应不含图片数据，且无法提取 task_id")

    logger.info("async_task detected, polling: task_id=%s, poll_url=%s", task_id, poll_url)
    return poll_task(
        task_id=task_id,
        api_key=api_key,
        poll_url=poll_url,
        max_attempts=max_attempts,
        interval=interval,
        req_timeout=req_timeout,
    )
