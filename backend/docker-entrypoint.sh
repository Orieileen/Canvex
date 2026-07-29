#!/usr/bin/env bash
# Container entrypoint.
#
# When the app is configured for a HEADED browser (CANVAS_BROWSER_HEADLESS=false)
# start an in-container Xvfb virtual display so Playwright can launch a REAL
# (non-headless) Chromium. Headed Chromium is far less likely to trip anti-bot
# detection than headless, and the on-canvas Live frame + takeover keep working
# unchanged because they go through Playwright (page.screenshot / mouse / keyboard),
# not through the OS display.
#
# Headless (the default) needs no display, so we skip Xvfb entirely and the
# original behavior is preserved byte-for-byte.
set -e

_headless="$(printf '%s' "${CANVAS_BROWSER_HEADLESS:-true}" | tr '[:upper:]' '[:lower:]')"
case "$_headless" in
  0 | false | no | off)
    if [ -z "${DISPLAY:-}" ]; then
      export DISPLAY=":99"
      # A stale lock from a crashed prior Xvfb (same container restarted in place)
      # would make Xvfb refuse to start; clear it first.
      rm -f "/tmp/.X${DISPLAY#:}-lock" 2>/dev/null || true
      Xvfb "$DISPLAY" -screen 0 "${CANVAS_XVFB_WHD:-1440x900x24}" -nolisten tcp \
        >/tmp/xvfb.log 2>&1 &
      # Wait (<=5s) for the X server socket before handing off to the app so the
      # first Chromium launch doesn't race a not-yet-ready display.
      for _ in $(seq 1 50); do
        [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
        sleep 0.1
      done
      echo "[entrypoint] headed browser: Xvfb on DISPLAY=$DISPLAY" >&2
    fi
    ;;
  *)
    : # headless (default): no virtual display needed
    ;;
esac

exec "$@"
