/** The wheel fields the forwarder needs — satisfied by both React's synthetic
 *  WheelEvent and the native WheelEvent, so callers can use it as a React
 *  `onWheel` handler OR pass a native event from an addEventListener handler. */
type WheelLike = Pick<
  WheelEvent,
  | "deltaX"
  | "deltaY"
  | "deltaZ"
  | "deltaMode"
  | "clientX"
  | "clientY"
  | "ctrlKey"
  | "shiftKey"
  | "metaKey"
  | "altKey"
>;

/**
 * Wheel forwarder for any UI sitting above Excalidraw with
 * `pointer-events-auto` (toolbars, mockup gizmos, etc.). The interactive
 * canvas would otherwise lose pan/zoom whenever the cursor sat over the
 * overlay. Re-dispatch the wheel event on Excalidraw's own canvas so
 * scrolling continues to move the scene.
 */
export function forwardWheelToExcalidrawCanvas(e: WheelLike) {
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
