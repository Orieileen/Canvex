"""A thread-owned Playwright browser session for the web_operator subagent.

Playwright's SYNC objects are thread-affine — they must be used from the thread
that created them. LangGraph/deepagents may run tool nodes on pool threads, so we
cannot just create a page in one tool call and touch it in the next. Instead each
session OWNS its browser/page in a dedicated daemon thread; tool calls submit an
operation to a queue and block on the result, so every Playwright call runs in the
owner thread regardless of which thread the tool itself runs on. This mirrors the
"sensitive work in a dedicated thread" pattern used by browser_runner._run_coro_blocking.

Lifecycle:
- One session per chat turn, keyed by CanvasAgentContext.session_token in a process
  registry. Created lazily on first navigate. (The token — not id(context) — is the
  key so the RPA element-pick request can reach the same session from a SEPARATE HTTP
  request, and so a GC-reused id can't collide.)
- Torn down at turn end by stream_canvas_agent (close_session), with an IDLE
  SELF-REAP safety net (the owner thread exits if it gets no command for
  CANVAS_BROWSER_SESSION_IDLE_TIMEOUT) so a missed cleanup can't leak a Chromium.
- The existing browse concurrency semaphore is NOT taken here; the operator
  subagent holds ONE long-lived session per turn rather than many short browses.
  (Session count is bounded by concurrent turns, i.e. the web worker count.)

Gevent guard mirrors rembg / browse: sync Playwright would freeze a gevent loop, so
we fail loud rather than hang.
"""
from __future__ import annotations

import ipaddress
import logging
import queue
import socket
import threading
from urllib.parse import urlparse

from django.conf import settings

from .tools.common import ip_is_trusted_cidr, is_gevent_patched

logger = logging.getLogger(__name__)


class PlaywrightUnavailable(RuntimeError):
    """playwright not installed, Chromium missing, or the process is gevent-patched."""


class PlaywrightSessionClosed(RuntimeError):
    """The session's owner thread has exited (idle-reaped, closed, or crashed).
    The caller should re-navigate to start a fresh session."""


# Sentinel op that tells the owner thread to shut down cleanly.
_SHUTDOWN = object()

# Max seconds to wait for Chromium to launch before treating it as hung (bounds the
# registry-lock hold time on a wedged launch). Generous — a warm Chromium starts in
# a second or two.
_LAUNCH_TIMEOUT = 60

# Fixed viewport so the frontend's frame-pixel → page-coordinate inverse projection is
# stable and DPR-independent (device_scale_factor=1). Emitted to the client in the
# flow_session event; the RPA pick sends coordinates in this CSS-viewport space.
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 720


class PlaywrightSession:
    """Owns a headless Chromium page in a dedicated daemon thread. Submit ops with
    `call(fn, ...)` where `fn(page, *args, **kwargs)` runs in the owner thread."""

    def __init__(self):
        if is_gevent_patched():
            raise PlaywrightUnavailable(
                "Playwright sync API cannot run under a gevent-monkeypatched process; "
                "the web_operator must run in the web process (gthread), not a "
                "--pool=gevent worker."
            )
        self._cmd_q: queue.Queue = queue.Queue()
        self._started = threading.Event()
        self._start_error: BaseException | None = None
        self._idle_timeout = max(5, settings.CANVAS_BROWSER_SESSION_IDLE_TIMEOUT)
        self._thread = threading.Thread(
            target=self._run, name="canvas-web-operator", daemon=True
        )
        self._thread.start()
        # Bounded wait: a hung Chromium launch must not block the caller (and, via
        # get_or_create_session, must not hold the registry lock) forever. On
        # timeout the daemon thread is abandoned; it idle-reaps itself.
        if not self._started.wait(timeout=_LAUNCH_TIMEOUT):
            raise PlaywrightUnavailable(
                f"Chromium did not start within {_LAUNCH_TIMEOUT}s (launch hung)."
            )
        if self._start_error is not None:
            raise PlaywrightUnavailable(
                f"could not launch Chromium: {type(self._start_error).__name__}: "
                f"{self._start_error}"
            )

    # -- owner thread ------------------------------------------------------

    def _run(self):
        pw = browser = None
        try:
            from playwright.sync_api import sync_playwright  # noqa: PLC0415 — lazy/optional
            pw = sync_playwright().start()
            browser = pw.chromium.launch(
                headless=settings.CANVAS_BROWSER_HEADLESS,
                args=list(settings.CANVAS_BROWSER_CHROMIUM_ARGS),
            )
            page = browser.new_page(
                viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
                device_scale_factor=1,
            )
            # Network-layer SSRF + allowlist guard: aborts requests to blocked hosts
            # so click-through redirects and subresources are covered, not just the
            # explicit browser_navigate URL (see _host_blocked).
            page.route("**/*", _route_guard)
        except BaseException as exc:  # noqa: BLE001 — ferry launch failure to __init__
            self._start_error = exc
            self._started.set()
            _safe_close(browser, pw)
            return
        self._started.set()

        while True:
            try:
                item = self._cmd_q.get(timeout=self._idle_timeout)
            except queue.Empty:
                logger.info("web_operator session idle-reaped after %ss", self._idle_timeout)
                break
            fn, args, kwargs, box, done = item
            if fn is _SHUTDOWN:
                done.set()
                break
            try:
                box["value"] = fn(page, *args, **kwargs)
            except BaseException as exc:  # noqa: BLE001 — ferry op error across the queue
                box["error"] = exc
            finally:
                done.set()
        _safe_close(browser, pw)

    # -- caller side -------------------------------------------------------

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def call(self, fn, *args, timeout: float | None = None, **kwargs):
        """Run fn(page, *args, **kwargs) in the owner thread; block for the result.

        Raises PlaywrightSessionClosed if the owner thread is gone, TimeoutError if
        the op exceeds `timeout`, or re-raises whatever the op raised."""
        if not self._thread.is_alive():
            raise PlaywrightSessionClosed("web_operator session is no longer running")
        box: dict = {}
        done = threading.Event()
        self._cmd_q.put((fn, args, kwargs, box, done))
        wait = timeout if timeout is not None else settings.CANVAS_BROWSER_OP_TIMEOUT
        if not done.wait(wait):
            raise TimeoutError(f"browser operation exceeded {wait}s")
        if "error" in box:
            raise box["error"]
        return box["value"]

    def close(self):
        if not self._thread.is_alive():
            return
        done = threading.Event()
        try:
            self._cmd_q.put((_SHUTDOWN, (), {}, {}, done))
        except Exception:  # noqa: BLE001
            return
        done.wait(10)
        self._thread.join(timeout=15)


def _safe_close(browser, pw):
    for obj, meth in ((browser, "close"), (pw, "stop")):
        if obj is None:
            continue
        try:
            getattr(obj, meth)()
        except Exception:  # noqa: BLE001 — teardown best-effort
            logger.debug("web_operator teardown: %s.%s failed", type(obj).__name__, meth)


# Cache the block verdict for IP LITERALS only (their classification is deterministic
# and stable). DOMAIN verdicts are deliberately NOT cached — they must be re-resolved
# each request so a DNS-rebinding flip or a transient resolution failure is re-evaluated
# rather than frozen for the process lifetime.
_host_block_cache: dict[str, bool] = {}


def _ip_str_blocked(ip_str: str) -> bool:
    """True if an IP (literal or resolved) is NOT a public address — private / loopback
    / link-local / reserved (incl. 169.254 metadata + 198.18/15) / multicast /
    unspecified. An unparseable value fails CLOSED (blocked)."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    if ip_is_trusted_cidr(ip):
        return False  # declared egress-proxy range — reached through a trusted proxy
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def _host_blocked(host: str) -> bool:
    """True if a request host must be blocked (SSRF). An IP LITERAL is classified
    directly. A DOMAIN is DNS-RESOLVED and blocked if ANY resolved address is non-public
    (closes DNS-rebinding / redirect SSRF — the app-layer pre-check and the browser's
    fetch can resolve differently, so we block on the ACTUAL resolution); DNS failure
    fails CLOSED. Domain resolution is gated by CANVAS_BROWSER_SSRF_STRICT (default on;
    turn off only in environments with a fake/split DNS). A non-empty
    CANVAS_BROWSER_ALLOWLIST further restricts to listed host suffixes."""
    host = (host or "").lower()
    if not host:
        return True
    cached = _host_block_cache.get(host)
    if cached is not None:
        blocked = cached
    else:
        blocked = False
        cacheable = True
        try:
            ipaddress.ip_address(host)  # IP literal → classify directly (stable → cache)
            blocked = _ip_str_blocked(host)
        except ValueError:
            # Domain: resolve + block any non-public address (strict SSRF only). Do NOT
            # cache this verdict — re-resolve every request so a DNS-rebinding flip (short
            # TTL, the exact case this guard defends) can't slip past on a cached "public",
            # and a transient resolution failure can't permanently block a good host.
            cacheable = False
            if settings.CANVAS_BROWSER_SSRF_STRICT:
                try:
                    for info in socket.getaddrinfo(host, None):
                        if _ip_str_blocked(info[4][0]):
                            blocked = True
                            break
                except Exception:  # noqa: BLE001 — DNS failure → fail closed
                    blocked = True
        if cacheable:
            _host_block_cache[host] = blocked
    if blocked:
        return True
    allow = settings.CANVAS_BROWSER_ALLOWLIST
    if allow and not any(host == d or host.endswith("." + d) for d in allow):
        return True
    return False


def _route_guard(route):
    """Playwright route handler (runs in the owner thread): abort requests to blocked
    hosts, otherwise continue. Enforces SSRF + allowlist at the network layer so
    redirects and subresources are covered, not just explicit navigation."""
    try:
        if _host_blocked(urlparse(route.request.url).hostname or ""):
            route.abort()
            return
    except Exception:  # noqa: BLE001 — FAIL CLOSED: block on any guard error so a bug
        logger.warning("route guard error; blocking request", exc_info=True)  # here isn't an SSRF hole
        route.abort()
        return
    route.continue_()


# ---------------------------------------------------------------------------
# Per-turn session registry (keyed by CanvasAgentContext.session_token)
# ---------------------------------------------------------------------------
_sessions: dict[str, PlaywrightSession] = {}
_sessions_lock = threading.Lock()


def get_or_create_session(key: str) -> PlaywrightSession:
    """Return the live session for this turn key, creating one if absent/dead."""
    with _sessions_lock:
        s = _sessions.get(key)
        if s is not None and s.is_alive():
            return s
    # Construct OUTSIDE the lock — PlaywrightSession() blocks through the (seconds-
    # long, possibly hung) Chromium launch, and holding _sessions_lock across it
    # would serialize / deadlock every other session op. Re-check under the lock
    # afterward and discard ours if another thread won the race for this key.
    created = PlaywrightSession()  # may raise PlaywrightUnavailable
    winner = None
    with _sessions_lock:
        # Prune idle-reaped/dead entries (their owner thread has exited) so per-turn and
        # keep-alive tokens that are never close_session()ed don't accumulate for the life
        # of the process. is_alive() is a cheap, non-blocking thread check.
        for dead in [k for k, v in _sessions.items() if not v.is_alive()]:
            _sessions.pop(dead, None)
        existing = _sessions.get(key)
        if existing is not None and existing.is_alive():
            winner = existing
        else:
            _sessions[key] = created
            winner = created
    # close() can block ~25s (done.wait + join); do it OUTSIDE the lock so a race-loser's
    # teardown doesn't serialize every other registry op (the whole reason we construct
    # outside the lock above).
    if winner is not created:
        created.close()
    return winner


def close_session(key: str) -> None:
    """Tear down + forget the session for this turn key (idempotent)."""
    with _sessions_lock:
        s = _sessions.pop(key, None)
    if s is not None:
        s.close()


def get_session(key: str) -> PlaywrightSession | None:
    """Return the live session for this token, or None if absent/dead. Used by the
    RPA element-pick request — a SEPARATE HTTP request from the streaming turn — to
    reach the same live page WITHOUT creating one (a pick must never spin up a
    browser; a miss means the authoring session is gone and the client should re-arm)."""
    with _sessions_lock:
        s = _sessions.get(key)
    return s if s is not None and s.is_alive() else None
