"""Deterministic run-mode for saved RPA robots (影刀-style).

Executes a Robot's DSL steps step-by-step on a fresh Playwright session, WITHOUT the LLM
per step (the model is used only to self-heal a drifted locator). Streams per-step status
+ a page screenshot after each step as SSE event dicts, mirroring the chat stream's frame
shape so the frontend can reuse the monitor frame. Unlike stream_canvas_agent there is no
graph and no background pump: the run is sequential, so we drive the steps and yield
directly from this generator.

Safety (design §10/§11): a run-level wall-clock deadline bounds the whole run; a write-gate
refuses state-changing steps (destructive clicks / submits) unless the robot has
allow_writes; self-heal only retries READ steps (never a state-changing one), one attempt.
"""
import base64
import logging
import time
import uuid

from django.conf import settings

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
    _clamp_count,
    _clamp_ms,
    _nav_refusal,
    _op_click_target,
    _op_goto,
    _op_hover,
    _op_key,
    _op_screenshot,
    _op_scroll,
    _op_select,
    _op_type_target,
    _op_wait,
    _op_wait_for,
)

logger = logging.getLogger(__name__)

# Bound the step ARRAY length (a malformed/huge robot). Loop back-edges make the number of
# EXECUTED steps exceed this, so a separate _MAX_EXECUTED caps that; the run-level deadline
# bounds wall-clock either way.
_MAX_STEPS = 100
_MAX_EXECUTED = 500

# A click/submit whose target reads like one of these is treated as state-changing and
# gated behind Robot.allow_writes (default read-only). Substring match on name/text/css.
_DESTRUCTIVE_KEYWORDS = (
    "submit", "save", "pay", "buy", "order", "checkout", "purchase", "delete", "remove",
    "confirm", "send", "publish", "transfer", "withdraw", "apply", "place order",
    "提交", "保存", "支付", "付款", "购买", "下单", "结算", "删除", "移除", "确认", "发送",
    "发布", "转账", "提现",
)


def _is_state_changing(step: dict) -> bool:
    """True if a step may mutate external state (needs allow_writes). A type with submit, a
    bare Enter keypress (submits the focused form), or a click on a destructive-looking
    control; navigate / wait / scroll / hover / select / plain type / other keys are read."""
    action = step.get("action")
    if action == "type" and step.get("submit"):
        return True
    if action == "key" and str(step.get("key") or "").lower() == "enter":
        return True
    if action != "click":
        return False
    tgt = step.get("target") or {}
    hay = f"{tgt.get('name', '')} {tgt.get('text', '')} {tgt.get('css', '')}".lower()
    return any(kw in hay for kw in _DESTRUCTIVE_KEYWORDS)


def _shot_data_url(session) -> str | None:
    try:
        raw = session.call(_op_screenshot)
        return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    except Exception:  # noqa: BLE001 — a screenshot failure must never fail the run
        return None


def _execute_step(session, step: dict, target_override: dict | None = None) -> None:
    """Run one step on the session (raises LocatorMiss/LocatorAmbiguous/etc. on failure).
    loop_start/loop_end are control-only and never reach here (stream_robot_run drives the
    program counter); they're accepted as no-ops for safety."""
    action = step.get("action")
    target = target_override if target_override is not None else (step.get("target") or {})
    if action == "navigate":
        url = (step.get("url") or "").strip()
        refusal = _nav_refusal(url)
        if refusal:
            raise RuntimeError(refusal)
        session.call(_op_goto, url)
    elif action == "click":
        session.call(_op_click_target, target)
    elif action == "type":
        session.call(_op_type_target, target, step.get("text") or "", bool(step.get("submit")))
    elif action == "wait":
        session.call(_op_wait, _clamp_ms(step.get("ms"), 1000))
    elif action == "wait_for":
        session.call(_op_wait_for, target, _clamp_ms(step.get("ms"), 10000))
    elif action == "key":
        session.call(_op_key, str(step.get("key") or ""))
    elif action == "scroll":
        session.call(_op_scroll, target)
    elif action == "hover":
        session.call(_op_hover, target)
    elif action == "select":
        session.call(_op_select, target, str(step.get("value") or ""))
    elif action in ("loop_start", "loop_end"):
        pass  # control-only; the PC/loop-stack in stream_robot_run handles the jump
    else:
        raise RuntimeError(f"unknown action {action!r}")


def _self_heal(session, target: dict) -> dict | None:
    """READ-step only: ask the browser model to re-locate a drifted element from the
    CURRENT page's ARIA snapshot; return a new target {role, name} or None. Disabled
    (returns None) when no browser model is configured. A light safety check rejects a
    heal that changes the element's ROLE (don't rebind to a different kind of control)."""
    if not settings.CANVAS_BROWSER_API_KEY:
        return None
    try:
        import json  # noqa: PLC0415
        import re  # noqa: PLC0415

        from .tools.browser_primitives import _get_extract_model, _op_snapshot  # noqa: PLC0415

        snapshot = (session.call(_op_snapshot) or "")[:6000]
        desc = (
            target.get("description") or target.get("name") or target.get("text")
            or target.get("role") or target.get("css")
        )
        prompt = (
            "You relocate a web element after the page changed. The element I want is: "
            f"{desc!r} (role hint: {target.get('role')!r}).\n"
            "Below is the CURRENT page's ARIA accessibility snapshot (roles + accessible "
            "names). Identify the single matching element and return ONLY a JSON object "
            '{"role": "...", "name": "..."} (its ARIA role + accessible name), or {} if it '
            "is not present. No prose.\n\nSNAPSHOT:\n" + snapshot
        )
        resp = _get_extract_model().invoke(prompt)
        text = getattr(resp, "content", resp)
        if isinstance(text, list):
            text = "".join(
                str(p.get("text", "") if isinstance(p, dict) else p) for p in text
            )
        text = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", str(text).strip())
        data = json.loads(text)
        role, name = data.get("role"), data.get("name")
        if role and (not target.get("role") or role == target.get("role")):
            return {"role": role, "name": name or ""}
    except Exception:  # noqa: BLE001 — self-heal is best-effort; fall back to surfacing the miss
        logger.info("robot self-heal failed", exc_info=True)
    return None


def stream_robot_run(robot_id: str, *, scene_id: str):
    """Run a saved Robot's steps deterministically, yielding SSE event dicts:
    - {event: robot_step, index, action, status: running|ok|failed, error?, healed?}
    - {event: browse_frame, image, final}  (per-step page screenshot; reuses the monitor)
    The RobotRun row records status/error for history."""
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
    allow_writes = robot.allow_writes
    deadline = time.monotonic() + max(30, settings.CANVAS_BROWSER_ROBOT_RUN_DEADLINE)
    failed: str | None = None
    # Program counter + loop stack: loop_start/loop_end are markers that jump `pc` (a loop
    # back-edge re-runs the enclosed body), so this is a while-loop over `pc`, not a for-loop
    # over `enumerate`. `executed` bounds total steps run since a back-edge can exceed len(steps).
    pc = 0
    loop_stack: list[dict] = []
    executed = 0
    try:
        while pc < len(steps):
            step = steps[pc]
            action = step.get("action")

            if executed >= _MAX_EXECUTED:
                failed = f"run exceeded the {_MAX_EXECUTED}-step execution cap (loop too large?)"
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                       "status": "failed", "error": "loop step cap exceeded"}
                break
            executed += 1
            if time.monotonic() > deadline:
                failed = f"run exceeded the {settings.CANVAS_BROWSER_ROBOT_RUN_DEADLINE}s deadline"
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                       "status": "failed", "error": "run timed out"}
                break

            # Loop markers: no browser work + no screenshot; emit status then jump the PC.
            if action in ("loop_start", "loop_end"):
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action, "status": "running"}
                next_pc = pc + 1
                if action == "loop_start":
                    loop_stack.append({"start": pc, "left": _clamp_count(step.get("count"))})
                elif loop_stack:
                    frame = loop_stack[-1]
                    frame["left"] -= 1
                    if frame["left"] > 0:
                        next_pc = frame["start"] + 1  # re-run the loop body
                    else:
                        loop_stack.pop()
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action, "status": "ok"}
                pc = next_pc
                continue

            # Write-gate: destructive clicks / submits only run on an allow_writes robot.
            if _is_state_changing(step) and not allow_writes:
                failed = f"step {pc + 1} ({action}) is state-changing; robot is read-only"
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                       "status": "failed", "error": "write-gated: enable allow_writes to run this"}
                break

            yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action, "status": "running"}
            healed = False
            try:
                _execute_step(session, step)
            except (LocatorMiss, LocatorAmbiguous) as exc:
                # Self-heal a READ step once (never a state-changing one — a wrong heal
                # there could click the wrong destructive control).
                new_target = None if _is_state_changing(step) else _self_heal(session, step.get("target") or {})
                if new_target is not None:
                    try:
                        _execute_step(session, step, target_override=new_target)
                        healed = True
                    except Exception as exc2:  # noqa: BLE001
                        failed = f"step {pc + 1} ({action}) failed after self-heal: {type(exc2).__name__}"
                        yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                               "status": "failed", "error": f"self-heal: {str(exc2)[:150]}"}
                        break
                else:
                    failed = f"step {pc + 1} ({action}): {type(exc).__name__}: {exc}"
                    yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                           "status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:150]}"}
                    break
            except PlaywrightSessionClosed:
                failed = f"step {pc + 1}: browser session closed"
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                       "status": "failed", "error": "browser session closed"}
                break
            except Exception as exc:  # noqa: BLE001 — Playwright raises many nav/locator errors
                failed = f"step {pc + 1} ({action}): {type(exc).__name__}: {str(exc)[:150]}"
                yield {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action,
                       "status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:150]}"}
                break

            img = _shot_data_url(session)
            if img:
                yield {"event": StreamEvent.BROWSE_FRAME, "image": img, "final": False}
            ok_event = {"event": StreamEvent.ROBOT_STEP, "index": pc, "action": action, "status": "ok"}
            if healed:
                ok_event["healed"] = True
            yield ok_event
            pc += 1
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
