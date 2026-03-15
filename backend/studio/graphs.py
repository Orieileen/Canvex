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
    """LangGraph 状态对象，在图的所有节点之间共享。
    由前端 API 层构造后传入 chat_graph.invoke()，各节点读写其中的字段。"""

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
_FLOWCHART_QUOTED_EDGE_LABEL_RE = re.compile(r'(\|)\s*"([^"]*?)"\s*(\|)')
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
# Tiny helpers — 消除重复的小工具函数
# ---------------------------------------------------------------------------

def _flatten_content(value: Any) -> str:
    """将 LLM 返回的 content（可能是 str 或 list）统一为纯字符串。"""
    if isinstance(value, list):
        return "".join(str(c.get("text", "") if isinstance(c, dict) else c) for c in value)
    return str(value or "")


def _get_dict_field(mapping: dict, key: str) -> Dict[str, Any]:
    """从 dict 中安全取出子 dict，非 dict 时返回空 dict。"""
    val = mapping.get(key)
    return val if isinstance(val, dict) else {}


def _normalize_video_size(value: Any, default: str = "1280x720") -> str:
    """将视频尺寸值标准化为小写无空格格式。"""
    return str(value or default).strip().lower().replace(" ", "")


# ---------------------------------------------------------------------------
# Model helpers — 构建 LLM 实例与提示词
# ---------------------------------------------------------------------------

def _build_chat_model(streaming: bool) -> ChatOpenAI:
    """构建 ChatOpenAI 实例，所有参数从环境变量读取。

    参数:
        streaming: 是否启用流式输出。call_llm 的 chat 分支传 True，
                   其余所有需要一次性 JSON 返回的场景传 False。
    返回:
        ChatOpenAI 实例。被 _invoke_json、call_llm 等几乎所有需要调用 LLM 的函数使用。
    """
    params: Dict[str, Any] = {
        "model": os.getenv("CHAT_MODEL", "gpt-4o-mini"),
        "temperature": float(os.getenv("CHAT_TEMPERATURE", "0.4")),
        "streaming": streaming,
    }
    max_tokens = os.getenv("CHAT_MAX_TOKENS")
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
    """拼装 Canvex Copilot 的系统提示词，包含角色定义、回复策略、场景上下文和用户记忆。

    参数:
        scene_title:    当前画布场景标题，来自 ChatState["scene_title"]。
        summary_state:  当前对话摘要状态，来自 ChatState["summary_state"]（load_memory 节点填充）。
        memory_state:   长期记忆状态，来自 ChatState["memory_state"]（load_memory 节点填充）。
    返回:
        完整的系统提示词字符串。仅被 call_llm 的 chat 分支使用，传给 _to_langchain_messages。
    """
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
    """将前端传来的消息列表转换为 LangChain BaseMessage 序列。

    参数:
        system_prompt: 由 _build_system_prompt 生成的系统提示词。
        messages:      ChatState["messages"]，前端传入的 [{"role": "user"|"assistant", "content": "..."}] 列表。
    返回:
        以 SystemMessage 开头、HumanMessage/AIMessage 交替的列表。
        被 call_llm 的 chat 分支用于 llm.stream() 调用。
    """
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
    """向 LLM 发送一次性请求并将返回内容解析为 JSON dict。

    参数:
        llm:           由 _build_chat_model(streaming=False) 创建的非流式模型实例。
        system_prompt: 角色设定提示词（如 "You are Canvex media action router."）。
        user_prompt:   包含具体任务说明和 schema 的用户提示词。
    返回:
        解析后的 dict，或解析失败时返回 None。
        被 _decide_media_action、_generate_flowchart_result、update_memory 使用，
        用于获取意图分类、流程图 Mermaid 代码、摘要/记忆更新等结构化结果。
    """
    response = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt),
    ])
    content = _flatten_content(getattr(response, "content", "")).strip()
    if not content:
        return None
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# Normalizers — 输入值标准化
# ---------------------------------------------------------------------------

def _normalize_image_size(value: Any, default: str = "1024x1024") -> str:
    """将图片尺寸值标准化为 "宽x高" 格式（如 "1024x1024"）。

    参数:
        value:   LLM 返回的 image.size 字段，可能是任意类型。来自 _decide_media_action 解析的 LLM 输出。
        default: 不合法时的默认尺寸。
    返回:
        合法的尺寸字符串。被 _decide_media_action 在 generate_image 分支中使用，
        最终传入 image_args 供 _start_image_job 调用 imagetool。
    """
    raw = str(value or "").strip().lower().replace(" ", "")
    return raw if _IMAGE_SIZE_RE.match(raw) else default


def _normalize_image_urls(value: Any) -> List[str] | None:
    """将图片 URL 输入标准化为字符串列表或 None。

    参数:
        value: LLM 返回的 image_urls 字段，可能是单个字符串、列表或其他类型。
               来自 _decide_media_action 或 _enqueue_video_job 的入参。
    返回:
        非空字符串列表或 None。被 _decide_media_action（video 分支）和
        _enqueue_video_job 使用，作为视频生成的参考图片列表。
    """
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return None
    output = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return output or None


# ---------------------------------------------------------------------------
# Flowchart helpers — 流程图生成与校验
# ---------------------------------------------------------------------------

def _extract_mermaid_block(value: str) -> str:
    """从可能包含 markdown 代码块的文本中提取纯 Mermaid 内容。

    参数:
        value: LLM 返回的原始文本，可能被 ```mermaid ... ``` 包裹。
               来自 _normalize_flowchart_mermaid 传入。
    返回:
        去除代码块标记后的纯 Mermaid 文本。仅被 _normalize_flowchart_mermaid 调用。
    """
    text = str(value or "").strip()
    if not text:
        return ""
    match = _FLOWCHART_MERMAID_BLOCK_RE.search(text)
    return (match.group(1) or "").strip() if match else text


def _normalize_flowchart_mermaid(value: str) -> str:
    """标准化 Mermaid 流程图文本：去除代码块、统一首行为 "flowchart TD"、清理空行。

    参数:
        value: 原始 Mermaid 文本，来自 LLM 输出或用户传入的 current_mermaid。
    返回:
        标准化后的 Mermaid 字符串，首行固定为 "flowchart TD"。
        被 _generate_flowchart_result（生成/修复流程图时）和
        _decide_media_action（解析 flowchart.current_mermaid 时）使用。
    """
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

    # Strip quotes from edge labels: |"text"| → |text|
    lines = [_FLOWCHART_QUOTED_EDGE_LABEL_RE.sub(r'\1\2\3', line) for line in lines]

    return "\n".join(lines)


def _validate_flowchart_td_mermaid(mermaid_text: str) -> str | None:
    """校验 Mermaid 流程图文本是否符合前端渲染要求。

    参数:
        mermaid_text: 经 _normalize_flowchart_mermaid 标准化后的 Mermaid 文本。
    返回:
        校验通过返回 None；不通过返回描述错误原因的字符串。
        被 _generate_flowchart_result 调用，用于判断生成结果是否需要修复。
    """
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
    """构建流程图生成的 LLM 提示词，包含 schema、约束规则和用户请求。

    参数:
        prompt:          用户的流程图生成请求文本，来自 _generate_flowchart_result 的 args["prompt"]。
        current_mermaid: 可选的已有 Mermaid 代码（用于增量编辑），来自 args["current_mermaid"]。
    返回:
        完整的提示词字符串。仅被 _generate_flowchart_result 传入 _invoke_json 使用。
    """
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
        "- Always use quoted labels for nodes, e.g. A1[\"Start\"], B2[\"Review\"]\n"
        "- Edge labels must NOT use quotes. Use A1 -->|some text| B1, never A1 -->|\"some text\"| B1.\n"
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
    """调用 LLM 生成 Mermaid 流程图，校验失败时自动尝试一次修复。

    参数:
        args:  来自 _decide_media_action 返回的 flowchart_args，包含 prompt 和可选 current_mermaid。
        state: 当前 ChatState，用于在 args 缺少 prompt 时从 last_user 取值。
    返回:
        成功时返回 {"format", "diagram_type", "direction", "mermaid"} 字典；
        失败时返回 {"error": "..."} 字典。
        被 call_llm 的 generate_flowchart 分支调用，结果通过 tool_results yield 给前端。
    """
    prompt = str(args.get("prompt") or state.get("last_user") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}

    current_mermaid = str(args.get("current_mermaid") or "").strip()
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
            "- Use quoted labels for nodes only, e.g. A1[\"...\"]\n"
            "- Edge labels must NOT use quotes. Use A1 -->|some text| B1, not A1 -->|\"text\"| B1.\n"
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
# Media action router — 通过单次 LLM 调用判断用户意图
# ---------------------------------------------------------------------------

def _build_media_action_prompt(state: ChatState) -> str:
    """构建意图路由的 LLM 提示词，包含 action schema、摘要/记忆上下文和用户最新消息。

    参数:
        state: 当前 ChatState，从中读取 summary_state、memory_state 和 last_user。
               由 _decide_media_action 传入。
    返回:
        完整的提示词字符串。仅被 _decide_media_action 传入 _invoke_json 使用。
    """
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
    """通过 LLM 判断用户意图，返回结构化的 action 字典；LLM 失败时默认返回 chat。

    参数:
        state: 当前 ChatState，由 call_llm 节点传入。
               从中读取 last_user（用户最新消息）、summary_state、memory_state、scene_id。
    返回:
        包含 "action" 键的字典，action 值为 _MEDIA_ACTIONS 之一。
        根据 action 不同，还包含:
        - clarify:            assistant（追问文本）
        - generate_image:     assistant + image_args（prompt, size, scene_id）
        - generate_video:     assistant + video_args（prompt, seconds, size, image_urls, scene_id）
        - generate_flowchart: assistant + flowchart_args（prompt, current_mermaid）
        - chat:               仅 action 字段
        仅被 call_llm 调用，用于决定走哪条处理分支。
    """
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
        image_payload = _get_dict_field(decision_raw, "image")
        decision["image_args"] = {
            "prompt": str(image_payload.get("prompt") or last_user).strip(),
            "size": _normalize_image_size(image_payload.get("size")),
            "scene_id": state.get("scene_id"),
        }

    elif action == "generate_video":
        video_payload = _get_dict_field(decision_raw, "video")
        decision["video_args"] = {
            "prompt": str(video_payload.get("prompt") or last_user).strip(),
            "seconds": video_payload.get("seconds") or 12,
            "size": _normalize_video_size(video_payload.get("size")),
            "image_urls": _normalize_image_urls(video_payload.get("image_urls")),
            "scene_id": state.get("scene_id"),
        }

    elif action == "generate_flowchart":
        fc_payload = _get_dict_field(decision_raw, "flowchart")
        flowchart_args: Dict[str, Any] = {"prompt": str(fc_payload.get("prompt") or last_user).strip()}
        current_mermaid = _normalize_flowchart_mermaid(str(fc_payload.get("current_mermaid") or ""))
        if current_mermaid:
            flowchart_args["current_mermaid"] = current_mermaid
        decision["flowchart_args"] = flowchart_args

    return decision


# ---------------------------------------------------------------------------
# Video / image job helpers — 提交生成任务
# ---------------------------------------------------------------------------

def _enqueue_video_job(args: Dict[str, Any]) -> Dict[str, Any]:
    """校验参数后创建 ExcalidrawVideoJob 记录并发送 Celery 异步任务。

    参数:
        args: 来自 _decide_media_action 返回的 video_args 字典，包含:
              prompt, seconds, size, image_urls, scene_id。
    返回:
        成功时返回 {"job_id", "task_id", "status", "scene_id", "poll_url"}；
        参数校验失败时返回 {"error": "..."}。
        被 call_llm 的 generate_video 分支调用，结果通过 tool_results yield 给前端。
    """
    prompt = str(args.get("prompt") or "").strip()
    scene_id = str(args.get("scene_id") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}
    if not scene_id:
        return {"error": "scene_id is required"}

    try:
        seconds = int(args.get("seconds") or 12)
    except (ValueError, TypeError):
        seconds = 12
    if seconds not in _VIDEO_ALLOWED_SECONDS:
        return {"error": f"video seconds must be one of {list(_VIDEO_ALLOWED_SECONDS)}"}

    size = _normalize_video_size(args.get("size"))
    aspect_ratio = _VIDEO_ASPECT_RATIO_BY_SIZE.get(size)
    if not aspect_ratio:
        return {"error": f"video size must be one of {list(_VIDEO_ASPECT_RATIO_BY_SIZE)}"}

    image_urls = args.get("image_urls")
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
    """在后台线程中启动 imagetool 图片生成，返回用于接收结果的队列。

    参数:
        args: 来自 _decide_media_action 返回的 image_args 字典，包含 prompt, size, scene_id。
              直接透传给 imagetool.invoke()。
    返回:
        queue.Queue 实例，线程完成后会放入 {"tool": imagetool.name, "result": ...}。
        被 call_llm 的 generate_image 分支调用，调用方通过 queue.get(timeout=...) 等待结果。
    """
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
    """从环境变量读取图片生成的最大等待秒数（默认 1200 秒）。

    返回:
        超时秒数。仅被 call_llm 的 generate_image 分支用于 image_queue.get(timeout=...)。
    """
    return float(os.getenv("IMAGE_TOOL_WAIT_TIMEOUT_SECONDS", "1200"))


# ---------------------------------------------------------------------------
# Graph nodes — LangGraph 图节点（按执行顺序: load_memory → call_llm → update_memory）
# ---------------------------------------------------------------------------

def load_memory(state: ChatState) -> Dict[str, Any]:
    """图的入口节点：从 Redis 加载当前场景的摘要状态和长期记忆。

    参数:
        state: ChatState，从中读取 workspace_id 和 scene_id 来定位 Redis key。
               如果 state 中已有 summary_state/memory_state（前端预填），则直接使用。
    返回:
        {"summary_state": ..., "memory_state": ...}，合并回 ChatState 供后续节点使用。
        下游节点: call_llm。
    """
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")
    return {
        "summary_state": state.get("summary_state") or get_summary_state(workspace_id, scene_id),
        "memory_state": state.get("memory_state") or get_memory_state(workspace_id, scene_id),
    }


def call_llm(state: ChatState) -> Iterator[Dict[str, Any]]:
    """图的核心节点：根据用户意图执行对应的处理分支，以 generator 方式 yield 流式结果。

    参数:
        state: ChatState，由 load_memory 节点填充了 summary_state 和 memory_state。
               从中读取 last_user、messages、scene_title、scene_id 等字段。
    yield 输出（按分支）:
        - clarify:            yield assistant（追问文本）
        - generate_flowchart: yield tool_results（Mermaid 结果）+ assistant
        - generate_video:     yield intent("video") + tool_results（job 信息）+ assistant
        - generate_image:     yield intent("image") + assistant + tool_results（图片结果）
        - chat:               yield 多次 assistant（流式累积文本）
    下游节点: update_memory。assistant 和 tool_results 会写入 ChatState 供 update_memory 读取。
    """
    media_action = _decide_media_action(state)
    action = media_action["action"]

    # --- clarify: 追问用户补充信息 ---
    if action == "clarify":
        yield {"assistant": {"role": "assistant", "content": media_action.get("assistant", "")}}
        return

    # --- generate_flowchart: 生成 Mermaid 流程图 ---
    if action == "generate_flowchart":
        args = media_action.get("flowchart_args", {})
        result = _generate_flowchart_result(args, state)
        yield {"tool_results": [{"tool": "mermaid_flowchart", "result": result}]}
        text = media_action.get("assistant", "")
        if result.get("error"):
            text = "流程图生成失败，请重试。"
        yield {"assistant": {"role": "assistant", "content": text}}
        return

    # --- generate_video: 提交视频生成任务 ---
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

    # --- generate_image: 启动图片生成并等待结果 ---
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

    # --- chat: 普通对话，流式输出 ---
    system_prompt = _build_system_prompt(
        state.get("scene_title", ""),
        state.get("summary_state") or {},
        state.get("memory_state") or {},
    )
    llm = _build_chat_model(streaming=True)
    lc_messages = _to_langchain_messages(system_prompt, state["messages"])

    content = ""
    for chunk in llm.stream(lc_messages):
        delta = _flatten_content(getattr(chunk, "content", ""))
        if delta:
            content += delta
            yield {"assistant": {"role": "assistant", "content": content}}


# ---------------------------------------------------------------------------
# Memory update — 对话后更新摘要与长期记忆
# ---------------------------------------------------------------------------

def _flatten_summary_entries(summary_state: Dict[str, Any]) -> List[str]:
    """将摘要状态中的各字段展平为 "类型:内容" 格式的字符串列表。

    参数:
        summary_state: 单个摘要快照（可能来自历史记录中的某一轮），由 _collect_stable_entries 传入。
    返回:
        如 ["goal:xxx", "constraint:yyy", "decision:zzz"] 的字符串列表。
        仅被 _collect_stable_entries 使用，用于统计各条目在历史窗口中的出现频次。
    """
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
    """从摘要历史窗口中筛选出稳定条目（出现次数 >= MEMORY_STABILITY_MIN_COUNT）。

    参数:
        history: 摘要快照列表，由 append_summary_history 返回。
                 每个元素是一轮对话后的 summary_state 快照。
    返回:
        达到稳定阈值的条目列表。被 update_memory 使用，
        当列表非空时触发长期记忆更新。
    """
    window = history[-MEMORY_STABILITY_WINDOW:] if MEMORY_STABILITY_WINDOW > 0 else history
    counts: Counter[str] = Counter()
    for snapshot in window:
        for entry in _flatten_summary_entries(snapshot):
            counts[entry] += 1
    return [entry for entry, count in counts.items() if count >= MEMORY_STABILITY_MIN_COUNT]


def update_memory(state: ChatState) -> Dict[str, Any]:
    """图的末尾节点：根据本轮对话更新摘要状态，并在条目稳定时更新长期记忆。

    参数:
        state: ChatState，从中读取:
               - summary_state / memory_state: 当前摘要和记忆（load_memory 填充）
               - last_user: 用户最新消息（前端传入）
               - assistant: call_llm 生成的助手回复
               - workspace_id / scene_id: 用于定位 Redis key
    返回:
        {"summary_state": ..., "memory_state": ...}，更新后的状态会合并回 ChatState。
        同时将更新结果写入 Redis 持久化。
        这是图的终止节点，之后流转到 END。
    """
    summary_state = normalize_summary_state(state.get("summary_state"))
    memory_state = normalize_memory_state(state.get("memory_state"))
    last_user = state.get("last_user") or ""
    assistant = (state.get("assistant") or {}).get("content") or ""
    if not last_user and not assistant:
        return {"summary_state": summary_state, "memory_state": memory_state}

    llm = _build_chat_model(streaming=False)
    workspace_id = state.get("workspace_id") or "public"
    scene_id = state.get("scene_id")

    # 更新摘要状态
    exchange = f"user: {last_user}\nassistant: {assistant}".strip()
    schema = json.dumps(normalize_summary_state(None), ensure_ascii=False, indent=2)
    current = json.dumps(summary_state, ensure_ascii=False, indent=2)
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

    # 检查稳定条目 → 触发长期记忆更新
    history = append_summary_history(workspace_id, scene_id, summary_state)
    stable_entries = _collect_stable_entries(history)
    if stable_entries:
        mem_schema = json.dumps(normalize_memory_state(None), ensure_ascii=False, indent=2)
        mem_current = json.dumps(memory_state, ensure_ascii=False, indent=2)
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
# Graph — 组装 LangGraph 有向图: load_memory → call_llm → update_memory → END
# ---------------------------------------------------------------------------

def build_chat_graph():
    """构建并编译 LangGraph 聊天图。

    返回:
        编译后的 CompiledGraph 实例，赋值给模块级变量 chat_graph。
        外部通过 chat_graph.invoke(state) 或 chat_graph.stream(state) 调用。
    """
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
