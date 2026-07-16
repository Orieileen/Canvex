"""author_robot — start authoring a reusable browser-automation robot (影刀-style RPA).

Opens the deterministic Playwright session for the turn, navigates to a start URL, and
shows it on the canvas (a monitor frame via ctx.emit_browse_frame). Crucially it sets
ctx.keep_browser_session so the browser OUTLIVES the streaming turn — the user then
switches the on-canvas browser frame to Pick mode and clicks target elements, and each
pick is a SEPARATE HTTP request (FlowPickView) that reaches this same live page by the
session_token. This v1 tool opens + shows the browser; NL→DSL step drafting and the
editable step-cards build on top of it.
"""
import base64
import logging

from django.conf import settings
from langchain.tools import ToolRuntime, tool

from ..context import CanvasAgentContext
from ..playwright_session import (
    VIEWPORT_HEIGHT,
    VIEWPORT_WIDTH,
    PlaywrightUnavailable,
    get_or_create_session,
)
from .browser_primitives import _nav_refusal, _op_goto, _op_screenshot
from .image import REFUSED_PREFIX

logger = logging.getLogger(__name__)


def _jpeg_data_url(raw: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


@tool
def author_robot(
    task: str,
    start_url: str = "",
    runtime: ToolRuntime[CanvasAgentContext] = None,
) -> str:
    """Start authoring a reusable browser-automation robot ("影刀"-style RPA) from a
    natural-language task. Opens a browser ON THE CANVAS that the user can point at:
    they switch the browser frame to Pick mode and CLICK the elements the automation
    should act on — far more reliable than describing them in words.

    Args:
        task: what the automation should do, in the user's own words.
        start_url: the page to open first, a full public http(s) URL. If the user gave
            one, pass it; otherwise ask them for it — do NOT guess a URL.

    Use when the user asks to build / record / automate a repeatable browser task (e.g.
    "每天导出订单", "做个自动签到脚本"). After the browser opens, tell the user to switch
    the frame to Pick mode and click the target elements one by one; draft steps from
    what they pick — never invent a target you haven't been shown."""
    if not settings.CANVAS_RPA_ENABLED:
        return (
            f"{REFUSED_PREFIX} the RPA authoring feature is disabled on this deployment "
            "(CANVAS_RPA_ENABLED is off). Tell the user it's unavailable."
        )
    if runtime is None or runtime.context is None:
        raise RuntimeError("author_robot requires CanvasAgentContext via ToolRuntime")
    ctx = runtime.context

    url = (start_url or "").strip()
    if not url:
        return (
            "To open the authoring browser I need the starting page. Ask the user for "
            "the full URL of the site this automation runs on (https://…), then call "
            "author_robot again with start_url set. Do not guess the URL."
        )
    refusal = _nav_refusal(url)
    if refusal:
        return refusal

    # Keep the browser alive past this streaming turn — element picks are separate HTTP
    # requests that reach this same page by session_token (see FlowPickView).
    ctx.keep_browser_session = True
    try:
        session = get_or_create_session(ctx.session_token)
    except PlaywrightUnavailable as exc:
        ctx.keep_browser_session = False
        logger.warning("author_robot: browser unavailable: %s", exc)
        return (
            f"{REFUSED_PREFIX} the browser is not runnable right now ({exc}). Tell the "
            "user RPA authoring is unavailable; do not fabricate a robot."
        )

    # Surface progress on the on-canvas log frame; the frame the user picks on is the
    # monitor frame anchored to its right (created by the browse_frame below).
    log = ctx.emit_browse_log
    if log:
        log("🤖 开始编写机器人")
        log(f"▶️ 打开 {url}")
    try:
        session.call(_op_goto, url)
        # Hand the client this session's token + viewport BEFORE the first frame, so the
        # client marks the monitor as THIS authoring browser (pickable / drivable) before
        # the frame lands. A later plain-`browse` turn's frame (which carries NO
        # flow_session) then flips the monitor back to non-drivable — otherwise a drive
        # click would fire REAL input on this kept-alive authenticated browser while the
        # user sees an unrelated page (security review HIGH).
        emit_fs = ctx.emit_flow_session
        if emit_fs:
            emit_fs(ctx.session_token, {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT})
        emit = ctx.emit_browse_frame
        if emit:
            emit(_jpeg_data_url(session.call(_op_screenshot)), False)
    except Exception as exc:  # noqa: BLE001 — surface, never raise into the graph
        logger.exception("author_robot: open failed")
        return f"Opening {url} failed: {type(exc).__name__}: {str(exc)[:200]}"

    return (
        f"Opened {url} in the authoring browser (now shown on the canvas). Tell the "
        "user to switch the browser frame to Pick mode and click each element this "
        "automation should act on; I'll turn each pick into a step. Draft steps only "
        "from elements the user actually picks — do not guess targets."
    )
