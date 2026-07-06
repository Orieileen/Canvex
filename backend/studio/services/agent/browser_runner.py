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
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from django.conf import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Live step-log capture (browser-use logger → per-browse sink)
# ---------------------------------------------------------------------------
# browser-use narrates its progress ("📍 Step 1", "🧠 Memory", "🎯 Next goal",
# "▶️ navigate", …) through the `browser_use` / `bubus` loggers. We surface that
# live to the frontend by attaching ONE shared handler to those loggers and
# routing each record to the browse whose worker THREAD emitted it — browser-use
# runs its whole async step loop on the dedicated worker thread (see
# `_run_coro_blocking`), so `record.thread` uniquely identifies the browse even
# when CANVAS_BROWSER_MAX_CONCURRENCY lets two run at once. Thread-routing (not a
# per-browse addHandler) is what keeps concurrent browses from cross-talking:
# a logger handler otherwise sees records from every browse.
#
# TRADEOFF (accepted): routing on record.thread means any line browser-use logs
# from a DIFFERENT thread (a run_in_executor / to_thread pool thread, or a bubus
# dispatch thread) has no registered sink and is silently dropped. The load-bearing
# step narration is emitted from the worker's own event-loop thread so it's always
# captured; only incidental off-thread INFO would be missed. This is the price of
# per-browse isolation — the alternative (one sink, no routing) would cross-talk
# between concurrent browses, which is worse.
_LOG_LOGGER_NAMES = ("browser_use", "bubus")
_MAX_LOG_LINE_CHARS = 600
# Hard cap on how many step-log lines we forward per browse — a runaway page /
# retry loop must not flood the SSE stream (and the on-canvas log frame) with
# unbounded text. Well above a normal browse's line count.
_MAX_LOG_LINES = 800
# browser-use colourises its log messages with ANSI SGR escapes; strip them so
# the on-canvas panel shows clean text, not literal "\x1b[32m…[0m" garbage.
_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")
_log_sinks: dict[int, Callable[[str], None]] = {}
_log_sinks_lock = threading.Lock()
_log_handler_installed = False


class _ThreadRoutedLogHandler(logging.Handler):
    """Forward each browser-use log record to the sink registered for the thread
    that emitted it. No-op for records from threads without a browse in flight
    (i.e. everything else in the process). Never raises into the logging call."""

    def emit(self, record: logging.LogRecord) -> None:
        # Intentionally lock-free: a single dict.get is atomic under the GIL, and
        # taking _log_sinks_lock inside a logging handler (which runs mid-arbitrary
        # code, possibly holding other locks) risks lock-ordering trouble. Worst
        # case on a future free-threaded build is one dropped/garbled log line.
        sink = _log_sinks.get(record.thread)
        if sink is None:
            return
        try:
            line = self.format(record)
        except Exception:  # noqa: BLE001 — a bad format string must not break logging
            return
        line = _ANSI_SGR_RE.sub("", line).rstrip()
        if not line.strip():  # drop blank / whitespace-only spacer lines
            return
        try:
            sink(line[:_MAX_LOG_LINE_CHARS])
        except Exception:  # noqa: BLE001 — a wedged sink must not break logging
            pass


def _ensure_log_handler() -> None:
    """Install the shared handler once, lazily. Raises the browser-use loggers to
    INFO so the step narration reaches us even if the process quieted them; adds
    (never replaces) a handler, so browser-use's own stdout logging is untouched."""
    global _log_handler_installed
    if _log_handler_installed:
        return
    with _log_sinks_lock:
        if _log_handler_installed:
            return
        handler = _ThreadRoutedLogHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.setLevel(logging.INFO)
        for name in _LOG_LOGGER_NAMES:
            lg = logging.getLogger(name)
            lg.addHandler(handler)
            # Logger-level filtering happens BEFORE handlers, so INFO records
            # never reach our handler unless the logger passes INFO. We must
            # raise it (there's no per-handler way around logger-level filtering).
            # TRADEOFF (accepted): this is a global, unrestored bump — if an
            # operator had quieted browser_use to WARNING it's now INFO
            # process-wide, so its step narration also flows to root/stdout for
            # every later browse. browser-use defaults to INFO anyway, so this is
            # usually a no-op; the feature fundamentally needs INFO to exist.
            if not lg.isEnabledFor(logging.INFO):
                lg.setLevel(logging.INFO)
        _log_handler_installed = True


def _register_log_sink(thread_ident: int, sink: Callable[[str], None]) -> None:
    _ensure_log_handler()
    with _log_sinks_lock:
        _log_sinks[thread_ident] = sink


def _unregister_log_sink(thread_ident: int) -> None:
    with _log_sinks_lock:
        _log_sinks.pop(thread_ident, None)


def _bounded_sink(
    on_log_line: Callable[[str], None] | None,
) -> Callable[[str], None] | None:
    """Wrap `on_log_line` to forward at most `_MAX_LOG_LINES` lines (then one
    final truncation notice, then silence). Returns None when there's no consumer
    so the worker skips log-handler registration entirely."""
    if on_log_line is None:
        return None

    count = 0

    def sink(line: str) -> None:
        nonlocal count
        if count < _MAX_LOG_LINES:
            count += 1
            on_log_line(line)
        elif count == _MAX_LOG_LINES:
            count += 1
            on_log_line("… (browse log truncated)")

    return sink


class BrowserToolUnavailable(RuntimeError):
    """browser-use / playwright not installed, Chromium missing, or the process
    is gevent-monkeypatched. Surfaced to the tool layer as a friendly refusal
    rather than a 500 — the feature is optional and off by default."""


class BrowserBusy(BrowserToolUnavailable):
    """All concurrent browse slots are in use (the concurrency guard refused
    fast). A subclass of BrowserToolUnavailable so existing callers still handle
    it, but the tool layer catches it first to surface a 'retry shortly' message
    rather than 'unavailable'."""


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
# Concurrency guard
# ---------------------------------------------------------------------------
# A browse blocks its worker thread for up to CANVAS_BROWSER_TIMEOUT_SECONDS while
# driving Chromium. Without a cap, a burst of browse calls could pin every web
# (gthread) worker at once — stalling unrelated chat requests — and spawn unbounded
# Chromium instances (memory). This semaphore bounds concurrent browses to
# CANVAS_BROWSER_MAX_CONCURRENCY; excess calls are refused FAST (non-blocking) with
# BrowserBusy so their thread frees immediately instead of queuing (queuing would
# itself hold threads). Lazily built so the setting is read after Django configures.
#
# SCOPE: the semaphore is PER PROCESS. With N gunicorn workers the effective global
# cap is N × CANVAS_BROWSER_MAX_CONCURRENCY — an accepted approximation (a true
# cluster-wide limit would need a shared broker e.g. Redis). Size the setting with
# your worker count in mind.
_browse_semaphore: threading.BoundedSemaphore | None = None
_browse_semaphore_lock = threading.Lock()


def _browse_concurrency() -> int:
    return max(1, settings.CANVAS_BROWSER_MAX_CONCURRENCY)


def _get_browse_semaphore() -> threading.BoundedSemaphore:
    global _browse_semaphore
    if _browse_semaphore is None:
        with _browse_semaphore_lock:
            if _browse_semaphore is None:
                _browse_semaphore = threading.BoundedSemaphore(_browse_concurrency())
    return _browse_semaphore


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
    on_log_line: Callable[[str], None] | None = None,
) -> BrowseOutcome:
    """Run one autonomous browsing task to completion and return the outcome.

    Blocks the caller for up to `timeout_seconds`. Raises BrowserToolUnavailable
    if the optional deps are missing or the process is gevent-patched; every
    other browser-use / playwright error is caught and folded into a
    best-effort BrowseOutcome (a partial answer beats crashing the chat turn).

    `on_log_line`, if given, is called with each browser-use step-log line as it
    happens (from the browse worker thread) — the SSE layer uses it to stream the
    browse's progress live. Bounded by `_MAX_LOG_LINES`; forwarding failures are
    swallowed so a wedged consumer can never affect the browse.
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

    # Concurrency guard: refuse fast if all slots are busy (don't queue — that
    # would hold the worker thread we're trying to protect). Acquired here and
    # released in the finally so every return/raise path frees the slot.
    sem = _get_browse_semaphore()
    if not sem.acquire(blocking=False):
        raise BrowserBusy(
            f"all {_browse_concurrency()} browse slot(s) are in use; ask the user "
            "to retry in a moment"
        )
    try:
        return _run_coro_blocking(_make_coro, timeout_seconds, _bounded_sink(on_log_line))
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
    finally:
        sem.release()


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


def _run_coro_blocking(
    make_coro, timeout_seconds: int, on_log_line: Callable[[str], None] | None = None
):
    """Run an async coroutine to completion from sync code with a HARD deadline.

    Runs in a dedicated daemon thread with a fresh event loop so that (a) it is
    immune to whatever loop state the calling gthread has, and (b) a wedged
    browser subprocess can't block the turn or interpreter shutdown (it may linger
    as an OS orphan). `asyncio.wait_for` is the primary deadline; the outer
    `thread.join` is a backstop with slack.

    When `on_log_line` is set, the worker registers it as this thread's browse-log
    sink for the lifetime of the coroutine — browser-use logs from this thread's
    event loop then route to it (see `_ThreadRoutedLogHandler`).
    """
    box: dict = {}

    def worker():
        ident = threading.get_ident()
        if on_log_line is not None:
            _register_log_sink(ident, on_log_line)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            box["value"] = loop.run_until_complete(
                asyncio.wait_for(make_coro(), timeout=timeout_seconds)
            )
        except BaseException as exc:  # noqa: BLE001 — ferry any error across the thread boundary
            box["error"] = exc
        finally:
            if on_log_line is not None:
                _unregister_log_sink(ident)
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
        # The worker wedged below asyncio and its finally never ran, so its
        # sink is still registered — deregister it here (keyed by the worker's
        # own ident, t.ident) so a wedged-past-backstop browse can't leak a
        # _log_sinks entry for the life of the orphan thread.
        if on_log_line is not None and t.ident is not None:
            _unregister_log_sink(t.ident)
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
