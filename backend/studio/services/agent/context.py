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
    # registry (playwright_session._sessions). Serves the per-turn web_operator/browse
    # session AND (as the rendezvous key) the v2 extension flow/ext-result POST. A fresh
    # one per turn; identity-equal to id(context) today (runtime.context IS this object),
    # so keying by it is behavior-preserving.
    session_token: str = field(default_factory=lambda: uuid4().hex)
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
    # RPA v2 (Phase 4): set by stream_canvas_agent; the authoring tool calls it to send ONE
    # command (open tab / AXTree snapshot / ask user to pick / ref→locator) to the user's
    # browser EXTENSION, which the frontend relays. Arg: a command dict already carrying a
    # command_id + token + op. The extension's result returns as a separate flow/ext-result
    # POST that resolves the ext_rendezvous slot the tool is blocked on. None on the
    # non-streaming invoke path — the tool MUST null-check and refuse (no client to relay to).
    emit_ext_command: Callable[[dict], None] | None = None
    # RPA v2 (Phase 4): set by stream_canvas_agent; commit_robot_steps calls it with the
    # final drafted steps → one `robot_steps` frame → the client lays them down as step
    # cards. None on the non-streaming path.
    emit_robot_steps: Callable[[list], None] | None = None
    # RPA v2 (Phase 4): whether the user's browser has the Canvex extension (the frontend
    # reports it per chat request). False => browser_open_and_snapshot refuses and guides
    # the user to install it, rather than falling back to a server browser.
    ext_available: bool = False
    # True once the client has disconnected (set by stream_canvas_agent to the pump's
    # abort flag). A tool that BLOCKS (ext_rendezvous.wait during a human pick) polls this
    # so it can stop parking the pump thread after the user navigates away. None off-stream.
    is_aborted: Callable[[], bool] | None = None
    # RPA v2 (Phase 4): the current authoring browser tab the Agent opened this turn —
    # {tab_id, epoch, url}. Set by browser_open_and_snapshot, read by commit_robot_steps
    # (same turn/ctx) so snapshot → ref-locator / pick all pin to the same tab + snapshot.
    rpa_authoring: dict | None = None
