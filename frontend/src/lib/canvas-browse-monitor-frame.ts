import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { CHAT_FRAME_WIDTH } from "@/lib/canvas-chat-frame";
import { getAiChatType } from "@/lib/excalidraw-custom-data";

/**
 * 「浏览器实时画面框」—— 每次触发 browse 的对话轮各一个原生 Excalidraw frame,
 * 摆在浏览日志框 (canvas-browse-log-frame) 的**右侧**。BrowseMonitorOverlay 把
 * 一张随 browser-use 每步刷新的截图锚在它上面 (复用 useFrameAnchoredPanel)。
 *
 * 直播期间画面走 SSE 的 browse_frame 帧 (JPEG data-URL, 存 React state);轮末最后
 * 一帧是后端落库的截图 media URL, 写进 customData 持久化 —— 刷新后仍能看到末态。
 */
export const BROWSE_MONITOR_FRAME_MARKER = "browse-monitor-frame";

/** customData 键:落库的「末态画面」media URL (直播帧只在 React state, 不入库)。 */
export const BROWSE_MONITOR_IMAGE_KEY = "browseMonitorImage";

/** 与聊天框 / 日志框同宽以对齐;16:9 (截图视口 1920×1080 的比例) 让画面铺满不留白。 */
export const BROWSE_MONITOR_FRAME_WIDTH = CHAT_FRAME_WIDTH;
export const BROWSE_MONITOR_FRAME_HEIGHT = Math.round((CHAT_FRAME_WIDTH * 9) / 16);

export function isBrowseMonitorFrame(el: ExcalidrawElement): boolean {
  return (
    !el.isDeleted && el.type === "frame" && getAiChatType(el) === BROWSE_MONITOR_FRAME_MARKER
  );
}

/** 当前 scene 的所有浏览器画面框 (按场景顺序)。 */
export function findBrowseMonitorFrames(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter(isBrowseMonitorFrame);
}

/** 读出一个画面框已持久化的末态画面 URL (customData),没有则空串。 */
export function getBrowseMonitorImage(el: ExcalidrawElement): string {
  const cd = (el.customData ?? {}) as Record<string, unknown>;
  const url = cd[BROWSE_MONITOR_IMAGE_KEY];
  return typeof url === "string" ? url : "";
}
