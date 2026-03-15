from __future__ import annotations

import json
import os
from typing import Any

import redis
SUMMARY_SCHEMA_VERSION = 1
MEMORY_SCHEMA_VERSION = 1
DEFAULT_TTL_SECONDS = int(os.getenv("SUMMARY_TTL_SECONDS", "2592000"))
SUMMARY_HISTORY_LIMIT = int(os.getenv("SUMMARY_HISTORY_LIMIT", "6"))
MEMORY_STABILITY_WINDOW = int(os.getenv("MEMORY_STABILITY_WINDOW", "3"))
MEMORY_STABILITY_MIN_COUNT = int(os.getenv("MEMORY_STABILITY_MIN_COUNT", "2"))


def _redis_url() -> str:
    """获取 Redis 连接地址。"""
    url = os.getenv("REDIS_URL", "").strip()
    if not url:
        raise RuntimeError("REDIS_URL is not configured")
    return url


def _client():
    """创建并返回一个 Redis 客户端实例，启用自动解码响应。"""
    return redis.from_url(_redis_url(), decode_responses=True)


def _summary_key(workspace_id: str, scene_id: str) -> str:
    """生成对话摘要在 Redis 中的存储键。"""
    return f"excalidraw:summary:{workspace_id}:{scene_id}"


def _summary_history_key(workspace_id: str, scene_id: str) -> str:
    """生成摘要历史记录在 Redis 中的存储键。"""
    return f"excalidraw:summary_history:{workspace_id}:{scene_id}"


def _memory_key(workspace_id: str, scene_id: str) -> str:
    """生成长期记忆在 Redis 中的存储键。"""
    return f"excalidraw:memory:{workspace_id}:{scene_id}"


def _get_json(key: str):
    """从 Redis 读取指定键的值并反序列化为 Python 对象，失败时返回 None。"""
    try:
        raw = _client().get(key)
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None


def _set_json(key: str, payload: Any, ttl: int | None = None):
    """将 Python 对象序列化为 JSON 并写入 Redis，支持可选的过期时间（秒）。"""
    ttl_value = DEFAULT_TTL_SECONDS if ttl is None else ttl
    try:
        data = json.dumps(payload, ensure_ascii=False)
        client = _client()
        if ttl_value > 0:
            client.setex(key, ttl_value, data)
        else:
            client.set(key, data)
    except Exception:
        return


def _normalize_list(value: Any) -> list[str]:
    """将任意输入规范化为去空白的字符串列表，过滤空值。"""
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                out.append(text)
        return out
    text = str(value).strip()
    return [text] if text else []


def normalize_summary_state(data: Any) -> dict[str, Any]:
    """将原始摘要数据规范化为标准结构，包含 goal、constraints、decisions、open_questions、next_actions 字段。"""
    payload = data if isinstance(data, dict) else {}
    return {
        "schema_version": SUMMARY_SCHEMA_VERSION,
        "goal": str(payload.get("goal") or "").strip(),
        "constraints": _normalize_list(payload.get("constraints")),
        "decisions": _normalize_list(payload.get("decisions")),
        "open_questions": _normalize_list(payload.get("open_questions")),
        "next_actions": _normalize_list(payload.get("next_actions")),
    }


def normalize_memory_state(data: Any) -> dict[str, Any]:
    """将原始记忆数据规范化为标准结构，包含 preferences、policies、constraints、stats 字段。"""
    payload = data if isinstance(data, dict) else {}
    preferences = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else {}
    stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
    return {
        "schema_version": MEMORY_SCHEMA_VERSION,
        "preferences": preferences,
        "policies": _normalize_list(payload.get("policies")),
        "constraints": _normalize_list(payload.get("constraints")),
        "stats": stats,
    }


def get_summary_state(workspace_id: str, scene_id: str) -> dict[str, Any]:
    """从 Redis 读取指定工作区和场景的对话摘要状态，不存在时返回空的规范化结构。"""
    payload = _get_json(_summary_key(workspace_id, scene_id))
    if isinstance(payload, dict):
        return normalize_summary_state(payload.get("summary_state"))
    return normalize_summary_state(None)


def set_summary_state(workspace_id: str, scene_id: str, summary_state: dict[str, Any], ttl: int | None = None):
    """将规范化后的对话摘要状态写入 Redis，支持可选的过期时间。"""
    _set_json(_summary_key(workspace_id, scene_id), {"summary_state": normalize_summary_state(summary_state)}, ttl)


def get_summary_history(workspace_id: str, scene_id: str) -> list[dict[str, Any]]:
    """从 Redis 读取摘要历史记录列表，每个元素为一轮对话后的摘要快照。"""
    payload = _get_json(_summary_history_key(workspace_id, scene_id))
    if isinstance(payload, list):
        return [normalize_summary_state(item) for item in payload]
    return []


def append_summary_history(workspace_id: str, scene_id: str, summary_state: dict[str, Any]) -> list[dict[str, Any]]:
    """将新的摘要快照追加到历史记录，超出 SUMMARY_HISTORY_LIMIT 时裁剪旧记录。"""
    history = get_summary_history(workspace_id, scene_id)
    history.append(normalize_summary_state(summary_state))
    if SUMMARY_HISTORY_LIMIT > 0:
        history = history[-SUMMARY_HISTORY_LIMIT:]
    _set_json(_summary_history_key(workspace_id, scene_id), history)
    return history


def get_memory_state(workspace_id: str, scene_id: str) -> dict[str, Any]:
    """从 Redis 读取指定工作区和场景的长期记忆状态。"""
    payload = _get_json(_memory_key(workspace_id, scene_id))
    return normalize_memory_state(payload)


def set_memory_state(workspace_id: str, scene_id: str, memory_state: dict[str, Any], ttl: int | None = None):
    """将规范化后的长期记忆状态写入 Redis，支持可选的过期时间。"""
    _set_json(_memory_key(workspace_id, scene_id), normalize_memory_state(memory_state), ttl)


def render_summary_state(summary_state: dict[str, Any]) -> str:
    """将摘要状态渲染为紧凑的 JSON 字符串，仅包含非空字段；全部为空时返回空字符串。"""
    state = normalize_summary_state(summary_state)
    compact = {"schema_version": SUMMARY_SCHEMA_VERSION}
    for key in ("goal", "constraints", "decisions", "open_questions", "next_actions"):
        value = state.get(key)
        if isinstance(value, str) and value:
            compact[key] = value
        elif isinstance(value, list) and value:
            compact[key] = value
    if compact == {"schema_version": SUMMARY_SCHEMA_VERSION}:
        return ""
    return json.dumps(compact, ensure_ascii=False)


def render_memory_guidelines(memory_state: dict[str, Any]) -> str:
    """将长期记忆状态渲染为人类可读的多行文本，用于注入系统提示词。"""
    state = normalize_memory_state(memory_state)
    lines: list[str] = []
    preferences = state.get("preferences") or {}
    if isinstance(preferences, dict):
        language = preferences.get("language")
        tone = preferences.get("tone")
        fmt = preferences.get("format")
        if language:
            lines.append(f"Preferred language: {language}")
        if tone:
            lines.append(f"Tone: {tone}")
        if fmt:
            if isinstance(fmt, list):
                lines.append("Preferred format: " + ", ".join([str(i) for i in fmt if str(i).strip()]))
            else:
                lines.append(f"Preferred format: {fmt}")
    policies = state.get("policies") or []
    if policies:
        lines.append("Policies: " + "; ".join(policies))
    constraints = state.get("constraints") or []
    if constraints:
        lines.append("Persistent constraints: " + "; ".join(constraints))
    return "\n".join(lines)
