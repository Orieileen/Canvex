"""Deterministic run-mode for saved RPA robots (影刀-style).

Executes a Robot's DSL steps step-by-step on a fresh Playwright session, WITHOUT the LLM
(self-heal is a later step). Streams per-step status + a page screenshot after each step
as SSE event dicts, mirroring the chat stream's frame shape so the frontend can reuse the
monitor frame. Unlike stream_canvas_agent there is no graph and no background pump: the
run is sequential, so we drive the steps and yield directly from this generator.
"""
import base64
import logging
import uuid

from studio.models import Robot, RobotRun

from .builder import StreamEvent
from .playwright_session import (
    PlaywrightSessionClosed,
    PlaywrightUnavailable,
    close_session,
    get_or_create_session,
)
from .tools.browser_primitives import (
    LocatorAmbiguous,
    LocatorMiss,
    _nav_refusal,
    _op_click_target,
    _op_goto,
    _op_screenshot,
    _op_type_target,
)

logger = logging.getLogger(__name__)

# Bound step COUNT so a malformed/huge robot can't pin a worker (a run-level wall-clock
# deadline is a later step; per-op timeout already bounds each step via session.call).
_MAX_STEPS = 100


def _shot_data_url(session) -> str | None:
    try:
        raw = session.call(_op_screenshot)
        return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    except Exception:  # noqa: BLE001 — a screenshot failure must never fail the run
        return None


def stream_robot_run(robot_id: str, *, scene_id: str):
    """Run a saved Robot's steps deterministically, yielding SSE event dicts:
    - {event: robot_step, index, action, status: running|ok|failed, error?}
    - {event: browse_frame, image, final}  (per-step page screenshot; reuses the monitor)
    NO LLM. The RobotRun row records status/error for history."""
    robot = Robot.objects.filter(id=robot_id, scene_id=scene_id).first()
    if robot is None:
        yield {"event": StreamEvent.ERROR, "detail": "robot not found"}
        return
    run = RobotRun.objects.create(robot=robot, status=RobotRun.Status.RUNNING)

    token = f"robotrun:{uuid.uuid4().hex}"
    try:
        session = get_or_create_session(token)
    except PlaywrightUnavailable as exc:
        run.status = RobotRun.Status.FAILED
        run.error = f"browser unavailable: {exc}"
        run.save(update_fields=["status", "error", "updated_at"])
        yield {"event": StreamEvent.ERROR, "detail": run.error}
        return

    steps = (robot.steps or [])[:_MAX_STEPS]
    failed: str | None = None
    try:
        for i, step in enumerate(steps):
            action = step.get("action")
            yield {"event": StreamEvent.ROBOT_STEP, "index": i, "action": action, "status": "running"}
            try:
                if action == "navigate":
                    url = (step.get("url") or "").strip()
                    refusal = _nav_refusal(url)
                    if refusal:
                        raise RuntimeError(refusal)
                    session.call(_op_goto, url)
                elif action == "click":
                    session.call(_op_click_target, step.get("target") or {})
                elif action == "type":
                    session.call(
                        _op_type_target, step.get("target") or {}, step.get("text") or "", False
                    )
                else:
                    raise RuntimeError(f"unknown action {action!r}")
            except (LocatorMiss, LocatorAmbiguous) as exc:
                failed = f"step {i + 1} ({action}): {type(exc).__name__}: {exc}"
                yield {"event": StreamEvent.ROBOT_STEP, "index": i, "action": action,
                       "status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:180]}"}
                break
            except PlaywrightSessionClosed:
                failed = f"step {i + 1}: browser session closed"
                yield {"event": StreamEvent.ROBOT_STEP, "index": i, "action": action,
                       "status": "failed", "error": "browser session closed"}
                break
            except Exception as exc:  # noqa: BLE001 — Playwright raises many nav/locator errors
                failed = f"step {i + 1} ({action}): {type(exc).__name__}: {str(exc)[:180]}"
                yield {"event": StreamEvent.ROBOT_STEP, "index": i, "action": action,
                       "status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:180]}"}
                break
            img = _shot_data_url(session)
            if img:
                yield {"event": StreamEvent.BROWSE_FRAME, "image": img, "final": False}
            yield {"event": StreamEvent.ROBOT_STEP, "index": i, "action": action, "status": "ok"}
        # End-state freeze frame (final=True so the client persists it to the monitor).
        final_img = _shot_data_url(session)
        if final_img:
            yield {"event": StreamEvent.BROWSE_FRAME, "image": final_img, "final": True}
    finally:
        try:
            close_session(token)
        except Exception:  # noqa: BLE001
            logger.exception("stream_robot_run: close_session failed")
        run.status = RobotRun.Status.FAILED if failed else RobotRun.Status.SUCCEEDED
        run.error = failed or ""
        try:
            run.save(update_fields=["status", "error", "updated_at"])
        except Exception:  # noqa: BLE001
            logger.exception("stream_robot_run: run.save failed")
