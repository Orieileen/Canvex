"""Adapter over browser-use — the SINGLE seam that tracks its fast-moving API.

Everything the rest of Canvex knows about "run a browser to do a task" lives
behind `run_browse(...) -> BrowseOutcome`. browser-use churns its public API
between minor versions; by funnelling every browser_use import + attribute
access through this one module, a version bump only ever touches this file (the
`browse` tool and the agent wiring depend only on the stable BrowseOutcome
shape).

Why SYNCHRONOUS (blocking) here, not a Celery job:
- The canvas agent loop runs in the WEB process (gunicorn gthread / runserver),
  synchronously inside the SSE StreamingHttpResponse generator — NOT in the
  --pool=gevent Celery worker. So a tool may block the turn and drive an async
  library via its own event loop, which is what makes `browse` genuinely
  agentic: the summary comes back in-turn and the model reasons over it.
- Running heavy Chromium in the web process is acceptable for Phase 1 / low
  concurrency. Phase 2 moves it to a dedicated prefork `worker_browser` queue or
  a browser microservice (mirroring the worker_canvas / worker_canvas_cpu split).

Two hard guarantees, both aimed at "a browse can NEVER hang the chat turn":
1. `max_steps` caps browser-use's own action loop.
2. A wall-clock timeout enforced by `asyncio.wait_for` INSIDE a dedicated daemon
   thread running a fresh event loop. The daemon thread means a wedged Chromium
   subprocess can't block the chat turn or interpreter shutdown (it may linger as
   an orphan the OS later reaps), and running in a fresh loop/thread avoids "this
   thread already has an event loop" issues under gthread. See `_run_coro_blocking`.

Gevent guard: mirrors the rembg guard in tools/image.py. asyncio on a
gevent-monkeypatched process deadlocks rather than erroring, so if this ever
runs under --pool=gevent we fail loud instead of hanging.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import threading
from dataclasses import dataclass, field

from django.conf import settings

logger = logging.getLogger(__name__)


class BrowserToolUnavailable(RuntimeError):
    """browser-use / playwright not installed, Chromium missing, or the process
    is gevent-monkeypatched. Surfaced to the tool layer as a friendly refusal
    rather than a 500 — the feature is optional and off by default."""


@dataclass
class BrowseScreenshot:
    """One captured frame. `png_bytes` is raw PNG; `caption` is a short human
    label (usually the page URL/title it was taken on)."""
    png_bytes: bytes
    caption: str = ""


@dataclass
class BrowseOutcome:
    """Stable return shape the rest of the app depends on. Only `summary` is
    guaranteed; screenshots / visited_urls are best-effort (browser-use exposes
    them differently across versions, so extraction is wrapped and never fatal)."""
    summary: str
    screenshots: list[BrowseScreenshot] = field(default_factory=list)
    visited_urls: list[str] = field(default_factory=list)
    steps: int = 0
    truncated: bool = False  # hit max_steps or the wall-clock timeout


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_browse(
    task: str,
    *,
    allowlist: list[str] | None = None,
    max_steps: int | None = None,
    timeout_seconds: int | None = None,
    max_screenshots: int | None = None,
) -> BrowseOutcome:
    """Run one autonomous browsing task to completion and return the outcome.

    Blocks the caller for up to `timeout_seconds`. Raises BrowserToolUnavailable
    if the optional deps are missing or the process is gevent-patched; every
    other browser-use / playwright error is caught and folded into a
    best-effort BrowseOutcome (a partial answer beats crashing the chat turn).
    """
    _assert_not_gevent()

    allowlist = allowlist if allowlist is not None else settings.CANVAS_BROWSER_ALLOWLIST
    max_steps = max_steps if max_steps is not None else settings.CANVAS_BROWSER_MAX_STEPS
    timeout_seconds = (
        timeout_seconds if timeout_seconds is not None
        else settings.CANVAS_BROWSER_TIMEOUT_SECONDS
    )
    max_screenshots = (
        max_screenshots if max_screenshots is not None
        else settings.CANVAS_BROWSER_MAX_SCREENSHOTS
    )

    def _make_coro():
        return _run_async(
            task,
            allowlist=allowlist,
            max_steps=max_steps,
            max_screenshots=max_screenshots,
        )

    try:
        return _run_coro_blocking(_make_coro, timeout_seconds)
    except BrowserToolUnavailable:
        raise
    except TimeoutError:
        logger.warning(
            "browse hit the %ss wall-clock limit: task=%r", timeout_seconds, task[:120]
        )
        return BrowseOutcome(
            summary=(
                f"The browsing task was stopped after the {timeout_seconds}s time "
                "limit before finishing. Report partial progress to the user and "
                "ask whether to narrow the task."
            ),
            truncated=True,
        )
    except Exception as exc:  # noqa: BLE001 — browser-use raises many provider/playwright types
        logger.exception("browse failed: task=%r", task[:120])
        return BrowseOutcome(
            summary=(
                f"The browsing task could not be completed ({type(exc).__name__}: "
                f"{str(exc)[:200]}). Tell the user browsing failed; do not invent results."
            ),
        )


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def _assert_not_gevent() -> None:
    """Fail loud if we're on a gevent-monkeypatched process (asyncio would
    deadlock). Shares the detector with tools/image.py's rembg guard."""
    from .tools.common import is_gevent_patched  # noqa: PLC0415 — local import of the shared detector

    if is_gevent_patched():
        raise BrowserToolUnavailable(
            "browse cannot run under a gevent-monkeypatched process — asyncio "
            "deadlocks there. The canvas agent loop must run in the web process "
            "(gunicorn gthread / runserver), not a Celery --pool=gevent worker."
        )


def _run_coro_blocking(make_coro, timeout_seconds: int):
    """Run an async coroutine to completion from sync code with a HARD deadline.

    Runs in a dedicated daemon thread with a fresh event loop so that (a) it is
    immune to whatever loop state the calling gthread has, and (b) a wedged
    browser subprocess can't block the turn or interpreter shutdown (it may linger
    as an OS orphan). `asyncio.wait_for` is the primary deadline; the outer
    `thread.join` is a backstop with slack.
    """
    box: dict = {}

    def worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            box["value"] = loop.run_until_complete(
                asyncio.wait_for(make_coro(), timeout=timeout_seconds)
            )
        except BaseException as exc:  # noqa: BLE001 — ferry any error across the thread boundary
            box["error"] = exc
        finally:
            # Cancel whatever browser-use / playwright left pending (websocket
            # readers, cleanup monitors) and let it unwind before closing, so a
            # timed-out browse doesn't emit "Task was destroyed but it is pending"
            # noise or orphan a Chromium. Bounded by the outer join backstop.
            try:
                pending = asyncio.all_tasks(loop)
                for task_ in pending:
                    task_.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:
                pass
            try:
                loop.close()
            except Exception:
                pass

    t = threading.Thread(target=worker, name="canvas-browse", daemon=True)
    t.start()
    # Slack beyond the inner asyncio deadline so wait_for is what fires normally;
    # the join timeout only trips if the thread itself is wedged below asyncio.
    t.join(timeout_seconds + 30)
    if t.is_alive():
        raise TimeoutError(f"browse worker thread still alive after {timeout_seconds}s")
    if "error" in box:
        err = box["error"]
        if isinstance(err, asyncio.TimeoutError):
            raise TimeoutError(str(err) or "browse timed out")
        raise err
    return box["value"]


# ---------------------------------------------------------------------------
# browser-use bindings (the version-sensitive part — keep ALL of it here)
# ---------------------------------------------------------------------------

async def _run_async(
    task: str,
    *,
    allowlist: list[str],
    max_steps: int,
    max_screenshots: int,
) -> BrowseOutcome:
    Agent, llm = _build_agent_deps()

    # Build the Agent defensively: browser-use has moved browser/allowed-domain
    # config across kwargs (browser_profile / browser_session / browser) between
    # versions. Try richer kwargs first, then progressively drop unknown ones so
    # a version mismatch degrades (no allowlist/headless enforcement) instead of
    # crashing. When the allowlist is empty we pass no allowed_domains at all.
    agent = _construct_agent(Agent, task=task, llm=llm, allowlist=allowlist)

    history = await agent.run(max_steps=max_steps)

    summary = _extract_summary(history)
    screenshots = _extract_screenshots(history, max_screenshots)
    visited = _extract_urls(history)
    steps = _extract_step_count(history)
    truncated = steps >= max_steps
    return BrowseOutcome(
        summary=summary or "(browser-use returned no textual result)",
        screenshots=screenshots,
        visited_urls=visited,
        steps=steps,
        truncated=truncated,
    )


def _build_agent_deps():
    """Import browser-use's Agent + construct its chat model.

    Chat model preference: browser-use ships its own ChatOpenAI (tuned for the
    tool schema it expects) in recent versions; older versions took a langchain
    BaseChatModel. Try browser-use's own first, then fall back to
    langchain_openai (already a repo dependency). Both accept an OpenAI-compatible
    base_url, so CANVAS_BROWSER_* (which falls back to CANVAS_CHAT_*) just works.
    """
    try:
        from browser_use import Agent  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise BrowserToolUnavailable(
            "browser-use is not installed. Enable the feature with "
            "`pip install -r requirements-browser.txt && python -m playwright "
            f"install chromium`. ({type(exc).__name__}: {exc})"
        ) from exc

    api_key = settings.CANVAS_BROWSER_API_KEY
    base_url = settings.CANVAS_BROWSER_BASE_URL or None
    model_name = settings.CANVAS_BROWSER_MODEL
    if not api_key:
        raise BrowserToolUnavailable(
            "CANVAS_BROWSER_API_KEY (or CANVAS_CHAT_API_KEY fallback) is required "
            "to drive the browser."
        )

    kwargs = {"model": model_name, "api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url

    # browser-use's own wrapper (preferred).
    try:
        from browser_use import ChatOpenAI as BUChatOpenAI  # noqa: PLC0415
        return Agent, BUChatOpenAI(**kwargs)
    except Exception:  # noqa: BLE001 — not present in this version, try llm submodule
        pass
    try:
        from browser_use.llm import ChatOpenAI as BUChatOpenAI2  # noqa: PLC0415
        return Agent, BUChatOpenAI2(**kwargs)
    except Exception:  # noqa: BLE001 — fall back to langchain_openai
        pass
    from langchain_openai import ChatOpenAI as LCChatOpenAI  # noqa: PLC0415
    return Agent, LCChatOpenAI(max_retries=3, timeout=60, **kwargs)


def _construct_agent(Agent, *, task: str, llm, allowlist: list[str]):
    """Construct browser-use Agent, threading headless + allowed_domains through
    whatever kwarg the installed version accepts. Progressive fallback: each
    attempt drops the kwargs the version rejected, ending at the minimal
    (task, llm) form that every version supports.

    An explicitly-configured allowlist is a SECURITY control: if the operator
    set a non-empty CANVAS_BROWSER_ALLOWLIST but this browser-use version can't
    enforce allowed_domains, we refuse rather than silently browse without it."""
    headless = settings.CANVAS_BROWSER_HEADLESS
    domains = list(allowlist) if allowlist else None

    try:
        from browser_use import BrowserProfile  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — old/unknown version without BrowserProfile
        BrowserProfile = None

    # Attempt 1: browser_profile with allowed_domains + headless.
    if BrowserProfile is not None and domains is not None:
        try:
            profile = BrowserProfile(headless=headless, allowed_domains=domains)
            return Agent(task=task, llm=llm, browser_profile=profile)
        except Exception as exc:  # noqa: BLE001
            raise BrowserToolUnavailable(
                "CANVAS_BROWSER_ALLOWLIST is set but this browser-use version does "
                "not support BrowserProfile(allowed_domains=...); refusing to browse "
                "without the allowlist. Upgrade browser-use, or clear the allowlist "
                "and rely on infra egress filtering."
            ) from exc
    # Attempt 2: headless via profile, no allowlist configured.
    if BrowserProfile is not None:
        try:
            return Agent(task=task, llm=llm, browser_profile=BrowserProfile(headless=headless))
        except Exception:  # noqa: BLE001
            logger.warning(
                "browse: browser_profile unsupported in this browser-use version; "
                "falling back to a bare Agent (headless not enforced)."
            )
    # Attempt 3: minimal form (headless governed by browser-use default / env).
    return Agent(task=task, llm=llm)


# --- best-effort extraction from the history object (all wrapped) -----------

def _safe(fn, default):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def _extract_summary(history) -> str:
    """final_result() is browser-use's documented accessor; fall back to str()."""
    val = _safe(lambda: history.final_result(), None)
    if not val:
        val = _safe(lambda: str(history), "")
    return (val or "").strip()


def _extract_urls(history) -> list[str]:
    urls = _safe(lambda: list(history.urls()), None)
    if urls is None:
        return []
    # de-dup, preserve order, drop falsy/None
    seen, out = set(), []
    for u in urls:
        u = str(u) if u else ""
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _extract_step_count(history) -> int:
    n = _safe(lambda: history.number_of_steps(), None)
    if isinstance(n, int):
        return n
    return _safe(lambda: len(history.history), 0)


def _extract_screenshots(history, max_screenshots: int) -> list[BrowseScreenshot]:
    """Pull up to `max_screenshots` frames. browser-use exposes screenshots as
    base64 strings or on-disk paths depending on version; normalise both to raw
    PNG bytes. Purely best-effort — any failure yields fewer/zero screenshots,
    never an error (the summary is the real payload)."""
    if max_screenshots <= 0:
        return []
    raw = _safe(lambda: history.screenshots(), None)
    if not raw:
        raw = _safe(lambda: getattr(history, "screenshot_paths", None), None)
    if not raw:
        return []

    shots: list[BrowseScreenshot] = []
    # Keep the LAST N (the most informative end-state frames), in chronological order.
    for item in list(raw)[-max_screenshots:]:
        data = _screenshot_item_to_png(item)
        if data:
            shots.append(BrowseScreenshot(png_bytes=data))
    return shots


def _screenshot_item_to_png(item) -> bytes | None:
    try:
        if isinstance(item, (bytes, bytearray)):
            return bytes(item)
        if isinstance(item, str):
            # data URI, bare base64, or a filesystem path
            if item.startswith("data:"):
                item = item.split(",", 1)[-1]
            if os.path.exists(item):
                with open(item, "rb") as fh:
                    return fh.read()
            # validate=True so malformed base64 raises (caught below → None) rather
            # than silently yielding garbage bytes persisted as a bogus screenshot.
            return base64.b64decode(item, validate=True)
    except Exception:  # noqa: BLE001
        return None
    return None
