import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * 「浏览日志框」—— 每次触发 browse 工具的对话轮各一个原生 Excalidraw frame，
 * 摞在主聊天框 (canvas-chat-frame) 下方。BrowseLogOverlay 把一个可滚动的日志
 * 面板锚在它上面 (跟 ChatFrameOverlay 同一套「像图片一样随缩放」的投影手法)。
 *
 * 标记同样打在 customData.aiChatType 上 (跟 chat-frame / note-text 同字段)。
 * 标题 (browseTitle) = 触发这轮的用户消息；日志正文 (browseLog) 落进 customData
 * 以便随场景自动保存、刷新后仍在 —— 直播期间前端用 React state 渲染，settle 时
 * 把累计文本写回 customData 持久化 (见 canvex-workspace)。
 */
export const BROWSE_LOG_FRAME_MARKER = "browse-log-frame";

/** customData 键 —— 字符串读写两侧必须一致 (场景 autosave 回读同名键)。 */
export const BROWSE_LOG_TITLE_KEY = "browseTitle";
export const BROWSE_LOG_TEXT_KEY = "browseLog";

/** 与主聊天框同宽 (对齐视觉)，但矮一些 —— 日志是流水，面板自己滚动。 */
export const BROWSE_LOG_FRAME_WIDTH = 2048;
export const BROWSE_LOG_FRAME_HEIGHT = 1024;

function aiChatType(el: ExcalidrawElement): string | undefined {
  const cd = el.customData as { aiChatType?: unknown } | undefined;
  return typeof cd?.aiChatType === "string" ? cd.aiChatType : undefined;
}

export function isBrowseLogFrame(el: ExcalidrawElement): boolean {
  return (
    !el.isDeleted && el.type === "frame" && aiChatType(el) === BROWSE_LOG_FRAME_MARKER
  );
}

/** 当前 scene 的所有浏览日志框 (按场景顺序)。 */
export function findBrowseLogFrames(
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter(isBrowseLogFrame);
}

/** 从一个浏览日志框读出标题 + 已持久化的日志文本 (customData)。 */
export function getBrowseLogFrameData(el: ExcalidrawElement): {
  title: string;
  log: string;
} {
  const cd = (el.customData ?? {}) as Record<string, unknown>;
  const title = typeof cd[BROWSE_LOG_TITLE_KEY] === "string" ? (cd[BROWSE_LOG_TITLE_KEY] as string) : "";
  const log = typeof cd[BROWSE_LOG_TEXT_KEY] === "string" ? (cd[BROWSE_LOG_TEXT_KEY] as string) : "";
  return { title, log };
}
