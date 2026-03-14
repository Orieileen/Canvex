from __future__ import annotations

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
from .models import ExcalidrawVideoJob
from .tasks import run_excalidraw_video_job
from .tools import imagetool


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


_IMAGE_SIZE_RE = re.compile(r"^\d{2,4}x\d{2,4}$")
_FLOWCHART_MERMAID_BLOCK_RE = re.compile(r"```(?:\w+)?\s*([\s\S]*?)```", re.IGNORECASE)
_FLOWCHART_EDGE_RE = re.compile(r"(-->|---|==>|-.->)")
_FLOWCHART_NODE_DEF_RE = re.compile(r"(?m)\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]|\([^\)]*\)|\{[^}]*\})")
_FLOWCHART_MAX_CHARS = 16000
_FLOWCHART_MAX_NODES = 120
_FLOWCHART_MAX_EDGES = 240
_MEDIA_ACTIONS = {"chat", "clarify", "generate_image", "generate_video", "generate_flowchart"}
_VIDEO_ALLOWED_SECONDS = (4, 8, 12)
_VIDEO_SIZE_BY_ASPECT_RATIO = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "720x720",
}
_VIDEO_ASPECT_RATIO_BY_SIZE = {v: k for k, v in _VIDEO_SIZE_BY_ASPECT_RATIO.items()}


# ---------------------------------------------------------------------------
# Model helpers
# ---------------------------------------------------------------------------

def _build_chat_model(streaming: bool) -> ChatOpenAI:
    params: Dict[str, Any] = {
        "model": os.getenv("EXCALIDRAW_CHAT_MODEL", "gpt-4o-mini"),
        "temperature": float(os.getenv("EXCALIDRAW_CHAT_TEMPERATURE", "0.4")),
        "streaming": streaming,
    }
    max_tokens = os.getenv("EXCALIDRAW_CHAT_MAX_TOKENS")
    if max_tokens:
        params["max_tokens"] = int(max_tokens)

    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        params["api_key"] = api_key
    base_url = os.getenv("OPENAI_BASE_URL", "").strip()
    if base_url:
        params["base_url"] = base_url

    return ChatOpenAI(**params)


def _build_system_prompt(scene_title: str, summary_state: Dict[str, Any], memory_state: Dict[str, Any]) -> str:
    parts = [
        "You are Canvex Copilot, an AI assistant embedded in an Excalidraw-style canvas workspace.",
        "Your job is to help users brainstorm, make decisions, and produce concrete next actions for the current scene.",
        "Response policy:",
        "1) Match the user's language and terminology.",
        "2) Keep responses concise, specific, and actionable.",
        "3) Prefer practical structure (short bullets or numbered steps) when it improves clarity.",
        "4) If key information is missing, ask at most 1-2 focused clarification questions; otherwise proceed with explicit assumptions.",
        "5) Stay consistent with confirmed constraints and decisions; do not reopen settled choices unless requested.",
        "6) Do not output tool-call syntax, XML tags, or fake execution traces.",
        "7) Do not output raw JSON unless the user explicitly asks for JSON.",
        "8) Do not claim image/video generation is finished unless completion is explicit in context.",
        f"Scene: {scene_title or 'Untitled'}",
    ]
    summary_text = render_summary_state(summary_state)
    if summary_text:
        parts.extend(["Scene summary state (JSON):", summary_text])
    memory_guidelines = render_memory_guidelines(memory_state)
    if memory_guidelines:
        parts.extend(["Persistent user preferences and constraints:", memory_guidelines])
    parts.append("Image and video generation are orchestrated by backend workflows based on user intent.")
    parts.append(
        "When users request image/video, provide brief prompt refinement and quality constraints "
        "(style, subject, camera/motion, seconds, size, do/don't)."
    )
    return "\n".join(parts)


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


def _invoke_json(llm: ChatOpenAI, system_prompt: str, user_prompt: str) -> Dict[str, Any] | None:
    response = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt),
    ])
    content = getattr(response, "content", "") or ""
    if isinstance(content, list):
        content = "".join(str(c.get("text", "")) if isinstance(c, dict) else str(c) for c in content)
    content = content.strip()
    if not content:
        return None
    parsed = json.loads(content)
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# Normalizers
# ---------------------------------------------------------------------------

def _normalize_image_size(value: Any, default: str = "1024x1024") -> str:
    raw = str(value or "").strip().lower().replace(" ", "")
    return raw if _IMAGE_SIZE_RE.match(raw) else default


def _normalize_image_urls(value: Any) -> List[str] | None:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return None
    output = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return output or None


# ---------------------------------------------------------------------------
# Flowchart helpers
# ---------------------------------------------------------------------------

def _extract_mermaid_block(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = _FLOWCHART_MERMAID_BLOCK_RE.search(text)
    return (match.group(1) or "").strip() if match else text


def _normalize_flowchart_mermaid(value: str) -> str:
    text = _extract_mermaid_block(value)
    if not text:
        return ""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return ""

    lower_head = lines[0].strip().lower()
    if lower_head.startswith(("graph", "flowchart")):
        lines[0] = "flowchart TD"
    else:
        lines.insert(0, "flowchart TD")
    return "\n".join(lines)


def _validate_flowchart_td_mermaid(mermaid_text: str) -> str | None:
    text = (mermaid_text or "").strip()
    if not text:
        return "empty mermaid"
    if len(text) > _FLOWCHART_MAX_CHARS:
        return f"diagram too large ({len(text)} chars)"
    if "```" in text:
        return "contains markdown code fence"

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0].lower() != "flowchart td":
        return "first line must be flowchart TD"
    if re.search(r"(?mi)^\s*(classDef|click|style|linkStyle)\b", text):
        return "contains unsupported directives"

    edge_count = len(_FLOWCHART_EDGE_RE.findall(text))
    if edge_count > _FLOWCHART_MAX_EDGES:
        return f"too many edges ({edge_count})"

    node_count = len({m.group(1) for m in _FLOWCHART_NODE_DEF_RE.finditer(text)})
    if node_count > _FLOWCHART_MAX_NODES:
        return f"too many nodes ({node_count})"
    return None


def _build_flowchart_generation_prompt(prompt: str, current_mermaid: str | None = None) -> str:
    existing_text = (current_mermaid or "").strip() or "(none)"
    schema = {"mermaid": "string (pure mermaid only, no markdown fences)"}
    return (
        "Generate Mermaid diagram JSON only.\n"
        "Schema:\n"
        f"{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
        "Requirements:\n"
        "- Output Mermaid flowchart only.\n"
        "- First line must be exactly: flowchart TD\n"
        "- Keep node identifiers concise and stable, such as A1, A2, B1.\n"
        "- Keep labels concise and practical.\n"
        "- Always use quoted labels, e.g. A1[\"Start\"], B2[\"Review\"]\n"
        "- Label text must be plain language, not math/LaTeX syntax.\n"
        "- Do not use braces or formula notation in labels, such as { }, lim_{...}, f(x)/g(x), ->, <=, >=.\n"
        "- If the user asks for formulas, rewrite them into plain words.\n"
        "- Avoid classDef/click/style/linkStyle directives.\n"
        "- Do not wrap Mermaid in markdown code fences.\n\n"
        f"Existing Mermaid (if any):\n{existing_text}\n\n"
        f"User request:\n{prompt}\n\n"
        "JSON:"
    )


def _generate_flowchart_result(args: Dict[str, Any], state: ChatState) -> Dict[str, Any]:
    prompt = str(args.get("prompt") or state.get("last_user") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}

    current_mermaid = _normalize_flowchart_mermaid(str(args.get("current_mermaid") or ""))
    llm = _build_chat_model(streaming=False)
    generation_raw = _invoke_json(
        llm,
        "You are a Mermaid flowchart author. Output strict JSON only.",
        _build_flowchart_generation_prompt(prompt, current_mermaid),
    )
    candidate = _normalize_flowchart_mermaid(str((generation_raw or {}).get("mermaid") or ""))
    validation_error = _validate_flowchart_td_mermaid(candidate)

    if validation_error:
        schema = {"mermaid": "string (valid flowchart TD mermaid)"}
        repair_prompt = (
            "Repair Mermaid and return JSON only.\n"
            "Schema:\n"
            f"{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
            "Constraints:\n"
            "- First line must be exactly: flowchart TD\n"
            "- Keep semantic meaning of user request.\n"
            "- Use quoted labels only, e.g. A1[\"...\"]\n"
            "- Replace math/LaTeX-like label text with plain words.\n"
            "- Do not keep braces/formula tokens in labels (e.g. { }, lim_{...}, ->).\n"
            "- Avoid classDef/click/style/linkStyle directives.\n"
            "- No markdown code fences.\n\n"
            f"Validation error:\n{validation_error}\n\n"
            f"User request:\n{prompt}\n\n"
            f"Candidate Mermaid:\n{candidate}\n\n"
            "JSON:"
        )
        repair_raw = _invoke_json(
            llm, "You repair Mermaid flowchart TD. Output strict JSON only.", repair_prompt
        )
        repaired = _normalize_flowchart_mermaid(str((repair_raw or {}).get("mermaid") or ""))
        repaired_error = _validate_flowchart_td_mermaid(repaired)
        if not repaired_error:
            candidate = repaired
            validation_error = None
        else:
            validation_error = repaired_error

    if validation_error:
        return {"error": f"failed to generate Mermaid flowchart TD: {validation_error}"}

    return {
        "format": "mermaid",
        "diagram_type": "flowchart",
        "direction": "TD",
        "mermaid": candidate,
    }


# ---------------------------------------------------------------------------
# Media action router (single LLM call, no heuristic fallback)
# ---------------------------------------------------------------------------

def _build_media_action_prompt(state: ChatState) -> str:
    schema = {
        "action": "chat | clarify | generate_image | generate_video | generate_flowchart",
        "assistant": "string",
        "image": {"prompt": "string", "size": "1024x1024"},
        "video": {
            "prompt": "string",
            "seconds": 12,
            "size": "1280x720",
            "image_urls": ["https://example.com/a.png"],
        },
        "flowchart": {
            "prompt": "string",
            "current_mermaid": "string (optional)",
        },
    }
    summary_text = render_summary_state(state.get("summary_state") or {}) or "(none)"
    memory_text = render_memory_guidelines(state.get("memory_state") or {}) or "(none)"
    last_user = (state.get("last_user") or "").strip()
    return (
        "Decide backend action for the latest user message. Return JSON only.\n"
        "Action rules:\n"
        "- Use generate_flowchart when the user asks for diagram/flowchart generation or Mermaid flowchart.\n"
        "- Use generate_image / generate_video only when the user is explicitly asking to create image/video.\n"
        "- Use clarify only when media generation is requested but blocked by missing critical information.\n"
        "- Do NOT ask clarification for optional preferences if reasonable defaults are enough.\n"
        "- Otherwise use chat.\n"
        "Generation rules:\n"
        "- For generate_image, fill image.prompt and optional image.size (default 1024x1024).\n"
        "- For generate_video, fill video.prompt and optional video.seconds/video.size/video.image_urls "
        "(defaults: seconds=12, size=1280x720).\n"
        "- For generate_flowchart, fill flowchart.prompt and optional flowchart.current_mermaid.\n"
        "Assistant text rules:\n"
        "- assistant must be concise and in the user's language.\n"
        "- If action is clarify, assistant should be a short question.\n"
        "- If action is generate_image/generate_video/generate_flowchart, assistant should be a short acknowledgement sentence, not a question.\n"
        "- Never claim generation is already finished.\n\n"
        f"Schema:\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
        f"Summary context:\n{summary_text}\n\n"
        f"Memory guidelines:\n{memory_text}\n\n"
        f"Latest user message:\n{last_user}\n\n"
        "JSON:"
    )


def _decide_media_action(state: ChatState) -> Dict[str, Any]:
    """Route user intent via LLM. Returns action dict; defaults to chat on failure."""
    last_user = (state.get("last_user") or "").strip()
    if not last_user:
        return {"action": "chat"}

    llm = _build_chat_model(streaming=False)
    decision_raw = _invoke_json(
        llm,
        "You are Canvex media action router. Output strict JSON only.",
        _build_media_action_prompt(state),
    )
    if not decision_raw:
        return {"action": "chat"}

    action = str(decision_raw.get("action") or "chat").strip().lower()
    if action not in _MEDIA_ACTIONS:
        return {"action": "chat"}

    decision: Dict[str, Any] = {"action": action}
    assistant = str(decision_raw.get("assistant") or "").strip()
    if assistant:
        decision["assistant"] = assistant

    if action == "generate_image":
        image_payload = decision_raw.get("image") if isinstance(decision_raw.get("image"), dict) else {}
        decision["image_args"] = {
            "prompt": str(image_payload.get("prompt") or last_user).strip(),
            "size": _normalize_image_size(image_payload.get("size")),
            "scene_id": state.get("scene_id"),
        }

    elif action == "generate_video":
        video_payload = decision_raw.get("video") if isinstance(decision_raw.get("video"), dict) else {}
        decision["video_args"] = {
            "prompt": str(video_payload.get("prompt") or last_user).strip(),
            "seconds": video_payload.get("seconds") or 12,
            "size": str(video_payload.get("size") or "1280x720").strip().lower().replace(" ", ""),
            "image_urls": _normalize_image_urls(video_payload.get("image_urls")),
            "scene_id": state.get("scene_id"),
        }

    elif action == "generate_flowchart":
        fc_payload = decision_raw.get("flowchart") if isinstance(decision_raw.get("flowchart"), dict) else {}
        flowchart_args: Dict[str, Any] = {"prompt": str(fc_payload.get("prompt") or last_user).strip()}
        current_mermaid = _normalize_flowchart_mermaid(str(fc_payload.get("current_mermaid") or ""))
        if current_mermaid:
            flowchart_args["current_mermaid"] = current_mermaid
        decision["flowchart_args"] = flowchart_args

    return decision


# ---------------------------------------------------------------------------
# Video / image job helpers
# ---------------------------------------------------------------------------

def _enqueue_video_job(args: Dict[str, Any]) -> Dict[str, Any]:
    prompt = str(args.get("prompt") or "").strip()
    scene_id = str(args.get("scene_id") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}
    if not scene_id:
        return {"error": "scene_id is required"}

    seconds = int(args.get("seconds") or 12)
    if seconds not in _VIDEO_ALLOWED_SECONDS:
        return {"error": f"video seconds must be one of {list(_VIDEO_ALLOWED_SECONDS)}"}

    size = str(args.get("size") or "1280x720").strip().lower().replace(" ", "")
    aspect_ratio = _VIDEO_ASPECT_RATIO_BY_SIZE.get(size)
    if not aspect_ratio:
        return {"error": f"video size must be one of {list(_VIDEO_ASPECT_RATIO_BY_SIZE)}"}

    image_urls = _normalize_image_urls(args.get("image_urls"))
    model_name = str(args.get("model") or "").strip()

    job = ExcalidrawVideoJob.objects.create(
        scene_id=scene_id,
        prompt=prompt,
        image_urls=image_urls or [],
        duration=seconds,
        aspect_ratio=aspect_ratio,
        model_name=model_name,
        status=ExcalidrawVideoJob.Status.QUEUED,
    )
    run_excalidraw_video_job.apply_async(args=[str(job.id)], queue="excalidraw")

    return {
        "job_id": str(job.id),
        "task_id": str(job.id),
        "status": job.status,
        "scene_id": scene_id,
        "poll_url": f"/api/v1/excalidraw/video-jobs/{job.id}/",
    }


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


def _image_tool_wait_timeout() -> float:
    return float(os.getenv("EXCALIDRAW_IMAGE_TOOL_WAIT_TIMEOUT_SECONDS", "1200"))


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------

def load_memory(state: ChatState) -> Dict[str, Any]:
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")
    return {
        "summary_state": state.get("summary_state") or get_summary_state(workspace_id, scene_id),
        "memory_state": state.get("memory_state") or get_memory_state(workspace_id, scene_id),
    }


def call_llm(state: ChatState) -> Iterator[Dict[str, Any]]:
    media_action = _decide_media_action(state)
    action = media_action["action"]

    # --- clarify ---
    if action == "clarify":
        yield {"assistant": {"role": "assistant", "content": media_action.get("assistant", "")}}
        return

    # --- flowchart ---
    if action == "generate_flowchart":
        args = media_action.get("flowchart_args", {})
        result = _generate_flowchart_result(args, state)
        yield {"tool_results": [{"tool": "mermaid_flowchart", "result": result}]}
        text = media_action.get("assistant", "")
        if result.get("error"):
            text = "流程图生成失败，请重试。"
        yield {"assistant": {"role": "assistant", "content": text}}
        return

    # --- video ---
    if action == "generate_video":
        yield {"intent": "video"}
        args = media_action.get("video_args", {})
        result = _enqueue_video_job(args)
        yield {"tool_results": [{"tool": "videotool", "result": result}]}
        text = media_action.get("assistant", "")
        if result.get("error"):
            text = result["error"]
        yield {"assistant": {"role": "assistant", "content": text}}
        return

    # --- image ---
    if action == "generate_image":
        yield {"intent": "image"}
        args = media_action.get("image_args", {})
        image_queue = _start_image_job(args)
        text = media_action.get("assistant", "")
        yield {"assistant": {"role": "assistant", "content": text}}
        try:
            result = image_queue.get(timeout=_image_tool_wait_timeout())
        except queue.Empty:
            result = {"tool": imagetool.name, "result": {"error": "image generation timed out"}}
        yield {"tool_results": [result]}
        return

    # --- chat (streaming) ---
    system_prompt = _build_system_prompt(
        state.get("scene_title", ""),
        state.get("summary_state") or {},
        state.get("memory_state") or {},
    )
    llm = _build_chat_model(streaming=True)
    lc_messages = _to_langchain_messages(system_prompt, state["messages"])

    content = ""
    for chunk in llm.stream(lc_messages):
        delta = getattr(chunk, "content", "") or ""
        if isinstance(delta, list):
            delta = "".join(str(c.get("text", "")) if isinstance(c, dict) else str(c) for c in delta)
        if delta:
            content += delta
            yield {"assistant": {"role": "assistant", "content": content}}


# ---------------------------------------------------------------------------
# Memory update
# ---------------------------------------------------------------------------

def _flatten_summary_entries(summary_state: Dict[str, Any]) -> List[str]:
    state = normalize_summary_state(summary_state)
    entries: List[str] = []
    goal = state.get("goal")
    if goal:
        entries.append(f"goal:{goal}")
    for key in ("constraints", "decisions", "open_questions", "next_actions"):
        for item in state.get(key) or []:
            entries.append(f"{key.rstrip('s')}:{item}")
    return entries


def _collect_stable_entries(history: List[Dict[str, Any]]) -> List[str]:
    window = history[-MEMORY_STABILITY_WINDOW:] if MEMORY_STABILITY_WINDOW > 0 else history
    counts: Counter[str] = Counter()
    for snapshot in window:
        for entry in _flatten_summary_entries(snapshot):
            counts[entry] += 1
    return [entry for entry, count in counts.items() if count >= MEMORY_STABILITY_MIN_COUNT]


def update_memory(state: ChatState) -> Dict[str, Any]:
    summary_state = normalize_summary_state(state.get("summary_state"))
    memory_state = normalize_memory_state(state.get("memory_state"))
    last_user = state.get("last_user") or ""
    assistant = (state.get("assistant") or {}).get("content") or ""
    if not last_user and not assistant:
        return {"summary_state": summary_state, "memory_state": memory_state}

    llm = _build_chat_model(streaming=False)
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")

    # Update summary
    exchange = f"user: {last_user}\nassistant: {assistant}".strip()
    schema = json.dumps(normalize_summary_state(None), ensure_ascii=False, indent=2)
    current = json.dumps(normalize_summary_state(summary_state), ensure_ascii=False, indent=2)
    summary_prompt = (
        "Update summary state snapshot. Output JSON only.\n"
        "Rules: keep confirmed, still-valid, overridable facts only.\n\n"
        f"Schema:\n{schema}\n\nCurrent summary JSON:\n{current}\n\n"
        f"New exchange:\n{exchange}\n\nUpdated summary JSON:"
    )
    summary_candidate = _invoke_json(llm, "You update summary state strictly following rules.", summary_prompt)
    if summary_candidate:
        summary_state = normalize_summary_state(summary_candidate)
        set_summary_state(workspace_id, scene_id, summary_state)

    # Check for stable entries -> update long-term memory
    history = append_summary_history(workspace_id, scene_id, summary_state)
    stable_entries = _collect_stable_entries(history)
    if stable_entries:
        mem_schema = json.dumps(normalize_memory_state(None), ensure_ascii=False, indent=2)
        mem_current = json.dumps(normalize_memory_state(memory_state), ensure_ascii=False, indent=2)
        stable_text = "\n".join(f"- {item}" for item in stable_entries)
        memory_prompt = (
            "Update long-term memory from stable summary entries. Output JSON only.\n"
            "Keep durable preferences/constraints/policies, not transient chat content.\n\n"
            f"Schema:\n{mem_schema}\n\nCurrent memory JSON:\n{mem_current}\n\n"
            f"Stable entries:\n{stable_text}\n\nUpdated memory JSON:"
        )
        memory_candidate = _invoke_json(llm, "You maintain long-term memory as structured config.", memory_prompt)
        if memory_candidate:
            memory_state = normalize_memory_state(memory_candidate)
            set_memory_state(workspace_id, scene_id, memory_state)

    return {"summary_state": summary_state, "memory_state": memory_state}


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

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
