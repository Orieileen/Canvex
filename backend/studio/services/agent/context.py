"""Per-invocation agent context (Canvex 独立版).

Passed to `agent.invoke(..., context=CanvasAgentContext(...))` on every chat call.
Tools read it via `runtime: ToolRuntime[CanvasAgentContext]` to know which scene
to attribute generated assets to.

StoreBackend namespace factory also reads `scene_id` to scope /memories/ files
per-scene (so "scene A's memory" never leaks to "scene B").

解耦自 meired apps/canvas/services/agent/context.py:
- meired 多租户的 org_id / user_id 字段已删 —— Canvex 单工作区, 模型无
  organization / user, 没有跨租户归属面。只保留 scene_id + attachment_urls。
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from uuid import uuid4


@dataclass
class CanvasAgentContext:
    scene_id: str
    # Stable per-turn token identifying this run's browser session in the process
    # registry (playwright_session._sessions). Replaces id(context) as the key so the
    # session can be (a) reached from a SEPARATE HTTP request — the RPA element-pick
    # POST echoes this token to find the same live page — and (b) never GC-id-reused.
    # Every turn gets a fresh one; the streaming layer emits it so the client can
    # correlate a pick to this turn's browser. Identity-equal to id(context) today
    # (runtime.context IS this object) so the switch is behavior-preserving.
    session_token: str = field(default_factory=lambda: uuid4().hex)
    # RPA authoring keeps the browser session alive ACROSS the streaming turn so the
    # user can pick elements after the SSE stream closes (a pick is a separate HTTP
    # request). When True, stream_canvas_agent SKIPS the turn-end close_session — the
    # idle self-reap (CANVAS_BROWSER_SESSION_IDLE_TIMEOUT) + an explicit close endpoint
    # bound the session instead. Default False = the normal per-turn web_operator
    # lifecycle (session closed at turn end, no Chromium lingering).
    keep_browser_session: bool = False
    # Image URLs attached to this turn via "Send to chat" on ImageEditBar.
    # generate_image / generate_video tools fall back to these when the
    # agent neglects to thread image_urls through itself — gpt-4o-mini
    # frequently hallucinates "I started the generation" without actually
    # calling the tool with the attachments. Empty list = no fallback.
    attachment_urls: list[str] = field(default_factory=list)
    # Canvas assets a tool produced synchronously THIS turn (e.g. browse
    # screenshots persisted as DataAssets). Tools append {"url": ...} dicts;
    # stream_canvas_agent drains this and emits one `canvas_asset` SSE frame each
    # so the frontend can place them on the board. Structured (not parsed from the
    # clamped tool_result text) so long summaries can't truncate the URLs. Dicts
    # (not bare strings) leave room for richer fields later. Empty = nothing to place.
    produced_assets: list[dict] = field(default_factory=list)
    # Live side-channel for streaming a sub-tool's progress to the SSE layer AS IT
    # HAPPENS, not just at graph-chunk boundaries. `stream_canvas_agent` sets this
    # to a callback that wraps each line into a `browse_log` frame and enqueues it
    # on the streaming queue; the `browse` tool calls it with browser-use step-log
    # lines from its worker thread (so the frontend can render them live in a
    # per-turn log frame). None on the non-streaming invoke path — tools then skip
    # live emission. MUST be thread-safe (browse runs in a daemon thread); the
    # callback stream_canvas_agent installs just does a thread-safe queue put.
    emit_browse_log: Callable[[str], None] | None = None
    # Sibling of emit_browse_log for the live browser MONITOR: streams a screenshot
    # per browser-use step to the SSE layer so the frontend can show the page as the
    # agent drives it. Args: (image, final) — `image` is a JPEG data-URL for live
    # frames or a persisted media URL for the final freeze frame; `final` flags the
    # last one so the frontend persists it to the monitor frame's customData (for
    # reload). None on the non-streaming path. Thread-safe (called from the browse
    # worker thread); the installed callback just does a queue put.
    emit_browse_frame: Callable[[str, bool], None] | None = None
    # RPA authoring: set by stream_canvas_agent; author_robot calls it AFTER opening a
    # live browser session to hand the client this turn's session_token + page viewport
    # for element picking. Emitting only on a real open keeps the token backed by a live
    # session (emitting every turn would 409 picks on turns that opened no browser).
    emit_flow_session: Callable[[str, dict], None] | None = None
