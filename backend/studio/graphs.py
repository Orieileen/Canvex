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
from .models import ExcalidrawVideoJob
from .tasks import run_excalidraw_video_job
from .tools import imagetool

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
    return os.getenv("EXCALIDRAW_CHAT_MODEL", "gpt-4o-mini")


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
        "(style, subject, camera/motion, duration, aspect ratio, do/don't)."
    )
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
_IMAGE_SIZE_RE = re.compile(r"^\d{2,4}x\d{2,4}$")
_ASPECT_RATIO_VALUE_RE = re.compile(r"^\d{1,2}:\d{1,2}$")
_MEDIA_ACTIONS = {"chat", "clarify", "generate_image", "generate_video", "generate_flowchart"}
_FLOWCHART_MERMAID_BLOCK_RE = re.compile(r"```(?:\w+)?\s*([\s\S]*?)```", re.IGNORECASE)
_FLOWCHART_EDGE_RE = re.compile(r"(-->|---|==>|-.->)")
_FLOWCHART_NODE_DEF_RE = re.compile(r"(?m)\b([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]|\([^\)]*\)|\{[^}]*\})")
_FLOWCHART_MAX_CHARS = 16000
_FLOWCHART_MAX_NODES = 120
_FLOWCHART_MAX_EDGES = 240


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


def _normalize_image_size(value: Any, default: str = "1024x1024") -> str:
    raw = str(value or "").strip().lower().replace(" ", "")
    if not raw:
        return default
    if _IMAGE_SIZE_RE.match(raw):
        return raw
    return default


def _normalize_aspect_ratio(value: Any, default: str = "16:9") -> str:
    raw = str(value or "").strip().replace(" ", "")
    if not raw:
        return default
    if _ASPECT_RATIO_VALUE_RE.match(raw):
        return raw
    return default


def _extract_mermaid_block(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = _FLOWCHART_MERMAID_BLOCK_RE.search(text)
    if match:
        return (match.group(1) or "").strip()
    return text


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

    head = lines[0].strip()
    lower_head = head.lower()
    if lower_head.startswith("graph"):
        lines[0] = "flowchart TD"
    elif lower_head.startswith("flowchart"):
        lines[0] = "flowchart TD"
    else:
        lines.insert(0, "flowchart TD")
    return "\n".join(lines)


def _count_flowchart_nodes(mermaid_text: str) -> int:
    node_ids = {match.group(1) for match in _FLOWCHART_NODE_DEF_RE.finditer(mermaid_text or "")}
    return len(node_ids)


def _validate_flowchart_td_mermaid(mermaid_text: str) -> str | None:
    text = (mermaid_text or "").strip()
    if not text:
        return "empty mermaid"
    if len(text) > _FLOWCHART_MAX_CHARS:
        return f"diagram too large ({len(text)} chars)"
    if "```" in text:
        return "contains markdown code fence"

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "empty mermaid"
    if lines[0].lower() != "flowchart td":
        return "first line must be flowchart TD"
    if re.search(r"(?mi)^\s*(classDef|click|style|linkStyle)\b", text):
        return "contains unsupported directives"

    edge_count = len(_FLOWCHART_EDGE_RE.findall(text))
    if edge_count > _FLOWCHART_MAX_EDGES:
        return f"too many edges ({edge_count})"

    node_count = _count_flowchart_nodes(text)
    if node_count > _FLOWCHART_MAX_NODES:
        return f"too many nodes ({node_count})"
    return None


def _build_flowchart_generation_prompt(prompt: str, current_mermaid: str | None = None) -> str:
    existing = (current_mermaid or "").strip()
    existing_text = existing if existing else "(none)"
    schema = {
        "mermaid": "string (pure mermaid only, no markdown fences)",
    }
    return (
        "Generate Mermaid diagram JSON only.\n"
        "Schema:\n"
        f"{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
        "Requirements:\n"
        "- Output Mermaid flowchart only.\n"
        "- First line must be exactly: flowchart TD\n"
        "- Keep node identifiers concise and stable, such as A1, A2, B1.\n"
        "- Keep labels concise and practical.\n"
        "- Avoid classDef/click/style/linkStyle directives.\n"
        "- Do not wrap Mermaid in markdown code fences.\n\n"
        f"Existing Mermaid (if any):\n{existing_text}\n\n"
        f"User request:\n{prompt}\n\n"
        "JSON:"
    )


def _build_flowchart_repair_prompt(candidate: str, validation_error: str, user_prompt: str) -> str:
    schema = {
        "mermaid": "string (valid flowchart TD mermaid)",
    }
    return (
        "Repair Mermaid and return JSON only.\n"
        "Schema:\n"
        f"{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n"
        "Constraints:\n"
        "- First line must be exactly: flowchart TD\n"
        "- Keep semantic meaning of user request.\n"
        "- Avoid classDef/click/style/linkStyle directives.\n"
        "- No markdown code fences.\n\n"
        f"Validation error:\n{validation_error}\n\n"
        f"User request:\n{user_prompt}\n\n"
        f"Candidate Mermaid:\n{candidate}\n\n"
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
        repair_raw = _invoke_json(
            llm,
            "You repair Mermaid flowchart TD. Output strict JSON only.",
            _build_flowchart_repair_prompt(candidate, validation_error, prompt),
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


def _bounded_int(value: Any, default: int, minimum: int = 1, maximum: int = 180) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    number = max(minimum, number)
    if maximum > 0:
        number = min(maximum, number)
    return number


def _build_media_action_prompt(state: ChatState) -> str:
    schema = {
        "action": "chat | clarify | generate_image | generate_video | generate_flowchart",
        "assistant": "string",
        "image": {"prompt": "string", "size": "1024x1024"},
        "video": {
            "prompt": "string",
            "duration": 10,
            "aspect_ratio": "16:9",
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
        "- For generate_video, fill video.prompt and optional video.duration/video.aspect_ratio/video.image_urls "
        "(defaults: duration=10, aspect_ratio=16:9).\n"
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


def _decide_media_action(state: ChatState) -> Dict[str, Any] | None:
    last_user = (state.get("last_user") or "").strip()
    if not last_user:
        return None

    llm = _build_chat_model(streaming=False)
    decision_raw = _invoke_json(
        llm,
        "You are Canvex media action router. Output strict JSON only.",
        _build_media_action_prompt(state),
    )
    if not decision_raw:
        return None

    action = str(decision_raw.get("action") or "").strip().lower()
    if action not in _MEDIA_ACTIONS:
        return None

    decision: Dict[str, Any] = {"action": action}
    assistant = str(decision_raw.get("assistant") or "").strip()
    if assistant:
        decision["assistant"] = assistant

    if action == "clarify":
        if not assistant:
            decision["assistant"] = "为了准确执行，请补充关键要求（如主体、风格或画幅）。"
        return decision

    if action == "generate_image":
        image_payload = decision_raw.get("image") if isinstance(decision_raw.get("image"), dict) else {}
        prompt = str(image_payload.get("prompt") or last_user).strip() or last_user
        size = _normalize_image_size(image_payload.get("size"), default="1024x1024")
        decision["image_args"] = {
            "prompt": prompt,
            "size": size,
            "scene_id": state.get("scene_id"),
        }
        if not assistant:
            decision["assistant"] = "好的，正在生成图片。"
        return decision

    if action == "generate_video":
        video_payload = decision_raw.get("video") if isinstance(decision_raw.get("video"), dict) else {}
        fallback_video = _detect_video_intent(state) or {}
        prompt = str(video_payload.get("prompt") or fallback_video.get("prompt") or last_user).strip() or last_user
        duration = _bounded_int(video_payload.get("duration") or fallback_video.get("duration"), default=10)
        aspect_ratio = _normalize_aspect_ratio(
            video_payload.get("aspect_ratio") or fallback_video.get("aspect_ratio") or "16:9",
            default="16:9",
        )
        image_urls = _normalize_image_urls(video_payload.get("image_urls")) or _normalize_image_urls(
            fallback_video.get("image_urls")
        )
        decision["video_args"] = {
            "prompt": prompt,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "image_urls": image_urls,
            "scene_id": state.get("scene_id"),
        }
        if not assistant:
            decision["assistant"] = "好的，视频任务已提交。"
        return decision

    if action == "generate_flowchart":
        flowchart_payload = decision_raw.get("flowchart") if isinstance(decision_raw.get("flowchart"), dict) else {}
        prompt = str(flowchart_payload.get("prompt") or last_user).strip() or last_user
        current_mermaid = _normalize_flowchart_mermaid(str(flowchart_payload.get("current_mermaid") or ""))
        flowchart_args: Dict[str, Any] = {"prompt": prompt}
        if current_mermaid:
            flowchart_args["current_mermaid"] = current_mermaid
        decision["flowchart_args"] = flowchart_args
        if not assistant:
            decision["assistant"] = "好的，正在生成 Mermaid 流程图。"
        return decision

    # chat
    return decision


def _normalize_image_urls(value: Any) -> List[str] | None:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return None
    output = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return output or None


def _queue_get_with_timeout(result_queue: queue.Queue, tool_name: str, timeout_seconds: float) -> Dict[str, Any]:
    try:
        if timeout_seconds <= 0:
            return result_queue.get_nowait()
        return result_queue.get(timeout=timeout_seconds)
    except queue.Empty:
        seconds_label = f"{timeout_seconds:g}"
        return {
            "tool": tool_name,
            "result": {"error": f"{tool_name} timed out after {seconds_label}s"},
        }


def _image_tool_wait_timeout_seconds() -> float:
    raw = os.getenv("EXCALIDRAW_IMAGE_TOOL_WAIT_TIMEOUT_SECONDS", "1200")
    try:
        value = float(raw)
        return max(0.0, value)
    except Exception:
        return 1200


def _enqueue_video_job(args: Dict[str, Any]) -> Dict[str, Any]:
    prompt = str(args.get("prompt") or "").strip()
    scene_id = str(args.get("scene_id") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}
    if not scene_id:
        return {"error": "scene_id is required"}

    try:
        duration = int(args.get("duration") or 10)
    except Exception:
        duration = 10
    aspect_ratio = str(args.get("aspect_ratio") or "16:9").strip() or "16:9"
    image_urls = _normalize_image_urls(args.get("image_urls"))
    model_name = str(args.get("model") or "").strip()

    try:
        job = ExcalidrawVideoJob.objects.create(
            scene_id=scene_id,
            prompt=prompt,
            image_urls=image_urls or [],
            duration=max(1, duration),
            aspect_ratio=aspect_ratio,
            model_name=model_name,
            status=ExcalidrawVideoJob.Status.QUEUED,
        )
        run_excalidraw_video_job.apply_async(args=[str(job.id)], queue="excalidraw")
    except Exception as exc:
        return {"error": str(exc)}

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


def call_llm(state: ChatState) -> Iterator[Dict[str, Any]]:
    system_prompt = _build_system_prompt(
        state.get("scene_title", ""),
        state.get("summary_state") or {},
        state.get("memory_state") or {},
    )
    llm = _build_chat_model(streaming=True)
    lc_messages = _to_langchain_messages(system_prompt, state["messages"])

    content = ""

    media_action = _decide_media_action(state)
    if media_action and media_action.get("action") == "clarify":
        assistant_text = str(media_action.get("assistant") or "").strip()
        yield {
            "assistant": {
                "role": "assistant",
                "content": assistant_text,
            }
        }
        return

    if media_action and media_action.get("action") == "generate_flowchart":
        args = media_action.get("flowchart_args") if isinstance(media_action.get("flowchart_args"), dict) else {}
        flowchart_result = _generate_flowchart_result(args, state)
        yield {
            "tool_results": [
                {
                    "tool": "mermaid_flowchart",
                    "result": flowchart_result,
                }
            ]
        }
        assistant_text = str(media_action.get("assistant") or "").strip()
        if flowchart_result.get("error"):
            assistant_text = "流程图生成失败，请重试。"
        elif not assistant_text:
            assistant_text = "好的，已生成 Mermaid flowchart TD，可插入到画布。"
        yield {
            "assistant": {
                "role": "assistant",
                "content": assistant_text,
            }
        }
        return

    if media_action and media_action.get("action") == "generate_video":
        yield {"intent": "video"}
        args = media_action.get("video_args") if isinstance(media_action.get("video_args"), dict) else {}
        yield {
            "tool_results": [
                {
                    "tool": "videotool",
                    "result": _enqueue_video_job(args),
                }
            ]
        }
        assistant_text = str(media_action.get("assistant") or "好的，视频任务已提交。").strip()
        yield {
            "assistant": {
                "role": "assistant",
                "content": assistant_text,
            }
        }
        return

    if media_action and media_action.get("action") == "generate_image":
        yield {"intent": "image"}
        args = media_action.get("image_args") if isinstance(media_action.get("image_args"), dict) else {}
        image_queue = _start_image_job(args)
        assistant_text = str(media_action.get("assistant") or "好的，正在生成图片。").strip()
        content = assistant_text
        yield {
            "assistant": {
                "role": "assistant",
                "content": assistant_text,
            }
        }
        timeout_seconds = _image_tool_wait_timeout_seconds()
        yield {"tool_results": [_queue_get_with_timeout(image_queue, imagetool.name, timeout_seconds)]}
        return

    if not media_action:
        # Fallback only when planner fails: retain old heuristic behavior.
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
            yield {
                "tool_results": [
                    {
                        "tool": "videotool",
                        "result": _enqueue_video_job(args),
                    }
                ]
            }
            content = "好的，视频任务已提交。"
            yield {
                "assistant": {
                    "role": "assistant",
                    "content": content,
                }
            }
            return

        intent = _classify_image_intent(state) or {}
        if intent.get("use_image") is True:
            yield {"intent": "image"}
            args = {
                "prompt": intent.get("prompt") or state.get("last_user") or "",
                "size": intent.get("size") or "1024x1024",
                "scene_id": state.get("scene_id"),
            }
            image_queue = _start_image_job(args)
            content = "好的，正在生成图片。"
            yield {
                "assistant": {
                    "role": "assistant",
                    "content": content,
                }
            }
            timeout_seconds = _image_tool_wait_timeout_seconds()
            yield {"tool_results": [_queue_get_with_timeout(image_queue, imagetool.name, timeout_seconds)]}
            return

    try:
        for chunk in llm.stream(lc_messages):
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
