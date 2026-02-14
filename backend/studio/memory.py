from __future__ import annotations

import json
import os
from typing import Any

import redis
from django.conf import settings

SUMMARY_SCHEMA_VERSION = 1
MEMORY_SCHEMA_VERSION = 1
DEFAULT_TTL_SECONDS = int(os.getenv("EXCALIDRAW_SUMMARY_TTL_SECONDS", "2592000"))
SUMMARY_HISTORY_LIMIT = int(os.getenv("EXCALIDRAW_SUMMARY_HISTORY_LIMIT", "6"))
MEMORY_STABILITY_WINDOW = int(os.getenv("EXCALIDRAW_MEMORY_STABILITY_WINDOW", "3"))
MEMORY_STABILITY_MIN_COUNT = int(os.getenv("EXCALIDRAW_MEMORY_STABILITY_MIN_COUNT", "2"))


def _redis_url() -> str:
    return os.getenv("EXCALIDRAW_REDIS_URL") or os.getenv("REDIS_URL") or settings.CELERY_BROKER_URL


def _client():
    return redis.from_url(_redis_url(), decode_responses=True)


def _summary_key(workspace_id: str, scene_id: str) -> str:
    return f"excalidraw:summary:{workspace_id}:{scene_id}"


def _summary_history_key(workspace_id: str, scene_id: str) -> str:
    return f"excalidraw:summary_history:{workspace_id}:{scene_id}"


def _memory_key(workspace_id: str, scene_id: str) -> str:
    return f"excalidraw:memory:{workspace_id}:{scene_id}"


def _get_json(key: str):
    try:
        raw = _client().get(key)
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None


def _set_json(key: str, payload: Any, ttl: int | None = None):
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
    payload = _get_json(_summary_key(workspace_id, scene_id))
    if isinstance(payload, dict):
        return normalize_summary_state(payload.get("summary_state"))
    return normalize_summary_state(None)


def set_summary_state(workspace_id: str, scene_id: str, summary_state: dict[str, Any], ttl: int | None = None):
    _set_json(_summary_key(workspace_id, scene_id), {"summary_state": normalize_summary_state(summary_state)}, ttl)


def get_summary_history(workspace_id: str, scene_id: str) -> list[dict[str, Any]]:
    payload = _get_json(_summary_history_key(workspace_id, scene_id))
    if isinstance(payload, list):
        return [normalize_summary_state(item) for item in payload]
    return []


def append_summary_history(workspace_id: str, scene_id: str, summary_state: dict[str, Any]) -> list[dict[str, Any]]:
    history = get_summary_history(workspace_id, scene_id)
    history.append(normalize_summary_state(summary_state))
    if SUMMARY_HISTORY_LIMIT > 0:
        history = history[-SUMMARY_HISTORY_LIMIT:]
    _set_json(_summary_history_key(workspace_id, scene_id), history)
    return history


def get_memory_state(workspace_id: str, scene_id: str) -> dict[str, Any]:
    payload = _get_json(_memory_key(workspace_id, scene_id))
    return normalize_memory_state(payload)


def set_memory_state(workspace_id: str, scene_id: str, memory_state: dict[str, Any], ttl: int | None = None):
    _set_json(_memory_key(workspace_id, scene_id), normalize_memory_state(memory_state), ttl)


def render_summary_state(summary_state: dict[str, Any]) -> str:
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
