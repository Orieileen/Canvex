import type { WheelEvent as ReactWheelEvent } from "react";

/**
 * Wheel forwarder for any UI sitting above Excalidraw with
 * `pointer-events-auto` (toolbars, mockup gizmos, etc.). The interactive
 * canvas would otherwise lose pan/zoom whenever the cursor sat over the
 * overlay. Re-dispatch the wheel event on Excalidraw's own canvas so
 * scrolling continues to move the scene.
 */
export function forwardWheelToExcalidrawCanvas(e: ReactWheelEvent<HTMLElement>) {
  const canvas = document.querySelector<HTMLElement>(
    ".excalidraw .interactive, .excalidraw canvas",
  );
  if (!canvas) return;
  canvas.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    }),
  );
}
