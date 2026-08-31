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
> & {
  /** 用来判"这一下滚轮到底落在哪" —— 见下面的 portal 那段。两种事件都有。 */
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
};

/**
 * Wheel forwarder for any UI sitting above Excalidraw with
 * `pointer-events-auto` (toolbars, mockup gizmos, etc.). The interactive
 * canvas would otherwise lose pan/zoom whenever the cursor sat over the
 * overlay. Re-dispatch the wheel event on Excalidraw's own canvas so
 * scrolling continues to move the scene.
 *
 * **只转发真正落在挂 handler 那个元素里的滚轮。** React 的合成事件沿**组件树**
 * 冒泡而不是 DOM 树, 所以一个 portal 到 body 的后代 (Popover / Dialog 的内容)
 * 滚起来也会走到宿主的 onWheel。那不是"滚轮划过工具栏", 转发过去就成了"在弹层
 * 里滚列表, 底下画布跟着平移" —— 用户看到的是整个页面在动。
 *
 * 判定放在这里而不是各宿主里: 每加一个弹层都要记得 stopPropagation 是记不住的,
 * 而每个宿主的判定条件是同一句话。原生 addEventListener 那条路 DOM 冒泡不穿
 * portal, target 必在 currentTarget 里, 这一刀对它恒为真。
 */
export function forwardWheelToExcalidrawCanvas(e: WheelLike) {
  const { target, currentTarget } = e;
  if (currentTarget instanceof Node && target instanceof Node && !currentTarget.contains(target)) {
    return;
  }
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
