"""In-process rendezvous for Agent → browser-extension commands (RPA v2 Phase 4).

The chat Agent runs its authoring tool on the stream pump thread
(`stream_canvas_agent._pump`). To drive the user's OWN browser it EMITS an `ext_command`
SSE frame (op = open_snapshot / pick / ref_locator / …) and then BLOCKS here until the
extension's result comes back — as a SEPARATE HTTP request (`FlowExtResultView`) that
lands on a different WSGI worker thread in the SAME process. This module is the meeting
point: the tool waits on a `threading.Event` keyed by (session_token, command_id); the
result POST resolves it.

Same in-process, single-worker assumption as `playwright_session._sessions`: it works
because `runserver` is one process, thread-per-request, so the pump thread and the
result-POST thread share this registry. Under multi-process (gunicorn prefork) the POST
could land on a different process than the blocked tool and never meet — a cross-process
deploy needs a shared store (Redis/DB). Documented here, matching playwright_session's note.

Auth model: the (token, command_id) pair IS the unguessable bearer — both are uuid4 hex
minted server-side and only reach the client via the SSE `ext_command` frame. `resolve`
returns False for an unknown pair so the endpoint can 409 rather than silently accept.

CONTRACT: the tool MUST `register()` BEFORE emitting the command frame, so a fast result
POST can't `resolve()` before the slot exists (no lost wakeup — resolve records the
result on the slot; wait returns it even if resolve raced ahead of the blocking wait).
"""
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class ExtCommandTimeout(Exception):
    """The extension never returned a result within the deadline."""


class ExtCommandAborted(Exception):
    """The wait was aborted — the client disconnected mid-command."""


@dataclass
class _Pending:
    event: threading.Event = field(default_factory=threading.Event)
    result: Any = None


_pending: dict[tuple[str, str], _Pending] = {}
_lock = threading.Lock()


def register(token: str, command_id: str) -> None:
    """Create the rendezvous slot. Call BEFORE emitting the command frame."""
    with _lock:
        _pending[(token, command_id)] = _Pending()


def resolve(token: str, command_id: str, result: Any) -> bool:
    """Deposit the extension's result and wake the waiting tool. Returns False if no slot
    is registered (the tool already timed out / the turn ended) so the caller can 409."""
    with _lock:
        pending = _pending.get((token, command_id))
        if pending is None:
            return False
        pending.result = result
        pending.event.set()
    return True


def cancel(token: str, command_id: str) -> None:
    """Drop the slot without resolving (tool error / cleanup). Idempotent."""
    with _lock:
        _pending.pop((token, command_id), None)


def wait(
    token: str,
    command_id: str,
    *,
    timeout: float,
    should_abort: Callable[[], bool] | None = None,
    on_heartbeat: Callable[[], None] | None = None,
    heartbeat_interval: float = 10.0,
    poll: float = 0.5,
) -> Any:
    """Block until the result POST resolves this command, then return the result.

    Raises ExtCommandTimeout after `timeout` seconds, or ExtCommandAborted if
    `should_abort()` becomes true (client disconnected). Calls `on_heartbeat()` about
    every `heartbeat_interval` seconds while waiting so a byteless SSE stream can't
    idle-timeout at a reverse proxy. Always drops the slot on exit.

    Requires `register()` to have run first; raises KeyError otherwise (a caller bug —
    registering late would lose a result that raced ahead of the wait).
    """
    with _lock:
        pending = _pending.get((token, command_id))
    if pending is None:
        raise KeyError(f"ext command not registered: {command_id}")
    deadline = time.monotonic() + max(0.0, timeout)
    last_beat = time.monotonic()
    try:
        while True:
            if pending.event.wait(poll):
                return pending.result
            now = time.monotonic()
            if should_abort is not None and should_abort():
                raise ExtCommandAborted(command_id)
            if now >= deadline:
                raise ExtCommandTimeout(command_id)
            if on_heartbeat is not None and (now - last_beat) >= heartbeat_interval:
                try:
                    on_heartbeat()
                except Exception:  # noqa: BLE001 — a heartbeat failure must not kill the wait
                    pass
                last_beat = now
    finally:
        cancel(token, command_id)
