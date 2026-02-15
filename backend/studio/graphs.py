from __future__ import annotations

import inspect
import json
import os
import queue
import re
import threading
from collections import Counter
from typing import Any, Dict, Iterator, List, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph

from .memory import (
    MEMORY_STABILITY_MIN_COUNT,
    MEMORY_STABILITY_WINDOW,
    append_summary_history,
    get_memory_state,
    get_summary_state,
    normalize_memory_state,
    normalize_summary_state,
    render_memory_guidelines,
    render_summary_state,
    set_memory_state,
    set_summary_state,
)
from .tools import imagetool, videotool

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"


class ChatState(TypedDict):
    scene_id: str
    workspace_id: str
    scene_title: str
    messages: List[Dict[str, str]]
    summary_state: Dict[str, Any]
    memory_state: Dict[str, Any]
    last_user: str
    assistant: Dict[str, str] | None
    tool_results: List[Dict[str, Any]] | None
    intent: str | None


def _get_model_name() -> str:
    return os.getenv("EXCALIDRAW_CHAT_MODEL", "gpt-4.1-mini")


def _get_temperature() -> float:
    try:
        return float(os.getenv("EXCALIDRAW_CHAT_TEMPERATURE", "0.4"))
    except Exception:
        return 0.4


def _get_max_tokens() -> int | None:
    raw = os.getenv("EXCALIDRAW_CHAT_MAX_TOKENS")
    if not raw:
        return None
    try:
        return int(raw)
    except Exception:
        return None


def _build_system_prompt(scene_title: str, summary_state: Dict[str, Any], memory_state: Dict[str, Any]) -> str:
    parts = [
        "You are an assistant helping users brainstorm and refine ideas for Excalidraw.",
        "Keep responses concise, actionable, and structured.",
        f"Scene: {scene_title or 'Untitled'}",
    ]
    summary_text = render_summary_state(summary_state)
    if summary_text:
        parts.extend(["Summary state (JSON):", summary_text])
    memory_guidelines = render_memory_guidelines(memory_state)
    if memory_guidelines:
        parts.extend(["Behavior guidelines derived from memory:", memory_guidelines])
    parts.append("If user asks for an image or visual output, call imagetool.")
    parts.append("If user asks for a video, call videotool.")
    return "\n".join(parts)


def _build_chat_model(streaming: bool) -> ChatOpenAI:
    params: Dict[str, Any] = {
        "model": _get_model_name(),
        "temperature": _get_temperature(),
        "streaming": streaming,
    }
    max_tokens = _get_max_tokens()
    if max_tokens is not None:
        params["max_tokens"] = max_tokens

    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL", "").strip() or OPENAI_DEFAULT_BASE_URL
    sig = inspect.signature(ChatOpenAI)

    if api_key:
        if "api_key" in sig.parameters:
            params["api_key"] = api_key
        elif "openai_api_key" in sig.parameters:
            params["openai_api_key"] = api_key
    if "base_url" in sig.parameters:
        params["base_url"] = base_url
    elif "openai_api_base" in sig.parameters:
        params["openai_api_base"] = base_url

    return ChatOpenAI(**params)


def _to_langchain_messages(system_prompt: str, messages: List[Dict[str, str]]) -> List[BaseMessage]:
    output: List[BaseMessage] = [SystemMessage(content=system_prompt)]
    for item in messages:
        role = item.get("role")
        content = item.get("content") or ""
        if role == "user":
            output.append(HumanMessage(content=content))
        elif role == "assistant":
            output.append(AIMessage(content=content))
    return output


def _chunk_content(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(value)


_VIDEO_KEYWORDS = (
    "video",
    "视频",
    "动画",
    "动效",
    "短片",
    "影片",
    "movie",
    "clip",
    "gif",
)
_ASPECT_RATIO_RE = re.compile(r"(16\s*:\s*9|9\s*:\s*16)")
_DURATION_RE = re.compile(r"(\d{1,3})\s*(s|sec|secs|seconds|秒)")
_URL_RE = re.compile(r"https?://\S+")


def _extract_urls(text: str) -> List[str]:
    urls: List[str] = []
    for match in _URL_RE.findall(text or ""):
        url = match.rstrip(").,]}>\"'")
        if url:
            urls.append(url)
    return urls


def _detect_video_intent(state: ChatState) -> Dict[str, Any] | None:
    last_user = state.get("last_user") or ""
    if not last_user:
        return None
    lowered = last_user.lower()
    if not any(keyword in lowered for keyword in _VIDEO_KEYWORDS):
        return None
    aspect_ratio = None
    ratio_match = _ASPECT_RATIO_RE.search(last_user)
    if ratio_match:
        aspect_ratio = ratio_match.group(1).replace(" ", "")
    duration = None
    duration_match = _DURATION_RE.search(last_user)
    if duration_match:
        try:
            duration = int(duration_match.group(1))
        except Exception:
            duration = None
    image_urls = _extract_urls(last_user)
    return {
        "prompt": last_user.strip(),
        "duration": duration or 10,
        "aspect_ratio": aspect_ratio or "16:9",
        "image_urls": image_urls or None,
    }


def _invoke_json(llm: ChatOpenAI, system_prompt: str, user_prompt: str) -> Dict[str, Any] | None:
    try:
        response = llm.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
    except Exception:
        return None
    content = getattr(response, "content", "") or ""
    if not isinstance(content, str):
        content = _chunk_content(content)
    content = content.strip()
    if not content:
        return None
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(content[start : end + 1])
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                return None
    return None


def _classify_image_intent(state: ChatState) -> Dict[str, Any] | None:
    last_user = state.get("last_user") or ""
    if not last_user:
        return None
    llm = _build_chat_model(streaming=False)
    prompt = (
        "Return JSON only: {\"use_image\": boolean, \"prompt\": string, \"size\": string}.\n"
        "use_image=true when user asks to generate/draw/create an image.\n"
        "If true, rewrite prompt into concise English prompt when possible.\n"
        "If false, prompt/size should be empty strings.\n\n"
        f"User: {last_user}\n"
    )
    return _invoke_json(llm, "You are an image intent classifier.", prompt)


def _start_image_job(args: Dict[str, Any]) -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=1)

    def worker():
        try:
            output = imagetool.invoke(args)
        except Exception as exc:
            output = {"error": str(exc)}
        q.put({"tool": imagetool.name, "result": output})

    threading.Thread(target=worker, daemon=True).start()
    return q


def _start_video_job(args: Dict[str, Any]) -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=1)

    def worker():
        try:
            output = videotool.invoke(args)
        except Exception as exc:
            output = {"error": str(exc)}
        q.put({"tool": videotool.name, "result": output})

    threading.Thread(target=worker, daemon=True).start()
    return q


def _build_summary_update_prompt(summary_state: Dict[str, Any], last_user: str, assistant: str) -> str:
    exchange = "\n".join([f"user: {last_user}", f"assistant: {assistant}"]).strip()
    schema = json.dumps(normalize_summary_state(None), ensure_ascii=False, indent=2)
    current = json.dumps(normalize_summary_state(summary_state), ensure_ascii=False, indent=2)
    return (
        "Update summary state snapshot. Output JSON only.\n"
        "Rules: keep confirmed, still-valid, overridable facts only.\n\n"
        f"Schema:\n{schema}\n\n"
        f"Current summary JSON:\n{current}\n\n"
        f"New exchange:\n{exchange}\n\n"
        "Updated summary JSON:"
    )


def _build_memory_update_prompt(memory_state: Dict[str, Any], stable_entries: List[str]) -> str:
    schema = json.dumps(normalize_memory_state(None), ensure_ascii=False, indent=2)
    current = json.dumps(normalize_memory_state(memory_state), ensure_ascii=False, indent=2)
    stable = "\n".join([f"- {item}" for item in stable_entries]) if stable_entries else "(none)"
    return (
        "Update long-term memory from stable summary entries. Output JSON only.\n"
        "Keep durable preferences/constraints/policies, not transient chat content.\n\n"
        f"Schema:\n{schema}\n\n"
        f"Current memory JSON:\n{current}\n\n"
        f"Stable entries:\n{stable}\n\n"
        "Updated memory JSON:"
    )


def _flatten_summary_entries(summary_state: Dict[str, Any]) -> List[str]:
    state = normalize_summary_state(summary_state)
    entries: List[str] = []
    goal = state.get("goal")
    if goal:
        entries.append(f"goal:{goal}")
    for item in state.get("constraints") or []:
        entries.append(f"constraint:{item}")
    for item in state.get("decisions") or []:
        entries.append(f"decision:{item}")
    for item in state.get("open_questions") or []:
        entries.append(f"open_question:{item}")
    for item in state.get("next_actions") or []:
        entries.append(f"next_action:{item}")
    return entries


def _collect_stable_entries(history: List[Dict[str, Any]]) -> List[str]:
    window = history[-MEMORY_STABILITY_WINDOW:] if MEMORY_STABILITY_WINDOW > 0 else history
    counts: Counter[str] = Counter()
    for snapshot in window:
        for entry in _flatten_summary_entries(snapshot):
            counts[entry] += 1
    return [entry for entry, count in counts.items() if count >= MEMORY_STABILITY_MIN_COUNT]


def load_memory(state: ChatState) -> Dict[str, Any]:
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")
    summary_state = state.get("summary_state") or get_summary_state(workspace_id, scene_id)
    memory_state = state.get("memory_state") or get_memory_state(workspace_id, scene_id)
    return {
        "summary_state": summary_state,
        "memory_state": memory_state,
    }


def call_llm(state: ChatState) -> Iterator[Dict[str, Dict[str, str]]]:
    system_prompt = _build_system_prompt(
        state.get("scene_title", ""),
        state.get("summary_state") or {},
        state.get("memory_state") or {},
    )
    llm = _build_chat_model(streaming=True)
    lc_messages = _to_langchain_messages(system_prompt, state["messages"])

    content = ""
    image_queue: queue.Queue | None = None
    video_queue: queue.Queue | None = None
    image_sent = False
    video_sent = False

    video_intent = _detect_video_intent(state)
    if video_intent:
        yield {"intent": "video"}
        args = {
            "prompt": video_intent.get("prompt") or state.get("last_user") or "",
            "duration": video_intent.get("duration") or 10,
            "aspect_ratio": video_intent.get("aspect_ratio") or "16:9",
            "image_urls": video_intent.get("image_urls"),
            "scene_id": state.get("scene_id"),
        }
        video_queue = _start_video_job(args)
    else:
        intent = _classify_image_intent(state) or {}
        if intent.get("use_image") is True:
            yield {"intent": "image"}
            args = {
                "prompt": intent.get("prompt") or state.get("last_user") or "",
                "size": intent.get("size") or "1024x1024",
                "scene_id": state.get("scene_id"),
            }
            image_queue = _start_image_job(args)

    try:
        for chunk in llm.stream(lc_messages):
            if image_queue and not image_sent:
                try:
                    result = image_queue.get_nowait()
                except queue.Empty:
                    result = None
                if result:
                    image_sent = True
                    yield {"tool_results": [result]}

            if video_queue and not video_sent:
                try:
                    result = video_queue.get_nowait()
                except queue.Empty:
                    result = None
                if result:
                    video_sent = True
                    yield {"tool_results": [result]}

            delta = _chunk_content(getattr(chunk, "content", ""))
            if not delta:
                continue
            content += delta
            yield {
                "assistant": {
                    "role": "assistant",
                    "content": content,
                }
            }
    except Exception:
        content = ""

    if image_queue and not image_sent:
        yield {"tool_results": [image_queue.get()]}

    if video_queue and not video_sent:
        yield {"tool_results": [video_queue.get()]}

    if not content:
        yield {
            "assistant": {
                "role": "assistant",
                "content": "",
            }
        }


def update_memory(state: ChatState) -> Dict[str, Any]:
    summary_state = normalize_summary_state(state.get("summary_state"))
    memory_state = normalize_memory_state(state.get("memory_state"))
    last_user = state.get("last_user") or ""
    assistant = (state.get("assistant") or {}).get("content") or ""
    exchange = "\n".join([f"user: {last_user}", f"assistant: {assistant}"]).strip()
    if not exchange:
        return {
            "summary_state": summary_state,
            "memory_state": memory_state,
        }

    llm = _build_chat_model(streaming=False)
    summary_prompt = _build_summary_update_prompt(summary_state, last_user, assistant)
    summary_candidate = _invoke_json(
        llm,
        "You update summary state strictly following rules.",
        summary_prompt,
    )
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")

    if summary_candidate:
        summary_state = normalize_summary_state(summary_candidate)
        set_summary_state(workspace_id, scene_id, summary_state)

    history = append_summary_history(workspace_id, scene_id, summary_state)
    stable_entries = _collect_stable_entries(history)
    if stable_entries:
        memory_prompt = _build_memory_update_prompt(memory_state, stable_entries)
        memory_candidate = _invoke_json(
            llm,
            "You maintain long-term memory as structured config.",
            memory_prompt,
        )
        if memory_candidate:
            memory_state = normalize_memory_state(memory_candidate)
            set_memory_state(workspace_id, scene_id, memory_state)

    return {
        "summary_state": summary_state,
        "memory_state": memory_state,
    }


def build_chat_graph():
    graph = StateGraph(ChatState)
    graph.add_node("load_memory", load_memory)
    graph.add_node("call_llm", call_llm)
    graph.add_node("update_memory", update_memory)
    graph.set_entry_point("load_memory")
    graph.add_edge("load_memory", "call_llm")
    graph.add_edge("call_llm", "update_memory")
    graph.add_edge("update_memory", END)
    return graph.compile()


chat_graph = build_chat_graph()
