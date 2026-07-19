"""RPA v2 authoring tools — the Agent drives the user's OWN browser via the Canvex
extension (影刀-style RPA), NOT a server-side Playwright browser (that hits the anti-bot
wall on real sites). Two tools, meant to run in ONE turn:

  1. browser_open_and_snapshot(url) — opens a tab in the user's browser (extension),
     takes an accessibility-tree snapshot, and returns the interactive elements (with
     `ref` ids) for the Agent to reference.
  2. commit_robot_steps(steps) — the Agent's drafted steps; each `ref` is resolved to a
     durable rich locator, each `uncertain` step asks the user to CLICK the element in
     their own page (the extension shows a banner). The assembled steps are laid down as
     editable step cards on the canvas.

Transport (see AI-RPA-v2-PHASE4-plan.md): the tool runs on the stream pump thread; it
EMITS an `ext_command` SSE frame (ctx.emit_ext_command) that the frontend relays to the
extension, then BLOCKS on ext_rendezvous until the extension's result comes back as a
separate flow/ext-result POST. Heartbeat frames keep the SSE warm while it blocks.
"""
import logging
import re
from uuid import uuid4

from django.conf import settings
from langchain.tools import ToolRuntime, tool

from .. import ext_rendezvous
from ..context import CanvasAgentContext
from .browser_primitives import _nav_refusal
from .image import REFUSED_PREFIX

logger = logging.getLogger(__name__)

# Per-op waits for the extension to answer (seconds). A human pick is slow — its wait is
# generous and heartbeat-covered; the others are page ops. Kept under the frontend's
# sendExtCommand timeouts so the backend gives up first and refuses cleanly.
_OPEN_TIMEOUT = 30.0
_SNAPSHOT_TIMEOUT = 25.0
_REF_LOCATOR_TIMEOUT = 20.0
_PICK_TIMEOUT = 200.0
_HEARTBEAT_INTERVAL = 10.0

# Roles worth showing the Agent for step drafting (interactive controls). Landmarks /
# headings / images are dropped from the compact list so the ref list stays under the
# tool-result clamp and focuses on things you can click / type into.
_INTERACTIVE_ROLES = {
    "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch",
    "slider", "spinbutton",
}
_ROLE_RE = re.compile(r"^\s*-\s+(\S+)")


def _ext_command(ctx: CanvasAgentContext, op: str, *, timeout: float, **fields) -> dict:
    """Emit ONE ext_command to the user's browser and block for its result.

    Registers the rendezvous BEFORE emitting (so a fast result can't be lost), emits an
    `op:"heartbeat"` frame every ~10s while waiting (keeps the byteless chat SSE past a
    reverse-proxy idle timeout), and honors client disconnect via ctx.is_aborted. Returns
    the extension's reply payload, or `{"error": ...}` on timeout / abort."""
    command_id = uuid4().hex
    token = ctx.session_token
    ext_rendezvous.register(token, command_id)

    def _heartbeat() -> None:
        emit = ctx.emit_ext_command
        if emit:
            emit({"command_id": command_id, "token": token, "op": "heartbeat"})

    ctx.emit_ext_command({"command_id": command_id, "token": token, "op": op, **fields})
    try:
        result = ext_rendezvous.wait(
            token, command_id,
            timeout=timeout,
            should_abort=ctx.is_aborted,
            on_heartbeat=_heartbeat,
            heartbeat_interval=_HEARTBEAT_INTERVAL,
        )
    except ext_rendezvous.ExtCommandTimeout:
        return {"error": f"the browser did not respond to `{op}` in time"}
    except ext_rendezvous.ExtCommandAborted:
        return {"error": "aborted"}
    return result if isinstance(result, dict) else {"error": "malformed extension result"}


def _compact_interactive(snap_text: str, max_chars: int = 1800) -> str:
    """Keep only interactive-role lines from the AXTree snapshot, so the ref list the
    Agent reads fits the tool-result clamp and centers on actionable elements."""
    kept = []
    total = 0
    for line in (snap_text or "").splitlines():
        m = _ROLE_RE.match(line)
        if not m:
            continue
        tok = m.group(1)
        # Keep interactive roles AND role-less clickables: an empty-role line
        # (`-  "name" [ref_N]` from a div[onclick] / [tabindex] / href-less <a> / custom
        # element) has its first token start with `"` (the name) or `[` (the ref), never a
        # role word — those are genuinely clickable and must not be dropped.
        if tok not in _INTERACTIVE_ROLES and not tok.startswith(('"', '[')):
            continue
        stripped = line.strip()
        if total + len(stripped) + 1 > max_chars:
            kept.append("… (more elements omitted — draft from what's shown)")
            break
        kept.append(stripped)
        total += len(stripped) + 1
    return "\n".join(kept)


def _guard(runtime) -> tuple[CanvasAgentContext | None, str | None]:
    """Shared preflight for both tools. Returns (ctx, refusal_string). If refusal_string
    is set, the tool must return it."""
    if not settings.CANVAS_RPA_ENABLED:
        return None, (
            f"{REFUSED_PREFIX} RPA authoring is disabled on this deployment "
            "(CANVAS_RPA_ENABLED is off). Tell the user it's unavailable."
        )
    if runtime is None or runtime.context is None:
        raise RuntimeError("RPA authoring tools require CanvasAgentContext via ToolRuntime")
    ctx = runtime.context
    # emit_ext_command is installed only on the streaming path — RPA can't work without a
    # client to relay commands to the extension.
    if ctx.emit_ext_command is None:
        return None, (
            f"{REFUSED_PREFIX} RPA authoring only works from the live chat stream. "
            "Tell the user to try again."
        )
    if not ctx.ext_available:
        return None, (
            "The Canvex browser extension isn't installed or enabled, so I can't drive "
            "your browser. Tell the user: install/enable the Canvex extension (chrome://"
            "extensions → Developer mode → Load unpacked → the `extension/` folder), then "
            "RELOAD this page and ask again. Do NOT fall back to a server browser."
        )
    return ctx, None


@tool
def browser_open_and_snapshot(
    url: str = "",
    runtime: ToolRuntime[CanvasAgentContext] = None,
) -> str:
    """Open a page in the USER'S OWN browser (via the Canvex extension) and read its
    interactive elements, to start authoring a reusable RPA robot. Real IP + real login
    state, so it works on sites that block server-side browsers.

    Args:
        url: the page to open first, a full public http(s) URL. If the user gave one, pass
            it; otherwise ask them for it — do NOT guess a URL.

    Returns the page's interactive elements, each with a `ref` id. Then DRAFT the whole
    step list and call `commit_robot_steps` IN THE SAME TURN — reference these `ref`s for
    elements you can identify, and mark ones you're unsure about `uncertain` so the user
    is asked to click them."""
    ctx, refusal = _guard(runtime)
    if refusal:
        return refusal
    site = (url or "").strip()
    if not site:
        return (
            "To open the authoring browser I need the starting page. Ask the user for the "
            "full URL (https://…), then call browser_open_and_snapshot again. Don't guess."
        )
    nav_refusal = _nav_refusal(site)
    if nav_refusal:
        return nav_refusal

    log = ctx.emit_browse_log
    if log:
        log("🤖 开始编写机器人(你的浏览器)")
        log(f"▶️ 打开 {site}")

    opened = _ext_command(ctx, "open_tab", url=site, timeout=_OPEN_TIMEOUT)
    if opened.get("error"):
        return (
            f"Couldn't open {site} in your browser ({opened['error']}). If the Canvex "
            "extension isn't running, tell the user to enable it and retry."
        )
    tab_id = opened.get("tabId")

    snap_res = _ext_command(ctx, "snapshot", tabId=tab_id, timeout=_SNAPSHOT_TIMEOUT)
    snap = snap_res.get("snap") or {}
    if snap_res.get("error") or snap.get("error"):
        return f"Opened {site} but couldn't read the page ({snap_res.get('error') or snap.get('error')})."

    # Remember the authoring tab + snapshot epoch for commit_robot_steps (same turn/ctx).
    ctx.rpa_authoring = {"tab_id": tab_id, "epoch": snap.get("epoch"), "url": opened.get("url") or site}

    interactive = _compact_interactive(snap.get("text") or "")
    title = opened.get("title") or ""
    return (
        f'Opened "{title}" ({opened.get("url") or site}) in the user\'s browser. '
        f"Interactive elements (reference these ref ids when drafting steps):\n"
        f"{interactive or '(no interactive elements detected)'}\n\n"
        "Now DRAFT the full step list and call commit_robot_steps(steps) in this turn. "
        "Each step is an object:\n"
        '  {"action":"navigate","url":"https://…"}  — go to a page\n'
        '  {"action":"click","ref":"ref_N"}          — click an element you identified above\n'
        '  {"action":"type","ref":"ref_N","text":"…","submit":true}  — type + optional Enter\n'
        '  {"action":"click","uncertain":true,"label":"the Add-to-cart button"}  — you\'re '
        "unsure which element; the user will be asked to click it\n"
        "Use a `ref` when you can identify the element; otherwise set uncertain:true with a "
        "clear `label`. Never invent a ref that wasn't listed."
    )


@tool
def commit_robot_steps(
    steps: list[dict] = None,
    runtime: ToolRuntime[CanvasAgentContext] = None,
) -> str:
    """Finalize the drafted RPA steps into editable step cards on the canvas. Resolves each
    `ref` to a durable locator and, for any `uncertain` step, asks the user to CLICK the
    element in their own browser. Call AFTER browser_open_and_snapshot, in the same turn.

    Args:
        steps: the drafted step list. Each item:
            {"action":"navigate","url":...} |
            {"action":"click"|"type","ref":"ref_N", "text"?:..., "submit"?:bool} |
            {"action":"click"|"type","uncertain":true,"label":"what to click", "text"?:...}
    """
    ctx, refusal = _guard(runtime)
    if refusal:
        return refusal
    if not isinstance(steps, list) or not steps:
        return "No steps to commit. Draft at least one step, then call commit_robot_steps."
    authoring = ctx.rpa_authoring
    if not authoring or authoring.get("tab_id") is None:
        return (
            "No authoring browser is open. Call browser_open_and_snapshot(url) first (in "
            "this turn), then commit_robot_steps."
        )
    tab_id = authoring["tab_id"]
    epoch = authoring.get("epoch")

    final: list[dict] = []
    notes: list[str] = []
    for i, raw in enumerate(steps):
        if not isinstance(raw, dict):
            continue
        action = (raw.get("action") or "").strip()
        if action == "navigate":
            url = (raw.get("url") or "").strip()
            if not url:
                notes.append(f"step {i + 1}: navigate with no url — skipped")
                continue
            final.append({"action": "navigate", "url": url, "provenance": "guessed"})
            continue
        if action not in ("click", "type"):
            notes.append(f"step {i + 1}: unknown action {action!r} — skipped")
            continue

        ref = raw.get("ref")
        locator = None
        provenance = "guessed"
        used_ref = None

        if ref and not raw.get("uncertain"):
            res = _ext_command(ctx, "ref_locator", tabId=tab_id, ref=ref, epoch=epoch,
                               timeout=_REF_LOCATOR_TIMEOUT)
            loc = res.get("locator")
            if isinstance(loc, dict) and not loc.get("error"):
                locator, used_ref = loc, ref
            else:
                notes.append(f"step {i + 1}: {ref} didn't resolve — asked the user to pick it")

        if locator is None:
            # Uncertain, or a ref that went stale → ask the user to click it in their page.
            label = (raw.get("label") or raw.get("text") or f"the target for step {i + 1}").strip()
            res = _ext_command(ctx, "pick", tabId=tab_id, label=label, timeout=_PICK_TIMEOUT)
            if res.get("error") == "aborted":
                return "Authoring was interrupted — the chat stream closed. Nothing was saved."
            loc = res.get("locator")
            if isinstance(loc, dict) and not loc.get("error"):
                locator, used_ref, provenance = loc, res.get("ref"), "picked"
            else:
                notes.append(f"step {i + 1}: no element picked ({res.get('error') or 'skipped'})")
                continue

        step = {"action": action, "target": locator, "provenance": provenance}
        if used_ref:
            step["ref"] = used_ref
        if action == "type":
            # Never persist plaintext into a password field (design §11): the emitted
            # robot_steps land in scene.data, which _strip_inlined_secrets only scrubs at
            # Robot SAVE — not on this path. Blank it at the source.
            step["text"] = "" if locator.get("isPassword") else (raw.get("text") or "")
            if raw.get("submit"):
                step["submit"] = True
        final.append(step)

    if not final:
        return "None of the drafted steps could be finalized. " + (" ".join(notes) or "")

    emit_steps = ctx.emit_robot_steps
    if emit_steps:
        emit_steps(final)

    summary = "、".join(
        s["action"] + (f'→{s["target"].get("name") or s["target"].get("css")}' if s.get("target") else f'→{s.get("url","")}')
        for s in final
    )
    tail = (" 备注:" + "；".join(notes)) if notes else ""
    return (
        f"已生成 {len(final)} 步机器人并放到画布上:{summary}。"
        f"告诉用户可以在步卡上编辑、点「保存机器人」、然后「在我的浏览器运行」。{tail}"
    )
